// bridge-ai: lets the Bridge static site call Claude with the site owner's API key.
// The key stays in a Worker secret (ANTHROPIC_API_KEY) and never reaches the browser.
// This Worker never logs prompts, replies, keys or IP addresses.
import { DurableObject } from "cloudflare:workers";
import { SCHEMAS } from "./schemas.js";

const MAX_BODY_BYTES = 64 * 1024;
// Largest real prompt: a 4,000-character passage plus about 3,800 characters of instructions
// (a 5-item diagnostic) plus about 200 for a retry, so about 8,000. 12,000 leaves headroom.
const MAX_PROMPT_CHARS = 12000;
const MAX_TOKENS = 16000;
const ANTHROPIC_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_API_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-opus-5-5";
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// ---------- Schemas: only the app's own five are accepted ----------
// Canonical JSON: object keys sorted at every level, arrays kept in order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const SCHEMA_BY_CANONICAL = new Map(Object.values(SCHEMAS).map((s) => [canonical(s), s]));

function knownSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  try {
    return SCHEMA_BY_CANONICAL.get(canonical(schema)) || null;
  } catch {
    return null; // for example, nesting too deep to walk
  }
}

// ---------- Responses ----------
function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean));
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers": "retry-after, request-id",
    "access-control-max-age": "86400",
  };
}

function respond(status, body, cors = {}, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...cors, ...(body === null ? {} : { "content-type": "application/json" }), "cache-control": "no-store", vary: "Origin", ...extra },
  });
}

function bridgeError(status, type, message, cors = {}, extra = {}) {
  return respond(status, { type: "error", error: { type, message } }, cors, extra);
}

// ---------- Request body ----------
// Returns the body as text, or null when it is larger than `limit` bytes. Throws on invalid UTF-8.
async function readBodyLimited(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// ---------- Rate limits ----------
const toLimit = (v, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

// IPv6 clients are counted per /64, since one connection usually owns a whole /64.
function ipBucket(ip) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? null : tail ? tail.split(":") : [];
  const groups = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// SHA-256 of IP bucket + UTC day, truncated: the raw IP is never stored, and keys change every day.
async function ipKey(ip, day) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ipBucket(ip)}|${day}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One global instance (idFromName("global")) counts requests in SQLite.
export class Limiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ip_hits (k TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, hour));
      CREATE TABLE IF NOT EXISTS day_hits (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
    this.hour = null;
  }

  // Counts one request if it is under both limits. Returns { ok: true } or { ok: false, limit: "daily" | "ip" }.
  // All SQL here is synchronous, so concurrent calls can't interleave between the check and the increment.
  hit(key, day, hour, ipHourlyLimit, dailyLimit) {
    if (this.hour !== hour) {
      // Clear finished hours and days (IP keys from an earlier day go with them).
      this.sql.exec("DELETE FROM ip_hits WHERE hour < ? OR day < ?", hour, day);
      this.sql.exec("DELETE FROM day_hits WHERE day < ?", day);
      if (this.hour === null || hour > this.hour) this.hour = hour;
    }
    const dayRow = this.sql.exec("SELECT n FROM day_hits WHERE day = ?", day).toArray()[0];
    if ((dayRow ? dayRow.n : 0) >= dailyLimit) return { ok: false, limit: "daily" };
    const ipRow = this.sql.exec("SELECT n FROM ip_hits WHERE k = ? AND hour = ?", key, hour).toArray()[0];
    if ((ipRow ? ipRow.n : 0) >= ipHourlyLimit) return { ok: false, limit: "ip" };
    this.sql.exec("INSERT INTO day_hits (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1", day);
    this.sql.exec(
      "INSERT INTO ip_hits (k, day, hour, n) VALUES (?, ?, ?, 1) ON CONFLICT (k, hour) DO UPDATE SET n = n + 1",
      key, day, hour,
    );
    return { ok: true };
  }
}

// Returns null when the request may go ahead, or a 429 Response.
async function checkLimits(request, env, cors) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const hour = Math.floor(now / HOUR_MS);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = await ipKey(ip, day);
  const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
  const r = await stub.hit(key, day, hour, toLimit(env.IP_HOURLY_LIMIT, 60), toLimit(env.DAILY_LIMIT, 400));
  if (r.ok) return null;
  if (r.limit === "daily") {
    const wait = Math.max(1, Math.ceil(((Math.floor(now / DAY_MS) + 1) * DAY_MS - now) / 1000));
    return bridgeError(429, "bridge_daily_limit", "Bridge has used today's AI allowance for this site. Try again tomorrow (UTC), or use Try demo.", cors, { "retry-after": String(wait) });
  }
  const wait = Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - now) / 1000));
  return bridgeError(429, "bridge_rate_limit", "Too many AI requests from your network this hour. Wait a while, then try again.", cors, { "retry-after": String(wait) });
}

