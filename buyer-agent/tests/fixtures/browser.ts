import { createRequire } from "node:module";
import { join } from "node:path";
// Use a locally installed Playwright or the desktop's bundled package directory.
// No authenticated user browser profile is attached.
export async function launchBrowser() {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.SETRA_BROWSER_PACKAGE_DIR
    ? join(process.env.SETRA_BROWSER_PACKAGE_DIR, "playwright")
    : "playwright");
  return chromium.launch({ headless: true, channel: "chrome" });
}
