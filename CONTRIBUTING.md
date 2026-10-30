# Contributing to Moniwork

Thanks for helping. Moniwork is small on purpose, and this guide keeps it that way.

## Quick start

You need Node.js 22.18 or newer. You don't need a Cloudflare account for local work.

```sh
git clone https://github.com/Compile7/moniwork.git
cd moniwork
npm install
npm run dev
```

Open http://localhost:8787. On localhost you're signed in automatically, so Cloudflare Access isn't needed.

Want something to look at? Load demo projects, monitors and 24 hours of history:

```sh
npm run seed
```

> `npm run seed` **replaces everything in your local database**. It never touches a deployed one.

Cron doesn't fire on its own in dev. Trigger a run by hand:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Before you open a pull request

```sh
npm run check
```

This type-checks and runs the tests. CI runs the same command.

## How the code is laid out

| Path | What it does |
|---|---|
| `src/index.ts` | API routes, auth gate, cron entry point, heartbeat pings |
| `src/check.ts` | Running a check: steps, redirects, retries, regions, heartbeats, recording results |
| `src/curl.ts` | Turns a pasted curl command into a request `fetch()` can send |
| `src/notify.ts` | Alert cards and how each channel (Google Chat, Telegram, webhooks) renders them |
| `src/diagnose.ts` | DNS lookup and the AI failure summary |
| `src/jobs.ts` | Reminders, escalation, weekly report, SSL and domain expiry |
| `src/prober.ts` | Durable Object that runs a check from a specific region |
| `src/auth.ts` | Cloudflare Access JWT verification |
| `public/` | The UI: plain HTML, CSS and ES modules. No framework, no build step |
| `migrations/` | D1 schema, applied in order |
| `scripts/seed.mjs` | Demo data |

## House rules

These keep the project easy to run and easy to read.

- **No build step for the UI.** `public/` is served as-is. Templating goes through the escaping `html` helper in `app.js`.
- **No new runtime dependencies** without a good reason. The Worker has none today. Prefer the platform: `fetch`, Web Crypto, D1, Durable Objects.
- **Schema changes are new migrations.** Never edit a migration that's already released. Add `migrations/000N_name.sql`.
- **Match the code around you.** Same naming, same comment density, same plain style.
- **Tests for logic.** Parsers, matchers and message formatting get a test in `src/core.test.ts`. UI tweaks don't need one.
- **Plain words in the UI.** Short sentences. Say what happened and what to do next.
- **Fail closed.** Anything about auth or secrets defaults to refusing.

## Good first contributions

- New alert channels: Microsoft Teams, PagerDuty, email.
- More curl flags in `src/curl.ts`.
- More Uptime Kuma monitor types in `public/kuma.js`.
- Translating the UI.

Look for issues labelled [`good first issue`](https://github.com/Compile7/moniwork/labels/good%20first%20issue).

## Commit messages

Use the imperative and keep the first line short: `Add Teams channel`, `Fix redirect chain on 303`. Explain the why in the body if it isn't obvious.

## Reporting bugs and security issues

- Bugs and ideas: [open an issue](https://github.com/Compile7/moniwork/issues/new/choose).
- Security problems: **don't open a public issue.** See [SECURITY.md](SECURITY.md).

By contributing, you agree your work is released under the [MIT License](LICENSE), and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
