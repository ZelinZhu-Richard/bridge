// Full student/teacher loop. No real API requests, keys, or personal browser profiles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = readFileSync(resolve(root, "index.html"), "utf8");
execFileSync("sh", ["build.sh"], { cwd: root });
assert.equal(readFileSync(resolve(root, "index.html"), "utf8"), built, "index.html was stale; rebuild and rerun");
const server = createServer((req, res) => {
  if (req.url?.split("?")[0] !== "/" && req.url !== "/index.html") { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(built);
});
await new Promise((r) => server.listen(process.argv.includes("--serve") ? 8765 : 0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve")) {
  console.log(`Codex built-in browser preview: ${base}`);
  await new Promise((r) => { process.once("SIGINT", r); process.once("SIGTERM", r); });
  server.close();
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
const errors = [], unexpected = [];
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const action = (page, name) => page.locator(`[data-action="${name}"]`).first().click();
const waitView = (page, view) => page.waitForFunction((v) => window.BridgeTest.state().view === v, view);
const session = (page) => page.evaluate(() => window.BridgeTest.state().session);

async function newPage({ reply, blockedStorage = false, speechMock = false, noSpeech = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.stack));
  page.on("console", (m) => { if (m.type() === "error" && m.text().includes("[Bridge]")) errors.push(m.text()); });
  if (blockedStorage) await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } });
  });
  if (speechMock || noSpeech) await page.addInitScript(({ noSpeech }) => {
    window.__spoken = []; window.__speechCancels = 0;
    Object.defineProperty(window, "speechSynthesis", { value: noSpeech ? undefined : {
      getVoices: () => ["en-US", "zh-CN", "es-ES"].map((lang) => ({ lang, name: lang, localService: true })),
      cancel: () => { window.__speechCancels++; },
      speak: (u) => window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice?.lang }),
    } });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: noSpeech ? undefined : class { constructor(text) { this.text = text; } } });
  }, { noSpeech });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base || url.protocol === "blob:") return route.continue();
    if (url.pathname === "/health") return route.fulfill({ json: { ok: true, configured: true } });
    if (url.pathname === "/v1/generate") {
      if (reply) return reply(route);
      unexpected.push(route.request().url());
      return route.fulfill({ status: 503, json: { error: { type: "bridge_unavailable" } } });
    }
    return route.abort(); // fonts are optional; the whole demo works offline
  });
  await page.goto(base);
  await page.waitForFunction(() => !!window.BridgeTest);
  return page;
}

async function noOverflow(page) {
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal overflow at 390px");
}

async function startDemo(page, demoId, language) {
  if (await page.locator("#demoSelect").count()) await page.locator("#demoSelect").selectOption(demoId);
  await page.locator("#langSelect").selectOption(language);
  await action(page, "demo");
  await action(page, "startDiag");
  await page.waitForFunction(() => window.BridgeTest.state().diag?.status === "ready");
}

async function quickCheck(page, missCount) {
  const count = await page.evaluate(() => window.BridgeTest.state().diag.items.length);
  for (let i = 0; i < count; i++) {
    if (i < missCount) await action(page, "diagUnsure");
    else {
      const k = await page.evaluate(() => { const d = window.BridgeTest.state().diag; return d.items[d.index].correct_index; });
      await page.locator(`[data-action="diagPick"][data-k="${k}"]`).click();
    }
    await action(page, "diagNext");
  }
}