// ---------- Upstream ----------
function callAnthropic(env, prompt, schema, withFallbacks) {
  const headers = {
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  const body = {
    model: env.MODEL || DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
  };
  if (withFallbacks) {
    // Server-side fallback: if a safety classifier declines, the API reruns the request on a fallback model.
    headers["anthropic-beta"] = FALLBACK_BETA;
    body.fallbacks = "default";
  }
  const base = String(env.ANTHROPIC_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  return fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function generate(request, env, cors) {
  let text;
  try {
    text = await readBodyLimited(request, MAX_BODY_BYTES);
  } catch {
    return bridgeError(400, "bridge_bad_request", "The request body could not be read.", cors);
  }
  if (text === null) return bridgeError(413, "bridge_body_too_large", `The request is larger than ${MAX_BODY_BYTES / 1024} KB.`, cors);
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return bridgeError(400, "bridge_bad_request", "The request body must be JSON: {\"prompt\": \"...\", \"schema\": {...}}.", cors);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return bridgeError(400, "bridge_bad_request", "The request body must be a JSON object with \"prompt\" and \"schema\".", cors);
  }
  const { prompt } = input;
  if (typeof prompt !== "string" || !prompt.trim()) return bridgeError(400, "bridge_bad_prompt", "\"prompt\" must be a non-empty string.", cors);
  if (prompt.length > MAX_PROMPT_CHARS) {
    return bridgeError(413, "bridge_prompt_too_large", `The prompt is longer than ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters. Paste a shorter section.`, cors);
  }
  const schema = knownSchema(input.schema);
  if (!schema) return bridgeError(400, "bridge_unknown_schema", "\"schema\" must be one of the Bridge app's own schemas.", cors);
  if (!env.ANTHROPIC_API_KEY) return bridgeError(503, "bridge_not_configured", "The site's AI isn't set up yet.", cors);

  let limited;
  try {
    limited = await checkLimits(request, env, cors);
  } catch {
    // Fail closed: without the limiter there is no spending cap.
    return bridgeError(503, "bridge_unavailable", "Bridge's AI service is busy. Try again in a moment.", cors);
  }
  if (limited) return limited;

  let upstream;
  try {
    upstream = await callAnthropic(env, prompt, schema, true);
    if (upstream.status === 400) {
      // The beta (fallbacks) may not be enabled for this key: retry once without it, keeping the schema.
      await upstream.body?.cancel().catch(() => {});
      upstream = await callAnthropic(env, prompt, schema, false);
    }
  } catch {
    return bridgeError(502, "bridge_upstream_unreachable", "Bridge couldn't reach the AI service. Try again.", cors);
  }
  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel().catch(() => {});
    console.error(`bridge-ai: upstream rejected the API key (status ${upstream.status})`);
    return bridgeError(502, "bridge_upstream_auth", "The site's AI key isn't working.", cors);
  }
  if (upstream.status < 200 || upstream.status > 599) {
    await upstream.body?.cancel().catch(() => {});
    return bridgeError(502, "bridge_upstream_error", "The AI service sent an unexpected reply. Try again.", cors);
  }
  // Pass the reply straight through without parsing it (free-plan CPU is 10 ms per request).
  const extra = {};
  for (const h of ["retry-after", "request-id"]) {
    const v = upstream.headers.get(h);
    if (v) extra[h] = v;
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...cors, "content-type": "application/json", "cache-control": "no-store", vary: "Origin", ...extra },
  });
}

// ---------- Router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowed = origin !== null && allowedOrigins(env).has(origin);
    const cors = allowed ? corsHeaders(origin) : {};

    // Any browser page on another origin is refused outright, preflight included.
    if (origin !== null && !allowed) return bridgeError(403, "bridge_origin_not_allowed", "This site isn't allowed to use Bridge's AI.");
    if (request.method === "OPTIONS") {
      if (!allowed) return bridgeError(403, "bridge_origin_not_allowed", "This site isn't allowed to use Bridge's AI.");
      return respond(204, null, cors);
    }

    if (url.pathname === "/health") {
      if (request.method !== "GET") return bridgeError(405, "bridge_method_not_allowed", "Use GET.", cors, { allow: "GET, OPTIONS" });
      return respond(200, { ok: true, model: env.MODEL || DEFAULT_MODEL, configured: Boolean(env.ANTHROPIC_API_KEY) }, cors);
    }

    if (url.pathname === "/v1/generate") {
      if (request.method !== "POST") return bridgeError(405, "bridge_method_not_allowed", "Use POST.", cors, { allow: "POST, OPTIONS" });
      // Requests with no Origin (scripts, curl) are refused too; only the allowed sites may spend the key.
      if (!allowed) return bridgeError(403, "bridge_origin_not_allowed", "This site isn't allowed to use Bridge's AI.");
      return generate(request, env, cors);
    }

    return bridgeError(404, "bridge_not_found", "Not found. Use GET /health or POST /v1/generate.", cors);
  },
};
