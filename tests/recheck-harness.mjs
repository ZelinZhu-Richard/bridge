// Independent direct-API generations using app.html's actual transport,
// prompt, schema, parser and validator. Raw data is local-only under .debug/.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadAppRuntime, root } from "./app-runtime.mjs";

const args = process.argv.slice(2);
const allowed = new Set(["--dry-run", "--expect-valid", "--label", "--runs"]);
let label = "baseline", runs = 5;
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] === "--label") {
    label = args[++i] || "";
    if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error("Label must contain only lowercase letters, numbers and hyphens");
  }
  else if (args[i] === "--runs") {
    const value = args[++i] || "";
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error("Runs must be an integer from 1 to 100");
    runs = Number(value);
  }
}
const dryRun = args.includes("--dry-run"), expectValid = args.includes("--expect-valid");
let key = "";
const redact = (s) => key ? String(s).replaceAll(key, "[REDACTED]") : String(s);
const normalize = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, " ").trim();
let currentRequests = [];
const record = { label, requested_generations: runs, started_at: new Date().toISOString(), note: "Developer QA on the built-in statistics text. Not student data; never used by student exports.", generations: [] };
const output = resolve(root, ".debug", `recheck-${label}-${record.started_at.replace(/[:.]/g, "-")}.json`);
const save = () => {
  mkdirSync(resolve(root, ".debug"), { recursive: true, mode: 0o700 });
  writeFileSync(output, redact(JSON.stringify(record, null, 2)) + "\n", { mode: 0o600 });
};

function comparisons(app, value, targets) {
  if (!Array.isArray(value?.items)) return [];
  return targets.map((pre) => {
    const post = value.items.find((q) => q && app.normTerm(q.term) === app.normTerm(pre.term));
    if (!post) return { term: pre.term, check: "missing_term", classification: "unusable_reply" };
    const checked = app.validateMCQ(post, pre.term, false);
    if (!checked.ok) return { term: pre.term, check: checked.reason, classification: "unusable_reply" };
    const correct = checked.value.options[checked.value.correct_index];
    const sameStem = app.normTerm(post.question) === app.normTerm(pre.question);
    const sameAnswer = app.normTerm(correct) === app.normTerm(pre.options[pre.correct_index]);
    return {
      term: pre.term, type: pre.type,
      pre_question: pre.question, post_question: post.question,
      pre_correct: pre.options[pre.correct_index], post_correct: correct,
      baseline_checks: { same_stem: sameStem, same_correct_option_text: sameAnswer },
      normalized_same_stem: normalize(post.question) === normalize(pre.question),
      normalized_duplicate_options: post.options.filter((o) => pre.options.some((p) => normalize(o) === normalize(p))),
      pre_numbers: pre.question.match(/\d+(?:\.\d+)?/g) || [],
      post_numbers: post.question.match(/\d+(?:\.\d+)?/g) || [],
      // A word match alone does not establish semantic repetition. Review both
      // stems/contexts in this log before calling a rejection a false positive.
      classification: sameStem ? "real_repeat_same_stem" : "manual_context_review_required",
    };
  });
}

try {
  if (!dryRun) {
    // The user-authorized credential file remains outside the repo. Only the
    // trimmed value is held in memory and sent to Anthropic's API-key header.
    const envKey = process.env.ANTHROPIC_API_KEY;
    key = (envKey !== undefined ? envKey : readFileSync(resolve(homedir(), ".config/bridge/anthropic_key"), "utf8")).trim();
    if (!key) throw new Error("The selected API credential is empty. No API request was made.");
  }
  const app = loadAppRuntime({ fetchImpl: async (url, init) => {
    // Reuse the app's HTTP behavior, including its documented 400 fallback.
    // Never retain x-api-key, the request object, environment, or credentials.
    const { "x-api-key": omitted, ...safeHeaders } = init.headers;
    const request = { url, headers: safeHeaders, body: JSON.parse(init.body) };
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    let response;
    try { response = await fetch(url, init); }
    catch (e) {
      currentRequests.push({ ...request, transport_error: {
        name: e.name, message: redact(e.message || "Transport failed"),
        cause_code: e.cause?.code, cause_message: e.cause?.message ? redact(e.cause.message) : undefined,
      } });
      throw e;
    }
    const rawBody = await response.clone().text();
    currentRequests.push({ ...request, status: response.status, request_id: response.headers.get("request-id"), response: rawBody });
    return response;
  } });
  const input = JSON.parse(JSON.stringify(app.statisticsCase()));
  assert.ok(input.targets.some((t) => t.type === "concept"));
  assert.ok(input.targets.some((t) => t.type === "language"));
  record.source_sha256 = app.sourceSHA256;
  record.model = app.model;
  record.input = input;

  if (dryRun) {
    // Test the extracted transport without a key or network call. This captures
    // its real request, rather than rebuilding the request in the harness.
    let request;
    const offline = loadAppRuntime({ fetchImpl: async (url, init) => {
      request = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"kind":"immediate_recheck","items":[]}' }], stop_reason: "end_turn" }), { status: 200 });
    } });
    const prompt = offline.promptRecheck(input);
    await offline.callAnthropic(prompt, offline.schema, "offline-placeholder", undefined);
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.body.model, offline.model);
    assert.equal(request.body.max_tokens, 8000);
    assert.equal(request.body.output_config.effort, "medium");
    assert.deepEqual(request.body.output_config.format.schema, JSON.parse(JSON.stringify(offline.schema)));
    assert.equal(request.body.messages[0].content, prompt);
    assert.equal(request.headers["anthropic-version"], "2026-10-21");
    assert.equal(request.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal(request.headers["anthropic-dangerous-direct-browser-access"], "true");
    const repeat = { kind: "immediate_recheck", items: input.targets };
    assert.equal(offline.validateRecheck(repeat, input.targets).ok, false);
    console.log("PASS harness dry run: verbatim app prompt, schema, parser, validator, and direct API transport; concept and language prerequisites included; no API call.");
  } else {
    for (let i = 0; i < runs; i++) {
      currentRequests = [];
      const generation = { number: i + 1, started_at: new Date().toISOString() };
      record.generations.push(generation);
      try {
        const prompt = app.promptRecheck(input);
        generation.prompt = prompt;
        const reply = await app.callAnthropic(prompt, app.schema, key, undefined);
        generation.reply = reply;
        const parsed = app.parseLooseJSON(reply.text);
        generation.validator = parsed.ok ? app.validateRecheck(parsed.value, input.targets) : parsed;
        generation.comparisons = parsed.ok ? comparisons(app, parsed.value, input.targets) : [];
        generation.requests = currentRequests;
        save();
        console.log(`Generation ${i + 1}: ${generation.validator.ok ? "PASS" : `REJECTED — ${generation.validator.reason}`}`);
        if (expectValid && !generation.validator.ok) throw new Error("Candidate validation failed. Stopping immediately.");
      } catch (e) {
        generation.requests = currentRequests;
        generation.error = redact(e.message || "API generation failed");
        throw e;
      }
    }
    record.passed = record.generations.filter((g) => g.validator?.ok).length;
    record.rejected = record.generations.length - record.passed;
    record.finished_at = new Date().toISOString();
    save();
    console.log(`${record.passed}/${runs} accepted; ${record.rejected}/${runs} rejected. Debug file: ${output}`);
  }
} catch (e) {
  record.error = redact(e.message || "Harness failed");
  record.finished_at = new Date().toISOString();
  save();
  console.error(redact(`STOP: ${record.error}\nDebug file: ${output}`));
  process.exitCode = 1;
}