async function finishLoop(page, { language, missCount }) {
  await quickCheck(page, missCount);
  if (missCount) {
    await waitView(page, "bridge");
    await page.waitForFunction(() => Object.values(window.BridgeTest.state().bridges).every((b) => b.status === "ready"));
    check(await page.locator("#main .gloss").count() === (language === "en" ? 0 : missCount), `${language} gloss visibility`);
    if (language === "zh") check(/[㐀-鿿]/.test(await page.locator("#main .gloss").first().innerText()), "Chinese gloss contains Chinese");
    if (language !== "en") {
      await page.locator("#glossToggle").uncheck();
      check(await page.locator("#main .gloss").count() === 0, "gloss toggle hides text");
      await page.locator("#glossToggle").check();
    }
    await noOverflow(page);
    await action(page, "startRecheck");
    await page.waitForFunction(() => window.BridgeTest.state().recheck?.status === "ready");
    const items = await page.evaluate(() => window.BridgeTest.state().recheck.items);
    check(items.length === missCount, "one post per missed prerequisite");
    for (let i = 0; i < items.length; i++) {
      if (i === 0) await page.locator(`[data-action="recheckPick"][data-k="${items[i].correct_index}"]`).click();
      else await action(page, "recheckUnsure");
      await action(page, "recheckNext");
    }
    const s = await session(page);
    check(s.recheck_status === "completed", "post logged complete");
    check(s.prerequisite_pre_post.filter((p) => p.pre === false && typeof p.post === "boolean").length === missCount, "matched pairs logged");
    check(s.recheck[0].correct && s.prerequisite_pre_post.some((p) => p.pre === false && p.post === true), "miss → correct logged");
    if (missCount > 1) check(s.recheck[1].unsure && !s.recheck[1].correct, "post Not sure is a miss");
  } else {
    check(await page.locator("#main").innerText().then((s) => s.includes("Bridge and recheck skipped")), "both steps skipped for all correct");
    const s = await session(page);
    check(s.bridge_skipped && s.recheck_status === "skipped_all_correct" && s.recheck.length === 0, "skips recorded without invented posts");
  }
  await finishReading(page);
}

async function finishReading(page) {
  await waitView(page, "reread");
  await noOverflow(page);
  await action(page, "toPractice");
  await page.waitForFunction(() => window.BridgeTest.state().mini?.status === "ready");
  for (let i = 0; i < 3; i++) {
    const k = await page.evaluate(() => { const m = window.BridgeTest.state().mini; return m.questions[m.index].correct_index; });
    await page.locator(`[data-action="miniPick"][data-k="${k}"]`).click();
    await action(page, "miniNext");
  }
  await action(page, "toSurvey");
  await page.locator('label[for="helpful-3"]').click();
  await page.locator('label[for="found_new-0"]').click();
  await page.locator("#confusing").fill("Smoke test response, not participant evidence.");
  await page.locator('#surveyForm button[type="submit"]').click();
  await waitView(page, "done");
  check((await session(page)).completed, "full loop completes");
}

// RFC 4180-style parser: verify rows, quoted JSON, embedded commas and line breaks.
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && c === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  assert.equal(quoted, false, "CSV quotes closed");
  if (cell || row.length) rows.push([...row, cell]);
  for (const r of rows) assert.equal(r.length, rows[0].length, "CSV column count");
  return rows;
}
async function exported(page, name) {
  const pending = page.waitForEvent("download");
  await action(page, name);
  const dl = await pending;
  const stream = await dl.createReadStream();
  let text = ""; for await (const chunk of stream) text += chunk.toString("utf8");
  return text;
}

