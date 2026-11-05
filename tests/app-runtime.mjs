// Run the app's pure code and direct API transport in Node, without booting a UI.
// Source sections are evaluated verbatim; prompts, schemas and validators are
// deliberately not copied into this harness or maintained as a second version.
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadAppRuntime({ fetchImpl = fetch } = {}) {
  const source = readFileSync(resolve(root, "app.html"), "utf8");
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    if (a < 0 || b < 0 || source.indexOf(start, a + start.length) !== -1) throw new Error(`App source marker missing or ambiguous: ${start}`);
    return source.slice(a, b);
  };
  const defaultSettings = source.match(/^  const DEFAULT_SETTINGS = .*;$/m)?.[0];
  if (!defaultSettings) throw new Error("Cannot locate app default settings");
  const code = [
    section("  // ---------- Helpers ----------", "  // ---------- Storage:"),
    defaultSettings,
    "const settings = { ...DEFAULT_SETTINGS };",
    section("  // ---------- Built-in demo:", '  // Malformed replies used by'),
    section("  class BridgeError extends Error", "  const friendly ="),
    section("  // Effort/thinking may consume", "  // The website's own server:"),
    section("  function parseLooseJSON(text)", "  // Ask for JSON, validate it"),
    section("  // ---------- Prompts ----------", "  // ---------- Sessions (evidence log) ----------"),
    `return {
      promptRecheck, schema: SCHEMA.recheck, validateRecheck, validateMCQ,
      parseLooseJSON, normTerm, callAnthropic, model: DEFAULT_SETTINGS.model,
      statisticsCase() {
        return {
          passage: STATS_EXAMPLE, courseLabel: "Intro statistics", homework: false,
          targets: STATS_DEMO.diagnostic.items.map((item, pi) => ({
            ...item, pi, ...STATS_DEMO.gaps.prerequisites.find((p) => p.term === item.term),
          })),
        };
      },
    };`,
  ].join("\n");
  const api = vm.runInNewContext(`(() => { "use strict"; ${code}\n})()`, {
    crypto: webcrypto, fetch: fetchImpl, AbortController, setTimeout, clearTimeout,
  }, { filename: "app.html (verbatim Node runtime)", timeout: 1000 });
  return { ...api, sourceSHA256: createHash("sha256").update(source).digest("hex") };
}
