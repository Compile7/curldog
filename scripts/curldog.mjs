#!/usr/bin/env node
// Monitors as code. Keep curldog.json in git and apply it from CI.
//
//   node scripts/curldog.mjs pull > curldog.json     export what's live now
//   node scripts/curldog.mjs plan curldog.json       show what apply would change
//   node scripts/curldog.mjs apply curldog.json      create and update (add --prune to delete unlisted monitors)
//
// Env: CURLDOG_URL, plus CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET from a Cloudflare Access service token.
// ${NAME} in the file is replaced with the environment variable NAME, so secrets can stay out of git.
import { readFileSync } from "node:fs";

const [cmd, file] = process.argv.slice(2);
const base = process.env.CURLDOG_URL?.replace(/\/$/, "");
if (!base || !["pull", "plan", "apply"].includes(cmd) || (cmd !== "pull" && !file)) {
  console.error("Usage: CURLDOG_URL=https://… node scripts/curldog.mjs pull | plan <file> | apply <file> [--prune]");
  process.exit(2);
}

const headers = {
  "content-type": "application/json",
  "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID ?? "",
  "cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET ?? "",
};

async function call(method, body) {
  const res = await fetch(`${base}/api/config`, { method, headers, body: body && JSON.stringify(body), redirect: "manual" });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const why = res.status >= 300 && res.status < 400 ? "Cloudflare Access redirected to a login page. Check the service token and that the app's policy allows it (Service Auth)." : data?.error ?? `HTTP ${res.status}`;
    console.error(`Failed: ${why}`);
    process.exit(1);
  }
  return data;
}

if (cmd === "pull") {
  console.log(JSON.stringify(await call("GET"), null, 2));
} else {
  const text = readFileSync(file, "utf8").replace(/\$\{(\w+)\}/g, (m, name) => {
    if (process.env[name] === undefined) { console.error(`${file} uses \${${name}}, but it isn't set.`); process.exit(1); }
    return JSON.stringify(process.env[name]).slice(1, -1);
  });
  const config = JSON.parse(text);
  const out = await call("PUT", { ...config, dry_run: cmd === "plan", prune: process.argv.includes("--prune") });
  console.log(out.changes.length ? out.changes.join("\n") : "No changes.");
  if (cmd === "apply") for (const h of out.heartbeats) console.log(`Ping URL for ${h.project} / ${h.monitor}: ${h.ping}`);
  if (cmd === "plan" && out.changes.length) console.log("\nRun apply to make these changes.");
}
