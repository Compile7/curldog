# Moniwork

HTTP monitoring for internal teams, running entirely on Cloudflare.

- **Projects** group monitors. **Monitors** are curl commands run on a schedule (1m to 1h).
- Paste any curl, including Chrome's "Copy as cURL". Test it before saving.
- Uptime (24h / 7d / 30d), response-time chart, incident timeline.
- Alerts to **Google Chat**, **Telegram**, and Slack/Discord when a monitor goes down or recovers.
- Import from an **Uptime Kuma** backup, including its Google Chat and Telegram notifications.
- A failing check is retried once after 3s before a monitor is marked down.
- **Alerts** carry the error, status, a body snippet, 7-day uptime and an **AI explanation** (Workers AI), with **Open / Acknowledge / Mute 1h** buttons. Several monitors failing together in one project send one message.
- **Reminders and escalation** per project when nobody acknowledges. **Mute** a monitor or project during a deploy.
- **Slow alerts:** response time over a threshold for 5 minutes.
- **Diagnose** a failed check: both attempts, redirect chain, DNS (1.1.1.1), request ID, size, and a diff against the last good response.
- **Multi-step checks** (log in, reuse `{{token}}`), **3-region checks** (US/EU/Asia, down when 2 of 3 fail), **heartbeat monitors** for cron jobs.
- **Weekly report** (Mondays 04:00 UTC) and **SSL / domain expiry** warnings at 14 and 3 days.

## Stack

| Piece | What |
|---|---|
| Worker | API (`src/index.ts`) + static UI (`public/`) |
| Cron | Every minute: runs due monitors. Hourly: deletes checks older than 30 days |
| D1 | `projects`, `monitors`, `checks`, `events`, `channels` (`migrations/`) |
| Access | Login. The Worker verifies the Access JWT on every `/api` call |

## Run locally

```sh
npm install
npm run dev
```

Open http://localhost:8787. `.dev.vars` sets `DEV_USER`, which skips Access locally. Dev runs with `--local`, so AI summaries are skipped (Workers AI only runs remotely).

Cron doesn't fire by itself in dev. Trigger it with:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Deploy

Needs the Workers Paid plan ($5/mo). The free plan's subrequest limit is too low for many monitors.

1. Create the database, then paste the printed `database_id` into `wrangler.jsonc`:
   ```sh
   npx wrangler d1 create moniwork
   ```
2. Deploy (applies migrations first):
   ```sh
   npm run deploy
   ```
3. Put it behind Cloudflare Access:
   - Zero Trust → Access → Applications → Add → Self-hosted.
   - Domain: your Worker's custom domain (or `moniwork.<subdomain>.workers.dev`).
   - Policy: allow your team's emails or email domain.
   - Copy the **Application Audience (AUD) tag**.
4. Set `ACCESS_TEAM_DOMAIN` (e.g. `acme.cloudflareaccess.com`) and `ACCESS_AUD` in `wrangler.jsonc` → `vars`, then run `npm run deploy` again.
5. Optional: set `APP_URL` in `vars` (e.g. `https://moniwork.example.com`) so alerts include an "Open in Moniwork" link.

Until step 4 is done, every API call returns 401. That's on purpose: the API never runs without Access.

6. Heartbeat pings come from your servers, which can't log in to Access. Add a second Access application for the path `/hb` on the same domain with a **Bypass** policy (Everyone). The token in each ping URL is the secret.

## Notifications

Set up channels on the **Notifications** page, then pick them per project (project → Settings).

- **Google Chat:** space → Apps & integrations → Webhooks → add one, paste the URL.
- **Telegram:** create a bot with @BotFather, add it to your group, send a message, then click **Detect** to fill the chat ID.
- **Slack / Discord:** paste an incoming webhook URL.

Every channel has a **Test** button. Alerts fire once when a monitor goes down (after one retry) and once when it recovers, with the downtime.

## Checks

```sh
npm run check
```

Type-checks and runs `src/core.test.ts` (curl parser, status matching, Access JWT verification, Kuma import, alert messages).

## Limits

- Public URLs only. Workers can't reach private networks without Cloudflare Tunnel.
- Not supported: `-k`, `--resolve`, proxies, client certs, `-F` multipart, `@file` bodies. The form tells you why.
- Curl commands and channel secrets (webhook URLs, Telegram bot tokens) are stored in plain text in D1. Anyone with Access can see them.
- SSL expiry comes from Certificate Transparency logs (crt.sh), not from the live server: Workers can't read a server's certificate. Domain expiry comes from RDAP; some registries (e.g. `.ai`) don't publish it.
- Checks fan out directly from the cron run. Past ~1,000 monitors per minute, move them onto a Cloudflare Queue.
