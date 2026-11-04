// Local end-to-end tests: starts a mock Anthropic API and `wrangler dev` (local mode), then
// checks the Worker's behavior over HTTP. Run with `npm test`. Uses a fake key only.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-anthropic.mjs";
import { SCHEMAS } from "../src/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_VARS = join(ROOT, ".dev.vars");
const STATE_DIR = join(ROOT, ".wrangler", "test-state");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const MARK = "# Written by test/run.mjs for local tests (fake key). Deleted after the run.";
const FAKE_KEY = "test-not-a-real-key";
const ALLOWED = "http://localhost:8765";
const PAGES = "https://zelinzhu-richard.github.io";
const EVIL = "https://evil.example";
const MODEL = "claude-sonnet-5-5";
const MAX_PROMPT = 12000;
const MAX_BODY = 64 * 1024;
const IP_LIMIT = 3;
const DAILY_LIMIT = 30;

// ---------- tiny harness ----------
const results = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
class AssertionError extends Error {}
function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new AssertionError(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
// Same schema with every object's keys in reverse order.
function reverseKeys(v) {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])]));
  return v;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// ---------- servers ----------
let mock;
let worker = null; // { base, child, output, persistTo }
const allResponses = []; // every response body the Worker sent, checked for the key at the end

function writeDevVars(lines) {
  if (existsSync(DEV_VARS) && !readFileSync(DEV_VARS, "utf8").startsWith(MARK)) {
    throw new Error(".dev.vars already exists and was not written by this test. Move it aside, then run npm test again.");
  }
  writeFileSync(DEV_VARS, [MARK, ...lines, ""].join("\n"));
}

function removeDevVars() {
  if (existsSync(DEV_VARS) && readFileSync(DEV_VARS, "utf8").startsWith(MARK)) rmSync(DEV_VARS);
}

async function startWorker(name, vars) {
  const port = await freePort();
  const inspectorPort = await freePort();
  const persistTo = join(STATE_DIR, `${name}-${process.pid}`);
  rmSync(persistTo, { recursive: true, force: true });
  const args = [
    WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort),
    "--persist-to", persistTo, "--show-interactive-dev-session=false",
    ...vars.flatMap((v) => ["--var", v]),
  ];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true, // own process group, so stopping it also stops workerd
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
  });
  const w = { base: `http://127.0.0.1:${port}`, child, output: "", persistTo, exited: false };
  child.stdout.on("data", (d) => { w.output += d; });
  child.stderr.on("data", (d) => { w.output += d; });
  child.on("exit", () => { w.exited = true; });
  worker = w;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (w.exited) break;
    try {
      const r = await fetch(`${w.base}/health`);
      if (r.status === 200) return w;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const out = w.output;
  await stopWorker();
  throw new Error(`wrangler dev did not start:\n${out}`);
}

