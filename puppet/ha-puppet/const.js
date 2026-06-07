import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// load first file that exists
const optionsFile = ["./options-dev.json", "/data/options.json"].find(
  existsSync,
);
if (!optionsFile) {
  console.error(
    "No options file found. Please copy options-dev.json.sample to options-dev.json",
  );
  process.exit(1);
}
export const isAddOn = optionsFile === "/data/options.json";
const options = JSON.parse(readFileSync(optionsFile));

export const hassUrl = isAddOn
  ? (options.home_assistant_url || "http://homeassistant:8123")
  : (options.home_assistant_url || "http://localhost:8123");
export const hassToken = options.access_token;
export const debug = false;

export const chromiumExecutable = isAddOn ? "/usr/bin/chromium" : (options.chromium_executable || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

export const keepBrowserOpen = options.keep_browser_open || false;
export const allowInsecureHomeAssistantSsl =
  options.allow_insecure_home_assistant_ssl || false;
export const trustedRootCaFile = options.trusted_root_ca_file
  ? isAddOn
    ? join("/ssl", options.trusted_root_ca_file.replace(/^[/\\]+/, ""))
    : options.trusted_root_ca_file
  : undefined;
export const trustedRootCa = trustedRootCaFile
  ? readConfiguredFile(trustedRootCaFile, "trusted root CA file")
  : undefined;
export const serverSsl = options.ssl || false;
export const serverCertfile = isAddOn
  ? join("/ssl", (options.certfile || "fullchain.pem").replace(/^[/\\]+/, ""))
  : options.certfile;
export const serverKeyfile = isAddOn
  ? join("/ssl", (options.keyfile || "privkey.pem").replace(/^[/\\]+/, ""))
  : options.keyfile;

function readConfiguredFile(path, description) {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(
      `The configured ${description} could not be read at ${path}: ${err.message}`,
    );
  }
}

if (trustedRootCa) {
  console.info(`Loaded trusted root CA from ${trustedRootCaFile}`);
}
if (trustedRootCa && allowInsecureHomeAssistantSsl) {
  console.warn(
    "Both trusted_root_ca_file and allow_insecure_home_assistant_ssl are configured; insecure mode bypasses certificate validation.",
  );
}

if (!hassToken) {
  console.warn("No access token configured. UI will show configuration instructions.");
}
