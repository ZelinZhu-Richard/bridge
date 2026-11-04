# Bridge

Bridge is an AI reading tutor for intro STEM students, especially ESL, first-generation and community-college students. It finds the background ideas and academic words a passage takes for granted, checks which ones the student really has, teaches only the missing pieces, then runs a short practice check with spaced review.

**Try it:** https://zelinzhu-richard.github.io/bridge/

## How to test (5 lines)
1. Open the site. It works on a phone or a laptop, with no sign-up.
2. Click **Try the demo**: miss at least one of the 3 quick-check questions, read the bridge, tap highlighted words in the passage, take the 3-question check, then answer the survey. Answer all 3 correctly to see the bridge step skipped.
3. Pick **中文** or **Español** before starting to get home-language glosses. **English only** shows none.
4. Under **Bring your own passage**, click **Fill in a statistics example** (or paste your own text), then **Find what it assumes**. This uses live AI.
5. Footer → **Evidence log** for averages and JSON/CSV export. Header → **Teacher** for the class view (**Load example class data** if it's empty). Settings (gear) → **Testing tools** to simulate broken AI output or shift the clock so spaced reviews come due.

## Files
- `app.html`: the whole app (HTML, CSS and JavaScript). It has no `<html>`/`<head>` wrapper, so it also works as a claude.ai Artifact.
- `build.sh`: wraps `app.html` into `index.html`, the page GitHub Pages serves. If `site-ai-url.txt` exists, the page uses that AI server.
- `worker/`: a small Cloudflare Worker that holds the site owner's Anthropic API key, so visitors get live AI without a key. It accepts only the app's own five request shapes and enforces per-visitor and daily limits. Setup is in `worker/README.md`.

## Where live AI comes from
In order: Claude itself when the page runs as a claude.ai Artifact; an Anthropic API key the visitor enters in Settings; the site's AI server (`worker/`). Without any of these, **Try the demo** still runs the whole loop with saved answers.

## Known limitations
- **Live AI was verified end to end against the real API on Nov 4, 2026 (owner-reported).** Later changes here are checked with a mock API and browser smoke tests; they do not establish live model quality. Per-task token caps are conservatively 8,000 because total usage including effort/thinking was not measured.
- **The site's AI is paid by the owner's key.** The shared daily limit is 400 requests; passage counts vary with misses and retries. The hourly limit is per network IP (IPv6 /64), so a school network may share one allowance. See the pilot recommendations in `worker/wrangler.toml`. Set a provider spend limit as well. When AI is unavailable or limited, students see a clear message and a saved-demo fallback.
- **The AI endpoint can be abused up to those limits.** Origin checks stop other browser sites, but a script can spoof Origin and submit any prompt using an allowed schema, including exhausting the shared daily allowance. Schema allowlisting does not restrict prompt purpose.
- **Data stays on one device.** Sessions, reviews and the teacher view live in that browser's localStorage. Testers have to export and send their files. The teacher view only sees students who used the same device, so a classroom pilot needs a shared device or a shared database.
- **AI content isn't reviewed by a person.** Answer keys, explanations and glosses come from the model. Cross-checking `answer_text` against `correct_index` catches index slips, not wrong math. The demo's saved Chinese and Spanish glosses were written by Claude and haven't been checked by a native-speaking teacher.
- **Multiple-choice balance is a partial check.** Prompts require similar option lengths and grammatical forms. A correct option longer than 1.5× the mean distractor length triggers one retry; a still-unbalanced usable item is accepted and logged in `mcq_quality_flags` (JSON and CSV). This does not detect every clue or establish item validity.
- **The first analysis of a passage is reused.** Every later student on the same device sees the same prerequisites and questions, which keeps class numbers comparable. A weak first analysis repeats until you use **Delete all data**.
- **Language gaps are under-sampled.** Only the top 3 prerequisites get a quick-check question. Academic-language terms often rank 4th or 5th, so they show up in the teacher view less often than they occur. Students can still tap **Explain this to me** on any marked word.
- **The guardrails are prompt-based.** The no-final-answer rule and the "say when unsure" rule live in the prompts. In the simulated homework test nothing leaked, but no code checks for a leaked answer.
- **Highlighting depends on the AI quoting the passage exactly.** If it doesn't, the term appears under "Also assumed" instead of being highlighted.
- **Math is plain Unicode text.** Passages full of LaTeX show the raw markup.
- **Time spent is wall-clock time** from start to survey, so it includes idle time.
- **The progress rail shows 5 phases:** Passage, Gaps, Check, Bridge (which includes the reread), and Practice (which includes the survey). Together they cover the 7 loop steps.
- **Example class data is made up.** It is labelled everywhere it appears and left out of session exports by default.

## After the application deadline
- TODO: replace client-built prompts with `{task, passage, course, language}`. The Worker must validate task inputs and build each prompt itself, including any required prerequisite context derived through a constrained protocol. This closes the general-purpose prompt endpoint; keep rate and spend limits because quota exhaustion remains possible. Do not do this refactor during demo week.
