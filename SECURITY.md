# Security Policy

Moniwork stores curl commands that often carry API keys, plus webhook URLs and bot tokens. We take security reports seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately:

1. Go to [Security → Report a vulnerability](https://github.com/Compile7/moniwork/security/advisories/new).
2. Describe the problem, how to reproduce it, and what an attacker could do.

You'll get a reply within 3 working days. We'll keep you updated, credit you in the release notes if you want, and publish an advisory once a fix ships.

## Supported versions

Only the latest release on `master` gets security fixes.

## How Moniwork is protected

These are the security boundaries. Anything that gets around one of them is a vulnerability.

- **Every `/api` request needs a valid Cloudflare Access JWT.** The Worker checks the signature, audience, issuer and expiry itself, so the API can't be reached by going around Access, for example through the workers.dev URL.
- **It fails closed.** If Access isn't configured, every API request is refused.
- **The local dev login only works on `localhost`.** It can't be turned on for a deployed Worker.
- **Writes must be JSON.** That blocks cross-site form posts (CSRF).
- **Heartbeat URLs (`/hb/<token>`) are public on purpose.** They're protected only by a random 96-bit token. They can record a ping and nothing else.
- **All output is escaped.** The UI only renders HTML through an escaping template helper.

## Known limits (not vulnerabilities)

- Curl commands and channel secrets are stored **in plain text in D1**. Everyone who can sign in through Access can see them. Only give access to people you'd trust with those credentials.
- Checks run from Cloudflare's network, so a monitored URL can't reach your private network. That's by design.
