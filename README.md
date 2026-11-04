# Bridge

Bridge is an AI reading tutor for intro STEM students, especially ESL, first-generation and community-college students. It finds the background ideas and academic words a passage takes for granted, checks which ones the student really has, teaches only the missing pieces, then runs a short practice check with spaced review. The Teacher view flags where learners may be off-track so a teacher can decide how to intervene.

**Try it:** https://zelinzhu-richard.github.io/bridge/

## How to test (5 lines)
1. Open the site. It works on a phone or a laptop, with no sign-up.
2. Choose an offline demo (**linear algebra, statistics, chemistry, or physics**) and click **Try the demo**: miss at least one quick-check question, read the bridge, answer a new immediate recheck on each missed prerequisite, reread with highlights, take the 3-question check, then answer the survey. Answer all quick-check items correctly to skip both bridge and recheck.
3. Pick **中文** or **Español** before starting to get home-language glosses. **English only** shows none. Speaker buttons read the passage, bridge explanation, or gloss using browser speech synthesis when supported; **Stop reading** stops playback.
4. Under **Bring your own passage**, click **Fill in a statistics example** (or paste your own text), then **Find what it assumes**. This uses live AI.
5. Footer → **Evidence log** for averages and JSON/CSV export. Header → **Teacher** for the class view (**Load example class data** if it's empty). Settings (gear) → **Testing tools** to simulate broken AI output or shift the clock so spaced reviews come due.

## Files
- `app.html`: the whole app (HTML, CSS and JavaScript). It has no `<html>`/`<head>` wrapper, so it also works as a claude.ai Artifact.
- `build.sh`: wraps `app.html` into `index.html`, the page GitHub Pages serves. If `site-ai-url.txt` exists, the page uses that AI server.
- `tests/demo-answer-audit.md`: worked verification of every saved demo answer key; no student evidence.
- `worker/`: a small Cloudflare Worker that holds the site owner's Anthropic API key, so visitors get live AI without a key. It accepts the app's six schemas and enforces per-network and daily limits. Setup is in `worker/README.md`.

## Where live AI comes from
In order: Claude itself when the page runs as a claude.ai Artifact; an Anthropic API key the visitor enters in Settings; the site's AI server (`worker/`). Without any of these, **Try the demo** still runs the whole loop with saved answers.

## Known limitations
- **Live AI has a known recheck-generation failure.** A Nov 4 live statistics run reached the bridge, but both recheck replies failed the repeat validator. Failed rechecks now continue automatically to the reread, with `post_status: "recheck_unavailable"` and null post results per missed prerequisite. They are excluded from pre/post statistics and counted separately in Evidence and Teacher views. The validator's root cause is still under investigation. Per-task caps remain conservatively 8,000 because total usage including effort/thinking was not measured.
- **The site's AI is paid by the owner's key.** The shared daily limit is 400 requests; passage counts vary with misses and retries. The hourly limit is per network IP (IPv6 /64), so a school network may share one allowance. See the pilot recommendations in `worker/wrangler.toml`. Set a provider spend limit as well. When AI is unavailable or limited, students see a clear message and a saved-demo fallback.
- **The AI endpoint can be abused up to those limits.** Origin checks stop other browser sites, but a script can spoof Origin and submit any prompt using an allowed schema, including exhausting the shared daily allowance. Schema allowlisting does not restrict prompt purpose.
- **Data stays on one device.** Sessions, reviews and the teacher view live in that browser's localStorage. Testers have to export and send their files. The teacher view only sees students who used the same device, so a classroom pilot needs a shared device or a shared database.
- **AI content needs teacher review.** Live answer keys, explanations and glosses come from the model. Cross-checking `answer_text` against `correct_index` catches index slips, not wrong math. Saved demo answer keys have a worked audit in `tests/demo-answer-audit.md`; their AI-authored Chinese and Spanish glosses are not yet reviewed by a native-speaking teacher.
- **Multiple-choice balance is a partial check.** Prompts require similar option lengths and grammatical forms. A correct option longer than 1.5× the mean distractor length triggers one retry; a still-unbalanced usable item is accepted and logged in `mcq_quality_flags` (JSON and CSV). This does not detect every clue or establish item validity.
- **Pre/post results are an immediate recheck, not long-term retention.** Only missed quick-check prerequisites receive new parallel items after the bridge. The Evidence log and Teacher view use matched answered posts; unassessed posts stay null and older sessions have no pre/post records. These are small samples, without a control group or a pre-test of the passage mini-check. They do not establish causal learning gains. Live recheck quality still needs teacher review.
- **The first analysis of a passage is reused.** Every later student on the same device sees the same prerequisites and questions, which keeps class numbers comparable. A weak first analysis repeats until you use **Delete all data**.
- **Language gaps are under-sampled.** Only the top 3 prerequisites get a quick-check question. Academic-language terms outside the top 3 are not assessed, although the three new offline demos include a language item in their top 3. Students can still tap **Explain this to me** on any marked word.
- **The guardrails are prompt-based.** The no-final-answer rule and the "say when unsure" rule live in the prompts. In the simulated homework test nothing leaked, but no code checks for a leaked answer.
- **Highlighting depends on the AI quoting the passage exactly.** If it doesn't, the term appears under "Also assumed" instead of being highlighted.
- **Math is plain Unicode text.** Passages full of LaTeX show the raw markup.
- **Read aloud depends on the browser and installed voices.** English explanations request an English voice; glosses request Chinese/Spanish voices when available. The browser chooses a fallback if no matching voice is installed. Math pronunciation may be poor. No external TTS service is called by Bridge, and speaker buttons are hidden when speech synthesis is unsupported.
- **Time spent is wall-clock time** from start to survey, so it includes idle time.
- **The progress rail shows 5 phases:** Passage, Gaps, Check, Bridge (which includes the immediate recheck and reread), and Practice (which includes the survey).
- **Example class data is made up.** It is labelled everywhere it appears and left out of session exports by default.

## After the application deadline
- TODO: replace client-built prompts with `{task, passage, course, language}`. The Worker must validate task inputs and build each prompt itself, including any required prerequisite context derived through a constrained protocol. This closes the general-purpose prompt endpoint; keep rate and spend limits because quota exhaustion remains possible. Do not do this refactor during demo week.

## Required checks before merging
```sh
npm ci
npx playwright install chromium
node worker/scripts/extract-schemas.mjs
node worker/test/run.mjs
sh build.sh
node tests/smoke.mjs
```
The smoke suite starts a local server and uses bundled headless Chromium, blocks live AI calls, and checks every saved demo at 390×844. For a manual preview in Codex's built-in browser: `node tests/smoke.mjs --serve` serves only the built page at `http://127.0.0.1:8765`.

## Roll out the immediate-recheck update
Redeploy the Worker **before pushing the new main**, because the existing deployment does not yet accept the new recheck schema. The existing Worker URL, site configuration, model and secret stay in place; live AI is already enabled.

```sh
cd /Users/richardzhu/dev/edu_plat/workspace/bridge/worker
node scripts/extract-schemas.mjs
npx wrangler deploy
cd ..
git push origin main
```

The original Nov 4 update passed local mock tests, then its live statistics run failed at recheck generation. The non-blocking fallback is shipped separately before changing that validator. Feature freeze is **Thursday Nov 5 at 6:00 PM ET** (bug fixes only); no merges after **10:00 PM ET**. MIT Solve submission is due **Friday Nov 6, 2026 at noon ET**.