try {
  const inventory = await newPage();
  const demos = await inventory.evaluate(() => window.BridgeTest.demos());
  const recheckValidation = await inventory.evaluate(() => {
    const { data } = window.BridgeTest.demos()[0];
    const targets = data.diagnostic.items;
    const validate = window.BridgeTest.validators.validateRecheck;
    const same = { kind: "immediate_recheck", items: targets };
    const missing = { kind: "immediate_recheck", items: data.recheck.items.slice(0, 1) };
    return !validate(same, targets).ok && !validate(missing, targets).ok && validate(data.recheck, targets).ok;
  });
  check(recheckValidation, "recheck rejects reused or missing questions and accepts parallel items");
  await inventory.context().close();
  for (const demo of demos) {
    check(demo.data.gaps.prerequisites.length >= 3 && demo.data.gaps.prerequisites.length <= 5, `${demo.id} has 3–5 prerequisites`);
    for (const p of demo.data.gaps.prerequisites) {
      const b = demo.data.bridges[p.term];
      check(b && b.intuition && b.definition && b.example && b.gloss.zh && b.gloss.es, `${demo.id}: ${p.term} has complete offline bridges and glosses`);
    }
    // Audit every stored key and option length, including all saved parallel items.
    for (const q of [...demo.data.diagnostic.items, ...demo.data.recheck.items, ...demo.data.minicheck.questions]) {
      check(q.answer_text === q.options[q.correct_index], `${demo.id} saved answer key agrees`);
      const mean = q.options.filter((_, i) => i !== q.correct_index).reduce((n, o) => n + o.length, 0) / (q.options.length - 1);
      check(q.answer_text.length <= 1.5 * mean, `${demo.id} option lengths balanced: ${q.question}`);
    }
    for (const [language, missCount] of [["zh", 3], ["en", 1], ["es", 1], ["en", 0]]) {
      const page = await newPage();
      await startDemo(page, demo.id, language);
      await finishLoop(page, { language, missCount });
      await action(page, "teacherMode");
      check((await page.locator("#main").innerText()).includes("Pre → post"), "teacher shows pre/post");
      if (missCount) check((await page.locator("#main").innerText()).includes("Saved example (written for this demo passage)"), `${demo.id} has a saved teacher lesson`);
      await action(page, "addExamples");
      check((await page.locator("#main").innerText()).includes("made-up students"), "example class clearly labeled");
      await action(page, "admin");
      check((await page.locator("#main").innerText()).includes("Missed prerequisites answered correctly right after the bridge"), "evidence metric present");
      const json = JSON.parse(await exported(page, "exportJSON"));
      check(json.sessions.length === 1 && !json.sessions[0].example_data, "JSON excludes example data by default");
      check(Array.isArray(json.sessions[0].prerequisite_pre_post) && Array.isArray(json.sessions[0].recheck), "JSON includes new fields");
      const csv = parseCSV(await exported(page, "exportCSV"));
      check(csv.length === 2, "CSV excludes example data by default");
      for (const col of ["recheck_status", "recheck_results", "recheck_correct", "recheck_total", "prerequisite_pre_post", "mcq_quality_flags"]) check(csv[0].includes(col), `CSV includes ${col}`);
      for (const col of ["prerequisite_pre_post", "recheck_results", "mcq_quality_flags"]) check(Array.isArray(JSON.parse(csv[1][csv[0].indexOf(col)])), `${col} round trips through CSV`);
      const classRows = parseCSV(await page.evaluate(() => window.BridgeTest.classCSV()));
      check(classRows[0].includes("immediate_post_correct"), "class CSV includes matched posts");
      check(!classRows.flat().some((s) => s.includes("made-up")), "class CSV excludes examples by default");
      await page.context().close();
      console.log(`PASS ${demo.id}: ${language}, ${missCount} misses, full loop and exports`);
    }
  }

  for (const demo of demos) for (const mode of ["once", "always", "site-down", "site-rate", "site-daily"]) {
    const page = await newPage();
    if (await page.locator("#demoSelect").count()) await page.locator("#demoSelect").selectOption(demo.id);
    await action(page, "settings");
    await page.locator("#faultSelect").selectOption(mode);
    await action(page, "home");
    if (mode.startsWith("site-")) { await action(page, "fillStats"); await page.locator('#inputForm button[type="submit"]').click(); }
    else await action(page, "demo");
    if (mode === "once") await action(page, "startDiag");
    else {
      await page.locator('[data-action="demoFallback"]').waitFor();
      check((await page.locator('[role="alert"]').innerText()).length > 50, "AI fault has a clear explanation");
      await action(page, "demoFallback");
      await action(page, "startDiag");
    }
    await page.waitForFunction(() => window.BridgeTest.state().diag?.status === "ready");
    await page.context().close();
    console.log(`PASS ${demo.id} fault simulator: ${mode}, recovery to saved demo`);
  }

  for (const [status, type] of [[429, "bridge_rate_limit"], [429, "bridge_daily_limit"], [503, "bridge_not_configured"], [503, "bridge_unavailable"]]) {
    const page = await newPage({ reply: (route) => route.fulfill({ status, json: { error: { type } } }) });
    await action(page, "fillStats");
    await page.locator('#inputForm button[type="submit"]').click();
    await page.locator('[data-action="demoFallback"]').waitFor();
    check((await page.locator('[role="alert"]').innerText()).length > 50, `real HTTP ${status} ${type} is explained`);
    await action(page, "demoFallback"); await action(page, "startDiag");
    await page.waitForFunction(() => window.BridgeTest.state().diag?.status === "ready");
    await page.context().close();
  }

  // Live transport, deterministic replies: a length clue retries once, then flags
  // only a still-unbalanced item. This also exercises the new recheck schema path.
  for (const fixedOnRetry of [true, false]) {
    let diagnosticCalls = 0;
    const fixture = structuredClone(demos[0].data);
    const page = await newPage({ reply: async (route) => {
      const { schema } = route.request().postDataJSON();
      let output;
      if (schema.properties.prerequisites) output = fixture.gaps;
      else if (schema.properties.kind) output = { kind: "immediate_recheck", items: [fixture.recheck.items[0]] };
      else if (schema.properties.items) {
        diagnosticCalls++;
        output = structuredClone(fixture.diagnostic);
        if (!fixedOnRetry || diagnosticCalls === 1) {
          const q = output.items[0]; q.options[q.correct_index] = "Ten, found by multiplying matching components and then adding the products together"; q.answer_text = q.options[q.correct_index];
        }
      } else if (schema.properties.questions) output = fixture.minicheck;
      else if (schema.properties.intuition) {
        const b = fixture.bridges["dot product"]; output = { term: "dot product", ...b, gloss: "" };
      } else throw new Error("Unexpected mocked task");
      await route.fulfill({ json: { content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn" } });
    } });
    await action(page, "fillStats");
    await page.locator('#inputForm button[type="submit"]').click();
    await action(page, "startDiag");
    await page.waitForFunction(() => window.BridgeTest.state().diag?.status === "ready");
    check(diagnosticCalls === 2, "length clue retries exactly once");
    check((await session(page)).mcq_quality_flags.length === (fixedOnRetry ? 0 : 1), "unresolved length clue flagged honestly");
    await finishLoop(page, { language: "en", missCount: 1 });
    await page.context().close();
    console.log(`PASS mocked live AI balance retry: ${fixedOnRetry ? "repaired" : "accepted and flagged"}, recheck and loop`);
  }
  for (const failure of ["repeat", "malformed", "transport"]) {
    const fixture = structuredClone(demos[0].data);
    let recheckCalls = 0;
    const page = await newPage({ reply: async (route) => {
      const { schema, prompt } = route.request().postDataJSON();
      let output;
      if (schema.properties.prerequisites) output = fixture.gaps;
      else if (schema.properties.kind) {
        recheckCalls++;
        if (failure === "transport") return route.fulfill({ status: 503, json: { error: { type: "bridge_unavailable" } } });
        output = failure === "repeat" ? { kind: "immediate_recheck", items: fixture.diagnostic.items } : { broken: true };
      } else if (schema.properties.items) output = fixture.diagnostic;
      else if (schema.properties.questions) output = fixture.minicheck;
      else if (schema.properties.intuition) {
        const term = Object.keys(fixture.bridges).find((term) => prompt.includes(`missing one prerequisite: ${JSON.stringify(term)}`));
        assert.ok(term, "bridge request identifies its prerequisite");
        output = { term, ...fixture.bridges[term], gloss: "" };
      } else throw new Error("Unexpected task");
      await route.fulfill({ json: { content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn" } });
    } });
    await action(page, "fillStats"); await page.locator('#inputForm button[type="submit"]').click();
    await action(page, "startDiag");
    await page.waitForFunction(() => window.BridgeTest.state().diag?.status === "ready");
    await quickCheck(page, 3);
    await page.waitForFunction(() => Object.values(window.BridgeTest.state().bridges).every((b) => b.status === "ready"));
    await action(page, "startRecheck"); await waitView(page, "reread");
    check(recheckCalls === (failure === "transport" ? 1 : 2), `${failure}: generation exhausted its applicable attempts`);
    const s = await session(page);
    check(s.recheck_status === "recheck_unavailable" && s.recheck.length === 0, "failure does not invent post answers");
    check(s.prerequisite_pre_post.length === 3 && s.prerequisite_pre_post.every((p) => p.post === null && p.post_status === "recheck_unavailable"), "unavailable logged for every missed prerequisite");
    check((await page.locator("#main").innerText()).includes("excluded from pre/post statistics"), "reread explains missing evidence");
    await finishReading(page);
    await action(page, "admin");
    check((await page.locator("#main").innerText()).includes("0 of 0 (0%)"), "unavailable posts excluded from numerator and denominator");
    check((await page.locator("#main").innerText()).includes("3 recheck_unavailable"), "Evidence counts unavailable posts");
    const json = JSON.parse(await exported(page, "exportJSON"));
    check(json.sessions[0].prerequisite_pre_post.every((p) => p.post_status === "recheck_unavailable"), "JSON contains unavailable status");
    const csv = parseCSV(await exported(page, "exportCSV"));
    check(JSON.parse(csv[1][csv[0].indexOf("prerequisite_pre_post")]).every((p) => p.post_status === "recheck_unavailable"), "CSV contains unavailable status");
    await action(page, "teacherMode");
    const teacher = await page.locator("#main").innerText();
    check(teacher.includes("recheck_unavailable (excluded)") && teacher.includes("no matched rechecks"), "Teacher distinguishes unavailable from incorrect posts");
    await page.context().close();
    console.log(`PASS recheck ${failure}: automatically continues through survey; unavailable excluded from evidence`);
  }
  const blocked = await newPage({ blockedStorage: true });
  await startDemo(blocked, demos[0].id, "en");
  await finishLoop(blocked, { language: "en", missCount: 1 });
  await blocked.context().close();
  for (const language of ["zh", "es"]) {
    const page = await newPage({ speechMock: true });
    await startDemo(page, demos[0].id, language);
    await quickCheck(page, 1);
    await page.getByRole("button", { name: "Read explanation aloud", exact: true }).click();
    await page.getByRole("button", { name: "Read gloss aloud", exact: true }).click();
    let spoken = await page.evaluate(() => window.__spoken);
    check(spoken[0].lang === "en-US" && spoken[0].voice === "en-US", "English explanation uses English voice");
    check(spoken[1].lang.startsWith(language) && spoken[1].voice.startsWith(language), "gloss uses a matching available voice");
    await action(page, "stopSpeech");
    check(await page.evaluate(() => window.__speechCancels >= 3), "stop reading cancels speech");
    await action(page, "startRecheck");
    await page.waitForFunction(() => window.BridgeTest.state().recheck?.status === "ready");
    await action(page, "recheckUnsure"); await action(page, "recheckNext");
    await page.getByRole("button", { name: "Read passage aloud", exact: true }).click();
    spoken = await page.evaluate(() => window.__spoken);
    check(spoken.at(-1).lang === "en-US" && spoken.at(-1).text === demos[0].passage, "whole passage read in English");
    await page.context().close();
  }
  const unsupported = await newPage({ noSpeech: true });
  await startDemo(unsupported, demos[0].id, "zh"); await quickCheck(unsupported, 1);
  check(await unsupported.locator('[data-action="speak"]').count() === 0, "speaker buttons hidden where unsupported");
  await unsupported.context().close();
  check(errors.length === 0, `zero uncaught page errors: ${errors.join("\n")}`);
  check(unexpected.length === 0, "saved demos and fault simulations made zero AI generation requests");
  console.log(`PASS ${checks} assertions; ${demos.length} saved demo(s); zero uncaught page errors; build matches app.html`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