async function stopWorker() {
  const w = worker;
  worker = null;
  if (!w) return;
  const kill = (sig) => { try { process.kill(-w.child.pid, sig); } catch { /* already gone */ } };
  if (!w.exited) {
    kill("SIGTERM");
    const deadline = Date.now() + 10000;
    while (!w.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }
  kill("SIGKILL"); // anything left in the process group (workerd)
  rmSync(w.persistTo, { recursive: true, force: true });
}

// ---------- request helpers ----------
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`; // TEST-NET-2: a new visitor for each call
let tagCounter = 0;
const newTag = () => `[t${++tagCounter}]`;
const upstreamFor = (tag) => mock.requests.filter((r) => typeof r.body?.messages?.[0]?.content === "string" && r.body.messages[0].content.includes(tag));
const countedTags = () => new Set(mock.requests.map((r) => (/\[t\d+\]/.exec(r.body?.messages?.[0]?.content || "") || [])[0]).filter(Boolean)).size;

async function call(method, path, { origin, ip, body, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (ip) h["cf-connecting-ip"] = ip;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = "half";
  }
  const res = await fetch(`${worker.base}${path}`, init);
  const text = await res.text();
  allResponses.push(text + JSON.stringify([...res.headers]));
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

function generate({ prompt, schema = SCHEMAS.lesson, origin = ALLOWED, ip = freshIp(), raw } = {}) {
  const body = raw !== undefined ? raw : JSON.stringify({ prompt, schema });
  return call("POST", "/v1/generate", { origin, ip, body, headers: { "content-type": "application/json" } });
}

function expectBridgeError(r, status, type) {
  eq(r.status, status, "status");
  assert(r.json && r.json.type === "error" && r.json.error && typeof r.json.error.message === "string" && r.json.error.message,
    `body should be {"type":"error","error":{"type","message"}}, got ${r.text.slice(0, 200)}`);
  eq(r.json.error.type, type, "error.type");
  eq(Object.keys(r.json).sort().join(","), "error,type", "top-level keys");
  eq(Object.keys(r.json.error).sort().join(","), "message,type", "error keys");
}

// ---------- tests: Worker with a (fake) key ----------
test("GET /health shows ok, model and configured, and no secrets", async () => {
  const r = await call("GET", "/health", { origin: ALLOWED });
  eq(r.status, 200, "status");
  eq(Object.keys(r.json).sort().join(","), "configured,model,ok", "keys");
  eq(r.json.ok, true, "ok");
  eq(r.json.model, MODEL, "model");
  eq(r.json.configured, true, "configured");
  eq(r.headers.get("access-control-allow-origin"), ALLOWED, "CORS origin");
  for (const secret of [FAKE_KEY, String(mock.port), "ANTHROPIC"]) assert(!r.text.includes(secret), `/health leaked ${secret}`);
  const plain = await call("GET", "/health");
  eq(plain.status, 200, "status without Origin");
  eq(plain.headers.get("access-control-allow-origin"), null, "no CORS header without Origin");
});

test("OPTIONS preflight from each allowed origin gets CORS headers", async () => {
  for (const origin of [ALLOWED, PAGES, "http://127.0.0.1:8765"]) {
    const r = await call("OPTIONS", "/v1/generate", {
      origin, headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    eq(r.status, 204, `${origin} status`);
    eq(r.headers.get("access-control-allow-origin"), origin, `${origin} allow-origin`);
    assert((r.headers.get("access-control-allow-methods") || "").includes("POST"), "allow-methods includes POST");
    assert((r.headers.get("access-control-allow-headers") || "").toLowerCase().includes("content-type"), "allow-headers includes content-type");
    assert((r.headers.get("vary") || "").includes("Origin"), "Vary: Origin");
  }
});

test("403 for a disallowed origin (preflight, POST, health) and for POST with no Origin", async () => {
  const pre = await call("OPTIONS", "/v1/generate", { origin: EVIL, headers: { "access-control-request-method": "POST" } });
  eq(pre.status, 403, "preflight status");
  eq(pre.headers.get("access-control-allow-origin"), null, "no CORS on refused preflight");
  const tag = newTag();
  const post = await generate({ prompt: `hello ${tag}`, origin: EVIL });
  expectBridgeError(post, 403, "bridge_origin_not_allowed");
  eq(post.headers.get("access-control-allow-origin"), null, "no CORS on refused POST");
  expectBridgeError(await call("GET", "/health", { origin: EVIL }), 403, "bridge_origin_not_allowed");
  expectBridgeError(await call("POST", "/v1/generate", { body: JSON.stringify({ prompt: `hi ${tag}`, schema: SCHEMAS.lesson }) }), 403, "bridge_origin_not_allowed");
  expectBridgeError(await generate({ prompt: `hi ${tag}`, origin: "null" }), 403, "bridge_origin_not_allowed");
  eq(upstreamFor(tag).length, 0, "upstream calls");
});

test("400 for an unknown or missing schema", async () => {
  const tag = newTag();
  const extra = structuredClone(SCHEMAS.lesson);
  extra.properties.secret_plan = { type: "string" };
  extra.required.push("secret_plan");
  const reordered = structuredClone(SCHEMAS.gaps);
  reordered.required.reverse(); // arrays keep their order, so this is a different schema
  for (const schema of [extra, reordered, { type: "object" }, null, "lesson", [SCHEMAS.lesson]]) {
    const r = await generate({ prompt: `hi ${tag}`, schema });
    expectBridgeError(r, 400, "bridge_unknown_schema");
    eq(r.headers.get("access-control-allow-origin"), ALLOWED, "CORS on error so the app can read it");
  }
  expectBridgeError(await generate({ raw: JSON.stringify({ prompt: `hi ${tag}` }) }), 400, "bridge_unknown_schema");
  eq(upstreamFor(tag).length, 0, "upstream calls");
});

test("400 for a body that isn't JSON or a prompt that isn't a non-empty string", async () => {
  expectBridgeError(await generate({ raw: "not json" }), 400, "bridge_bad_request");
  expectBridgeError(await generate({ raw: "[1,2]" }), 400, "bridge_bad_request");
  for (const prompt of ["", "   \n ", 42, null, ["a"]]) expectBridgeError(await generate({ prompt }), 400, "bridge_bad_prompt");
  eq(countedTags(), 0, "nothing reached upstream");
});

test("413 for an oversized prompt or body; a prompt at the cap is accepted", async () => {
  const tag = newTag();
  expectBridgeError(await generate({ prompt: `${tag}${"x".repeat(MAX_PROMPT)}` }), 413, "bridge_prompt_too_large");
  expectBridgeError(await generate({ prompt: `${tag}${"字".repeat(MAX_PROMPT)}` }), 413, "bridge_prompt_too_large");
  expectBridgeError(await generate({ raw: JSON.stringify({ prompt: tag, schema: SCHEMAS.lesson, pad: "x".repeat(MAX_BODY) }) }), 413, "bridge_body_too_large");
  // Same size again with no content-length (chunked), so the streaming limit is what stops it.
  const big = new TextEncoder().encode(JSON.stringify({ prompt: tag, schema: SCHEMAS.lesson, pad: "y".repeat(MAX_BODY) }));
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < big.length; i += 8192) c.enqueue(big.slice(i, i + 8192));
      c.close();
    },
  });
  const chunked = await call("POST", "/v1/generate", { origin: ALLOWED, ip: freshIp(), body: stream, headers: { "content-type": "application/json" } });
  expectBridgeError(chunked, 413, "bridge_body_too_large");
  eq(upstreamFor(tag).length, 0, "upstream calls for oversized requests");

  const atCap = newTag();
  const ok = await generate({ prompt: `${atCap}${"字".repeat(MAX_PROMPT - atCap.length)}` });
  eq(ok.status, 200, "prompt of exactly the cap");
  eq(upstreamFor(atCap).length, 1, "upstream calls at the cap");
});

test("happy path: mock reply passes through; upstream saw key, version, beta, model, schema", async () => {
  const tag = newTag();
  const prompt = `Find the gaps ${tag}`;
  const r = await generate({ prompt, schema: SCHEMAS.gaps });
  eq(r.status, 200, "status");
  const ups = upstreamFor(tag);
  eq(ups.length, 1, "upstream calls");
  const u = ups[0];
  eq(r.text, u.responseText, "body passed through byte for byte");
  eq(r.headers.get("content-type"), "application/json", "content-type");
  eq(r.headers.get("access-control-allow-origin"), ALLOWED, "CORS origin");
  eq(r.headers.get("request-id"), `req_mock_${mock.requests.indexOf(u) + 1}`, "request-id passed through");
  eq(u.method, "POST", "method");
  eq(u.url, "/v1/messages", "path");
  eq(u.headers["x-api-key"], FAKE_KEY, "x-api-key");
  eq(u.headers["anthropic-version"], "2026-10-21", "anthropic-version");
  eq(u.headers["anthropic-beta"], "server-side-fallback-2026-07-01", "anthropic-beta");
  assert((u.headers["content-type"] || "").startsWith("application/json"), "content-type to upstream");
  assert(!("anthropic-dangerous-direct-browser-access" in u.headers), "no browser-access header");
  assert(!("origin" in u.headers) && !("cf-connecting-ip" in u.headers), "visitor's Origin and IP not forwarded");
  const b = u.body;
  eq(Object.keys(b).sort().join(","), "fallbacks,max_tokens,messages,model,output_config", "body keys");
  eq(b.model, MODEL, "model");
  eq(b.max_tokens, 8000, "max_tokens");
  eq(JSON.stringify(b.messages), JSON.stringify([{ role: "user", content: prompt }]), "messages");
  eq(b.output_config.effort, "medium", "effort");
  eq(b.output_config.format.type, "json_schema", "format type");
  eq(canonical(b.output_config.format.schema), canonical(SCHEMAS.gaps), "schema");
  eq(b.fallbacks, "default", "fallbacks");
});

test("schema match ignores object key order", async () => {
  const tag = newTag();
  const r = await generate({ prompt: `Diagnose ${tag}`, schema: reverseKeys(SCHEMAS.diagnostic) });
  eq(r.status, 200, "status");
  const ups = upstreamFor(tag);
  eq(ups.length, 1, "upstream calls");
  eq(canonical(ups[0].body.output_config.format.schema), canonical(SCHEMAS.diagnostic), "schema sent upstream");
});

test("every app schema, including the immediate recheck, is accepted with its token cap", async () => {
  eq(Object.keys(SCHEMAS).sort().join(","), "bridge,diagnostic,gaps,lesson,minicheck,recheck", "registered tasks");
  for (const [task, schema] of Object.entries(SCHEMAS)) {
    const tag = newTag();
    eq((await generate({ prompt: `${task} ${tag}`, schema })).status, 200, `${task} accepted`);
    const upstream = upstreamFor(tag);
    eq(upstream.length, 1, `${task} calls`);
    eq(upstream[0].body.max_tokens, 8000, `${task} cap`);
    eq(canonical(upstream[0].body.output_config.format.schema), canonical(schema), `${task} schema`);
  }
});

test("an upstream 400 triggers exactly one retry without fallbacks or beta, keeping the schema", async () => {
  const tag = newTag();
  const r = await generate({ prompt: `MOCK:400ONCE ${tag}`, schema: SCHEMAS.bridge });
  eq(r.status, 200, "status after retry");
  const ups = upstreamFor(tag);
  eq(ups.length, 2, "upstream calls");
  const [first, second] = ups;
  eq(first.body.fallbacks, "default", "first call fallbacks");
  eq(first.headers["anthropic-beta"], "server-side-fallback-2026-07-01", "first call beta");
  assert(!("fallbacks" in second.body), "retry has no fallbacks");
  assert(!("anthropic-beta" in second.headers), "retry has no anthropic-beta header");
  eq(second.headers["x-api-key"], FAKE_KEY, "retry x-api-key");
  eq(second.headers["anthropic-version"], "2026-10-21", "retry anthropic-version");
  eq(second.body.model, MODEL, "retry model");
  eq(second.body.max_tokens, 8000, "retry max_tokens");
  eq(second.body.output_config.effort, "medium", "retry effort");
  eq(second.body.output_config.format.type, "json_schema", "retry format type");
  eq(canonical(second.body.output_config.format.schema), canonical(SCHEMAS.bridge), "retry keeps the schema");
  eq(JSON.stringify(second.body.messages), JSON.stringify(first.body.messages), "retry messages");
  eq(r.text, second.responseText, "retry's body passed through");
});

test("a 400 on the retry too is passed through, with no third call", async () => {
  const tag = newTag();
  const r = await generate({ prompt: `MOCK:400 ${tag}` });
  eq(r.status, 400, "status");
  const ups = upstreamFor(tag);
  eq(ups.length, 2, "upstream calls");
  eq(r.text, ups[1].responseText, "upstream error body passed through");
  eq(r.headers.get("access-control-allow-origin"), ALLOWED, "CORS origin");
});

test("upstream 401/403 become 502 bridge_upstream_auth, with no retry", async () => {
  for (const code of ["401", "403"]) {
    const tag = newTag();
    const r = await generate({ prompt: `MOCK:${code} ${tag}` });
    expectBridgeError(r, 502, "bridge_upstream_auth");
    eq(r.json.error.message, "The site's AI key isn't working.", "message");
    eq(upstreamFor(tag).length, 1, `upstream calls for ${code}`);
    assert(!r.text.includes("mock:"), "upstream error text not exposed");
  }
});

test("upstream 429 passes through with its retry-after", async () => {
  const tag = newTag();
  const r = await generate({ prompt: `MOCK:429 ${tag}` });
  eq(r.status, 429, "status");
  eq(r.headers.get("retry-after"), "17", "retry-after");
  eq(r.text, upstreamFor(tag)[0].responseText, "body");
  eq(r.json.error.type, "rate_limit_error", "upstream error type kept");
});

test(`per-IP hourly limit (${IP_LIMIT}) returns 429 bridge_rate_limit with Retry-After`, async () => {
  const ip = freshIp();
  for (let i = 0; i < IP_LIMIT; i++) eq((await generate({ prompt: `ip ${newTag()}`, ip })).status, 200, `request ${i + 1}`);
  const tag = newTag();
  const r = await generate({ prompt: `ip ${tag}`, ip });
  expectBridgeError(r, 429, "bridge_rate_limit");
  const wait = Number(r.headers.get("retry-after"));
  assert(Number.isInteger(wait) && wait >= 1 && wait <= 3600, `Retry-After should be 1-3600 seconds, got ${r.headers.get("retry-after")}`);
  eq(r.headers.get("access-control-allow-origin"), ALLOWED, "CORS so the app can read the 429");
  assert((r.headers.get("access-control-expose-headers") || "").includes("retry-after"), "Retry-After exposed to the app");
  eq(upstreamFor(tag).length, 0, "blocked request never reached upstream");
  eq((await generate({ prompt: `other ip ${newTag()}` })).status, 200, "another IP still allowed");
});

test("IPv6 visitors are counted per /64", async () => {
  for (let i = 1; i <= IP_LIMIT; i++) eq((await generate({ prompt: `v6 ${newTag()}`, ip: `2001:db8:aa:bb::${i}` })).status, 200, `v6 request ${i}`);
  expectBridgeError(await generate({ prompt: `v6 ${newTag()}`, ip: "2001:0db8:00aa:00bb:1:2:3:4" }), 429, "bridge_rate_limit");
  eq((await generate({ prompt: `v6 ${newTag()}`, ip: "2001:db8:aa:bc::1" })).status, 200, "a different /64 is allowed");
});

test(`daily limit (${DAILY_LIMIT}) returns 429 bridge_daily_limit with Retry-After`, async () => {
  const used = countedTags();
  assert(used < DAILY_LIMIT, `earlier tests used ${used} of ${DAILY_LIMIT}; raise DAILY_LIMIT`);
  for (let i = used; i < DAILY_LIMIT; i++) eq((await generate({ prompt: `day ${newTag()}` })).status, 200, `request ${i + 1} of the day`);
  const tag = newTag();
  const r = await generate({ prompt: `day ${tag}` });
  expectBridgeError(r, 429, "bridge_daily_limit");
  const wait = Number(r.headers.get("retry-after"));
  assert(Number.isInteger(wait) && wait >= 1 && wait <= 86400, `Retry-After should be 1-86400 seconds, got ${r.headers.get("retry-after")}`);
  eq(upstreamFor(tag).length, 0, "blocked request never reached upstream");
  eq(countedTags(), DAILY_LIMIT, "requests that reached upstream today");
});

test("unknown paths and wrong methods get bridge errors", async () => {
  expectBridgeError(await call("GET", "/nope", { origin: ALLOWED }), 404, "bridge_not_found");
  expectBridgeError(await call("GET", "/v1/generate", { origin: ALLOWED }), 405, "bridge_method_not_allowed");
  expectBridgeError(await call("POST", "/health", { origin: ALLOWED, body: "{}" }), 405, "bridge_method_not_allowed");
});

// ---------- tests: Worker without a key ----------
const unconfigured = [];
unconfigured.push(["without the key secret: /health says configured:false and generate returns 503", async () => {
  const h = await call("GET", "/health", { origin: ALLOWED });
  eq(h.status, 200, "health status");
  eq(h.json.configured, false, "configured");
  const tag = newTag();
  expectBridgeError(await generate({ prompt: `hi ${tag}` }), 503, "bridge_not_configured");
  eq(upstreamFor(tag).length, 0, "upstream calls");
}]);

test("no response ever contained the API key", async () => {
  for (const t of allResponses) assert(!t.includes(FAKE_KEY), "a response contained the key");
});

async function runAll(list) {
  for (const { name, fn } of list) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  PASS  ${name}`);
    } catch (e) {
      results.push({ name, ok: false, error: e });
      console.log(`  FAIL  ${name}\n        ${e instanceof AssertionError ? e.message : e.stack}`);
    }
  }
}

