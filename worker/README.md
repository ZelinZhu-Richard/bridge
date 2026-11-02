# bridge-ai Worker

A small Cloudflare Worker that lets the Bridge site on GitHub Pages call Claude with your Anthropic API key. The key is stored as a Worker secret. It never reaches the browser.

## Set up and deploy

Run these in this folder:

```sh
npm install
npx wrangler login
npm run deploy
npx wrangler secret put ANTHROPIC_API_KEY
```

`wrangler login` opens Cloudflare in your browser (a free account is enough). The first deploy may ask you to pick a `workers.dev` subdomain, and it prints the URL, which looks like `https://bridge-ai.<account-subdomain>.workers.dev`. `wrangler secret put` then asks you to paste the key. Check that it works: open `<that URL>/health`. You should see `{"ok":true,"model":"claude-opus-5-5","configured":true}`.

Then put that URL in `../site-ai-url.txt`, run `../build.sh`, and push: the site uses the Worker from then on.

**Use a dedicated API key for this Worker, and set a monthly spend limit for it in the Anthropic Console.** The Worker's own limits (below) slow abuse, but the Console spend limit is the hard cap on cost.

## Settings (`wrangler.toml`)

| Var | Default | Meaning |
| --- | --- | --- |
| `MODEL` | `claude-opus-5-5` | Model for every request |
| `ALLOWED_ORIGINS` | GitHub Pages site, `localhost:8765`, `127.0.0.1:8765` | Comma-separated sites that may call the Worker |
| `DAILY_LIMIT` | `400` | Requests per UTC day, all visitors together |
| `IP_HOURLY_LIMIT` | `60` | Requests per visitor IP per hour (IPv6: per /64) |

Change a value, then run `npm run deploy` again. Rate limits are counted by one SQLite-backed Durable Object, which works on the free plan. IP addresses are never stored: the counter key is a truncated SHA-256 of the IP and the UTC day.

## API

- `GET /health` returns `{"ok":true,"model":"...","configured":true|false}`.
- `POST /v1/generate` with JSON `{"prompt":"...","schema":{...}}`. `schema` must be one of the app's five schemas. The reply is the Anthropic Messages API response, passed through unchanged.
- Limits: body up to 64 KB, prompt up to 12,000 characters.
- Errors from the Worker look like `{"type":"error","error":{"type":"bridge_…","message":"…"}}`. Examples: `bridge_unknown_schema` (400), `bridge_prompt_too_large` (413), `bridge_rate_limit` and `bridge_daily_limit` (429, with `Retry-After`), `bridge_not_configured` (503), `bridge_upstream_auth` (502, the key was rejected).

The schemas are copied from `../app.html` into `src/schemas.js` by `npm run extract`. `npm run dev`, `npm test` and `npm run deploy` run it first, so the Worker always matches the app.

## Local testing

`npm test` starts a mock Anthropic API and `wrangler dev` in local mode with a fake key. It needs no Cloudflare account and spends nothing. It writes a temporary `.dev.vars` and deletes it afterwards. If you have your own `.dev.vars`, move it aside first.
