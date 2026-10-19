# Security

## Report a vulnerability

Use GitHub private vulnerability reporting.
Open the Security tab of <https://github.com/fquresh/twitter-trove> and click "Report a vulnerability".
Do not open a public issue for a security problem.
Include the steps to reproduce, the affected file, and the impact.

Trove is a personal project shared as-is.
Replies can be slow.

## Scope

In scope:

- The Pages Functions in `webapp/functions/api/`.
- The local server `wiki_server.py`.
- The URL fetcher in `enrich.py`.
- The Chrome extension in `x-collector/`.
- The web app in `webapp/`.

Out of scope:

- Your own Cloudflare Access configuration.
- Leaked keys that you committed yourself.
- Issues in third-party services such as X, DeepSeek, Voyage, OpenRouter, and Cloudflare.

## Security model

- **Access-gated API.** Every `/api/*` route verifies a Cloudflare Access JWT. The R2 bucket is private and is read only through `/api/data/<file>`.
- **Fail-closed auth.** `_auth.ts` returns a 500 error when `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, or `ALLOWED_EMAIL` is missing. It pins RS256 and checks the audience and issuer. Only `ALLOW_UNAUTHENTICATED_DEV=true` disables the gate, and it is for local development only.
- **Cost guards.** `/api/chat` and `/api/embed` cap the body size, clamp `max_tokens`, and rate-limit each user. API keys stay in Pages secrets and never reach the browser.
- **Loopback-only local server.** `wiki_server.py` binds to `127.0.0.1` by default. It rejects any request whose `Host` header is not a loopback name. This blocks DNS rebinding. Its CORS list holds only local ports.
- **SSRF guard.** `enrich.py` checks each URL and each redirect hop. It blocks private, loopback, link-local, and other non-public addresses. It also limits redirects and body size.
- **Content-Security-Policy.** `webapp/public/_headers` sets a strict policy: no inline scripts, `connect-src 'self'`, no framing, and images only from the same origin and `*.twimg.com`.
- **Secrets stay out of git.** `.env`, `webapp/wrangler.toml`, `exports/`, data files, caches, and `wiki/` are in `.gitignore`.
- **Local keys.** The endpoint `/api/keys/load` on the local server returns your keys as plain text, to loopback requests only. Do not expose that server to a network.