let exitCode = 0;
const onSignal = async () => { await stopWorker(); removeDevVars(); process.exit(130); };
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
try {
  mock = await startMock(0);
  const apiUrl = `http://127.0.0.1:${mock.port}`;

  writeDevVars([`ANTHROPIC_API_KEY=${FAKE_KEY}`, `ANTHROPIC_API_URL=${apiUrl}`]);
  console.log(`Worker with a fake key (IP_HOURLY_LIMIT=${IP_LIMIT}, DAILY_LIMIT=${DAILY_LIMIT}); mock API on ${apiUrl}`);
  await startWorker("configured", [`IP_HOURLY_LIMIT:${IP_LIMIT}`, `DAILY_LIMIT:${DAILY_LIMIT}`]);
  const last = tests.pop(); // the key scan runs after the unconfigured instance too
  await runAll(tests);
  await stopWorker();

  writeDevVars([`ANTHROPIC_API_URL=${apiUrl}`]);
  console.log("Worker without ANTHROPIC_API_KEY");
  await startWorker("unconfigured", []);
  await runAll(unconfigured.map(([name, fn]) => ({ name, fn })));
  await stopWorker();
  await runAll([last]);
} catch (e) {
  console.error(e.message || e);
  exitCode = 1;
} finally {
  await stopWorker();
  removeDevVars();
  rmSync(STATE_DIR, { recursive: true, force: true });
  if (mock) await mock.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed || exitCode ? 1 : 0);
