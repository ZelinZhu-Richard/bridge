// A stand-in for the Anthropic Messages API. It records every request and returns canned replies.
// The reply depends on a marker in the prompt:
//   MOCK:OK (or no marker)  200 with a canned Messages response
//   MOCK:400ONCE            400 while the request uses `fallbacks`, then 200 without it
//   MOCK:400                400 every time
//   MOCK:401 / MOCK:403     an authentication / permission error
//   MOCK:429                429 with a retry-after header
// Run alone with `node test/mock-anthropic.mjs [port]`, or import startMock() from the test runner.
import http from "node:http";
import { pathToFileURL } from "node:url";

export function cannedMessage(text) {
  return {
    id: "msg_mock_0001",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 34 },
  };
}

const errorBody = (type, message) => ({ type: "error", error: { type, message } });

function reply(prompt, body) {
  const marker = (/MOCK:([A-Z0-9]+)/.exec(prompt) || [])[1] || "OK";
  switch (marker) {
    case "400ONCE":
      return body.fallbacks !== undefined
        ? { status: 400, body: errorBody("invalid_request_error", "mock: fallbacks are not enabled for this key") }
        : { status: 200, body: cannedMessage('{"lesson":"retried without fallbacks"}') };
    case "400":
      return { status: 400, body: errorBody("invalid_request_error", "mock: always 400") };
    case "401":
      return { status: 401, body: errorBody("authentication_error", "mock: invalid x-api-key") };
    case "403":
      return { status: 403, body: errorBody("permission_error", "mock: forbidden") };
    case "429":
      return { status: 429, body: errorBody("rate_limit_error", "mock: slow down"), headers: { "retry-after": "17" } };
    default:
      return { status: 200, body: cannedMessage('{"lesson":"mock lesson"}') };
  }
}

export function startMock(port = 0) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      const prompt = body?.messages?.[0]?.content ?? "";
      const out = req.method === "POST" && req.url === "/v1/messages" && body
        ? reply(typeof prompt === "string" ? prompt : "", body)
        : { status: 404, body: errorBody("not_found_error", "mock: unknown route") };
      const text = JSON.stringify(out.body);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, status: out.status, responseText: text });
      res.writeHead(out.status, { "content-type": "application/json", "request-id": `req_mock_${requests.length}`, ...(out.headers || {}) });
      res.end(text);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ port: server.address().port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMock(Number(process.argv[2]) || 8790);
  console.log(`mock Anthropic API on http://127.0.0.1:${mock.port}`);
}
