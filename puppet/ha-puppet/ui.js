import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import NodeWebSocket from "ws";
import {
  createConnection,
  createLongLivedTokenAuth,
  createSocket,
} from "home-assistant-js-websocket";
import {
  allowInsecureHomeAssistantSsl,
  hassUrl,
  hassToken,
  isAddOn,
  serverSsl,
  trustedRootCa,
} from "./const.js";
import { loadDevicesConfig } from "./devices.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function describeError(err) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause ? describeError(err.cause) : undefined,
    };
  }

  return {
    type: typeof err,
    value: err,
  };
}

function describeWebSocketEvent(event) {
  return {
    type: event.type,
    code: "code" in event ? event.code : undefined,
    reason: "reason" in event ? event.reason : undefined,
    wasClean: "wasClean" in event ? event.wasClean : undefined,
    message: "message" in event ? event.message : undefined,
    error: "error" in event ? describeError(event.error) : undefined,
  };
}

async function createDiagnosticSocket(options) {
  const wsUrl = options.auth?.wsUrl;
  console.info(`Opening Home Assistant websocket: ${wsUrl}`);
  if (allowInsecureHomeAssistantSsl) {
    console.warn(
      `Allowing insecure TLS for Home Assistant websocket ${wsUrl}`,
    );
  } else if (trustedRootCa) {
    console.info(`Using trusted root CA for Home Assistant websocket ${wsUrl}`);
  }

  const OriginalWebSocket = globalThis.WebSocket;
  const BaseWebSocket = allowInsecureHomeAssistantSsl || trustedRootCa
    ? NodeWebSocket
    : OriginalWebSocket;

  class DiagnosticWebSocket extends BaseWebSocket {
    constructor(url, protocols) {
      if (allowInsecureHomeAssistantSsl) {
        super(url, protocols, { rejectUnauthorized: false });
      } else if (trustedRootCa) {
        super(url, protocols, { ca: trustedRootCa });
      } else {
        super(url, protocols);
      }
      this.addEventListener("error", (event) => {
        console.error(
          `Home Assistant websocket error for ${url}:`,
          describeWebSocketEvent(event),
        );
      });
      this.addEventListener("close", (event) => {
        console.info(
          `Home Assistant websocket closed for ${url}:`,
          describeWebSocketEvent(event),
        );
      });
    }
  }

  globalThis.WebSocket = DiagnosticWebSocket;
  try {
    return await createSocket(options);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
}

function fetchJsonWithCustomTls(url, options, tlsOptions) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.request(
      parsedUrl,
      {
        method: options.method || "GET",
        headers: options.headers,
        ...tlsOptions,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function fetchHomeAssistantConfig(configUrl, token) {
  const options = {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  if (
    (allowInsecureHomeAssistantSsl || trustedRootCa) &&
    new URL(configUrl).protocol === "https:"
  ) {
    if (allowInsecureHomeAssistantSsl) {
      console.warn(`Allowing insecure TLS for Home Assistant REST ${configUrl}`);
      return fetchJsonWithCustomTls(configUrl, options, {
        rejectUnauthorized: false,
      });
    }
    console.info(`Using trusted root CA for Home Assistant REST ${configUrl}`);
    return fetchJsonWithCustomTls(configUrl, options, { ca: trustedRootCa });
  }

  return fetch(configUrl, options);
}

async function runFetchStep(step, action) {
  console.info(`Fetching Home Assistant data: ${step}`);
  try {
    return await action();
  } catch (err) {
    console.error(
      `Error fetching Home Assistant data during ${step}:`,
      describeError(err),
    );
    throw err;
  }
}

/**
 * Fetch Home Assistant data via WebSocket and REST API
 * @returns {Promise<Object>} The Home Assistant data
 */
async function fetchHomeAssistantData(token) {
  let connection;
  try {
    const auth = await runFetchStep("creating long-lived token auth", () =>
      createLongLivedTokenAuth(hassUrl, token),
    );
    connection = await runFetchStep("opening websocket connection", () =>
      createConnection({ auth, createSocket: createDiagnosticSocket }),
    );

    // Fetch themes and network URLs via WebSocket
    const [themesResult, networkResult] = await Promise.all([
      runFetchStep("fetching frontend themes", () =>
        connection.sendMessagePromise({
          type: "frontend/get_themes",
        }),
      ),
      runFetchStep("fetching network URLs", () =>
        connection.sendMessagePromise({
          type: "network/url",
        }),
      ),
    ]);

    await runFetchStep("closing websocket connection", () => connection.close());
    connection = undefined;

    // Fetch config via REST API to get language
    const configUrl = `${hassUrl}/api/config`;
    const configResponse = await runFetchStep("fetching REST config", () =>
      fetchHomeAssistantConfig(configUrl, token),
    );
    console.info(
      `Fetching Home Assistant data: REST config responded ${configResponse.status} ${configResponse.statusText}`,
    );

    const config = configResponse.ok ? await configResponse.json() : null;

    return {
      themes: themesResult,
      network: networkResult,
      config: config,
    };
  } catch (err) {
    console.error("Error fetching Home Assistant data:", describeError(err));
    return {
      themes: null,
      network: null,
      config: null,
    };
  } finally {
    if (connection) {
      try {
        connection.close();
      } catch (err) {
        console.error(
          "Error closing Home Assistant websocket after fetch failure:",
          describeError(err),
        );
      }
    }
  }
}

/**
 * Handle UI page request
 * @param {http.ServerResponse} response - The HTTP response object
 */
export async function handleUIRequest(
  response,
  token = hassToken,
  { tokenSource = "configured" } = {},
) {
  try {
    // If no token is configured, show instruction page
    if (!token) {
      const htmlPath = join(__dirname, "html", "error_missing_config.html");
      let html = await readFile(htmlPath, "utf-8");

      // Replace placeholders
      const configFile = isAddOn ? "/data/options.json" : "options-dev.json";
      const configInstructions = isAddOn ? `
              <li>
                <strong>Configure the Add-on:</strong>
                <ul class="ml-6 mt-2 space-y-1 list-disc list-inside text-sm">
                  <li>Go to Settings → Add-ons</li>
                  <li>Click on the Puppet add-on</li>
                  <li>Go to the Configuration tab</li>
                  <li>Paste your token in the "access_token" field</li>
                  <li>Save and restart the add-on</li>
                </ul>
              </li>
              ` : `
              <li>
                <strong>Add to Configuration File:</strong>
                <ul class="ml-6 mt-2 space-y-1 list-disc list-inside text-sm">
                  <li>Open the file: <code class="bg-gray-100 px-2 py-1 rounded">${configFile}</code></li>
                  <li>Add or update the <code class="bg-gray-100 px-2 py-1 rounded">access_token</code> field with your token</li>
                  <li>Save the file and restart the service</li>
                </ul>
              </li>
              `;

      html = html.replace("{{CONFIG_INSTRUCTIONS}}", configInstructions);
      html = html.replace("{{HASS_URL}}", hassUrl);

      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(html),
      });
      response.end(html);
      return;
    }

    // Normal UI flow with token
    // Fetch Home Assistant data and load device configurations
    const hassData = await fetchHomeAssistantData(token);
    const devicesData = loadDevicesConfig();

    // Check if we failed to connect to Home Assistant
    if (!hassData.themes || !hassData.network || !hassData.config) {
      const htmlPath = join(__dirname, "html", "error_connection_failed.html");
      let html = await readFile(htmlPath, "utf-8");

      // Replace placeholders
      const configFile = isAddOn ? "/data/options.json" : "options-dev.json";
      const configInstructions = isAddOn ? `
              <li>
                <strong>Update the Add-on Configuration:</strong>
                <ul class="ml-6 mt-2 space-y-1 list-disc list-inside text-sm">
                  <li>Go to Settings → Add-ons</li>
                  <li>Click on the Puppet add-on</li>
                  <li>Go to the Configuration tab</li>
                  <li>Update the "access_token" field with the new token</li>
                  <li>Save and restart the add-on</li>
                </ul>
              </li>
              ` : `
              <li>
                <strong>Update Configuration File:</strong>
                <ul class="ml-6 mt-2 space-y-1 list-disc list-inside text-sm">
                  <li>Open the file: <code class="bg-gray-100 px-2 py-1 rounded">${configFile}</code></li>
                  <li>Update the <code class="bg-gray-100 px-2 py-1 rounded">access_token</code> field with the new token</li>
                  <li>Save the file and restart the service</li>
                </ul>
              </li>
              `;

      html = html.replace("{{CONFIG_INSTRUCTIONS}}", configInstructions);
      html = html.replace(/{{HASS_URL}}/g, hassUrl);
      html = html.replace(
        "{{TOKEN_STATUS}}",
        tokenSource === "request"
          ? "Provided with this request"
          : "Configured in add-on options",
      );

      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(html),
      });
      response.end(html);
      return;
    }

    // Successfully fetched data, serve normal UI
    const htmlPath = join(__dirname, "html", "index.html");
    let html = await readFile(htmlPath, "utf-8");

    // Inject window.hass and window.devices data into the HTML (pretty formatted)
    const hassScriptTag = `<script>window.hass = ${JSON.stringify(hassData, null, 2)};</script>`;
    const devicesScriptTag = `<script>window.devices = ${JSON.stringify(devicesData, null, 2)};</script>`;
    const puppetScriptTag = `<script>window.puppet = ${JSON.stringify({ ssl: serverSsl }, null, 2)};</script>`;
    html = html.replace(
      "</head>",
      `${hassScriptTag}\n  ${devicesScriptTag}\n  ${puppetScriptTag}\n  </head>`,
    );

    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Length": Buffer.byteLength(html),
    });
    response.end(html);
  } catch (err) {
    console.error("Error serving UI:", describeError(err));
    response.statusCode = 500;
    response.end("Error loading UI");
  }
}
