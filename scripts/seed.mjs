// Demo data for local development and screenshots: `npm run seed`.
// Prints SQL that REPLACES everything in your local database. It never touches the remote one.
import { parseCurl } from "../src/curl.ts";

const now = Date.now();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
const user = "dev@localhost";
const out = ["DELETE FROM checks;", "DELETE FROM events;", "DELETE FROM monitors;", "DELETE FROM project_channels;", "DELETE FROM channels;", "DELETE FROM projects;", "DELETE FROM expiry;", "DELETE FROM maintenance;", "DELETE FROM incidents;"];

// Deterministic randomness, so screenshots look the same every time.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const channels = [
  { id: "ch_chat", name: "#ops-alerts", type: "google_chat", config: JSON.stringify({ url: "https://chat.googleapis.com/v1/spaces/DEMO/messages?key=demo" }) },
  { id: "ch_tg", name: "On-call", type: "telegram", config: JSON.stringify({ token: "123456:DEMO_TOKEN_DO_NOT_USE_xxxxxxxx", chat_id: "-1001234567890" }) },
];
for (const c of channels) out.push(insert("channels", { ...c, created_by: user, created_at: now - 20 * DAY }));

const projects = [
  { id: "p_store", name: "Storefront", description: "shop.example.com · web and checkout", status_slug: "storefront", remind_min: 30, escalate_min: 60, escalate_to: '["ch_tg"]' },
  { id: "p_auth", name: "Auth platform", description: "Login, tokens and SSO", remind_min: 15, escalate_min: 0, escalate_to: "[]" },
  { id: "p_jobs", name: "Data jobs", description: "Nightly backups and exports", remind_min: 0, escalate_min: 0, escalate_to: "[]" },
];
for (const p of projects) {
  out.push(insert("projects", { ...p, created_by: user, created_at: now - 20 * DAY }));
  for (const c of channels) out.push(insert("project_channels", { project_id: p.id, channel_id: c.id }));
}

// base: typical latency. incidents: [hoursAgo, minutes, error]. slow: [hoursAgo, minutes] with doubled latency.
const monitors = [
  { id: "m_home", project: "p_store", name: "Homepage", curl: "curl -L https://shop.example.com/", base: 180 },
  { id: "m_checkout", project: "p_store", name: "Checkout API", public_name: "Checkout", curl: `curl -X POST https://api.shop.example.com/v2/checkout/health -H 'Authorization: Bearer sk_live_demo' --json '{"dry_run":true}'`,
    base: 420, slow_ms: 1500, incidents: [[6, 22, "Expected status 200-399, got 502"]], slow: [[14, 40]] },
  { id: "m_search", project: "p_store", name: "Search API", public_name: "Search", curl: "curl https://search.shop.example.com/v1/query?q=shoes -H 'x-api-key: demo'", base: 240,
    down: { since: 18, error: "Expected status 200-399, got 503" } },
  { id: "m_cdn", project: "p_store", name: "Product images (CDN)", public_name: "Product images", curl: "curl -I https://cdn.shop.example.com/img/hero.webp", base: 45, regions: 1 },
  { id: "m_login", project: "p_auth", name: "Login page", curl: "curl -L https://auth.example.com/login", base: 210, keyword: "Sign in" },
  { id: "m_token", project: "p_auth", name: "Token endpoint", curl: "curl https://auth.example.com/api/me -H 'Authorization: Bearer {{token}}'", base: 160,
    steps: [{ name: "Log in", curl: `curl https://auth.example.com/oauth/token --json '{"grant_type":"client_credentials"}'`, vars: [["token", "$.access_token"]] }] },
  { id: "m_jwks", project: "p_auth", name: "JWKS", curl: "curl https://auth.example.com/.well-known/jwks.json", base: 70, regions: 1, incidents: [[30, 9, "Timed out after 10s"]] },
  { id: "m_backup", project: "p_jobs", name: "Nightly backup", type: "heartbeat", interval: 3600 },
  { id: "m_export", project: "p_jobs", name: "Analytics export", type: "heartbeat", interval: 900 },
];

const HB_REQUEST = JSON.stringify({ method: "", url: "", headers: [], body: null, followRedirects: false });
const okHeaders = [["content-type", "application/json"], ["server", "cloudflare"], ["cache-control", "no-store"], ["cf-ray", "8f1c2a7b9d3e4f10-SIN"]];

for (const m of monitors) {
  const hb = m.type === "heartbeat";
  const interval = m.interval ?? 300;
  const steps = (m.steps ?? []).map((s) => ({ name: s.name, curl: s.curl, request: JSON.stringify(parseCurl(s.curl)), vars: s.vars }));
  const step = hb ? interval * 1000 : 5 * MIN; // history resolution
  let lastOk = null, last = null;
  const rows = []; // checks and events, written after their monitor

  for (let t = now - DAY - 6 * HOUR; t <= now - 30_000; t += step) {
    const hoursAgo = (now - t) / HOUR;
    const inc = (m.incidents ?? []).find(([h, mins]) => hoursAgo <= h && hoursAgo > h - mins / 60);
    const isDown = inc || (m.down && hoursAgo <= m.down.since / 60);
    const isSlow = (m.slow ?? []).some(([h, mins]) => hoursAgo <= h && hoursAgo > h - mins / 60);
    const wave = 1 + 0.25 * Math.sin(t / (3 * HOUR)) + rand() * 0.35 + (rand() < 0.02 ? 1.5 : 0);
    const latency = hb ? null : Math.round(m.base * wave * (isSlow ? 4.5 : 1));
    const error = isDown ? (inc ? inc[2] : m.down.error) : null;
    const code = hb ? null : isDown ? (error.includes("Timed out") ? null : Number(error.slice(-3))) : m.curl.includes("-I") ? 200 : 200;
    let detail = null;
    if (isDown && !hb) {
      detail = JSON.stringify({
        preview: { status_text: "Service Unavailable", headers: [["content-type", "text/html"], ["server", "nginx/1.25.3"], ["retry-after", "30"], ["x-request-id", "req_7Hk2LmQ9"]],
          body: "<html>\n<head><title>503 Service Temporarily Unavailable</title></head>\n<body>\n<h1>503 Service Temporarily Unavailable</h1>\n<p>upstream search-7f9c is not responding</p>\n</body>\n</html>", size: 198 },
        attempts: [{ ok: false, status_code: 503, latency_ms: 31, error }, { ok: false, status_code: 503, latency_ms: 28, error }],
        dns: { status: "NOERROR", records: [{ type: "CNAME", data: "search-lb.shop.example.com.", ttl: 300 }, { type: "A", data: "203.0.113.24", ttl: 60 }] },
        summary: "The load balancer answers but its upstream (search-7f9c) is down, so nginx returns 503. Check the search service's pods or recent deploys first.",
        last_ok: lastOk,
      });
    } else if (!hb) {
      lastOk = { ts: t, status_code: 200, status_text: "OK", headers: okHeaders, size: 87,
        body: JSON.stringify({ status: "ok", results: 128, took_ms: 41, region: "ap-southeast-1" }, null, 2) };
    }
    rows.push(insert("checks", { monitor_id: m.id, ts: t, ok: isDown ? 0 : 1, status_code: code, latency_ms: latency ?? (hb ? null : 0), error, detail }));
    last = { t, isDown, latency, error };
  }

  // Events: incident starts and recoveries, plus a slow spell and an acknowledgement.
  for (const [h, mins, error] of m.incidents ?? []) {
    rows.push(insert("events", { monitor_id: m.id, ts: now - h * HOUR, status: "down", error }));
    rows.push(insert("events", { monitor_id: m.id, ts: now - h * HOUR + mins * MIN, status: "up", error: null }));
  }
  for (const [h, mins] of m.slow ?? []) {
    rows.push(insert("events", { monitor_id: m.id, ts: now - h * HOUR + 5 * MIN, status: "slow", error: null }));
    rows.push(insert("events", { monitor_id: m.id, ts: now - h * HOUR + mins * MIN, status: "fast", error: null }));
  }
  const downSince = m.down ? now - m.down.since * MIN : null;
  if (m.down) {
    rows.push(insert("events", { monitor_id: m.id, ts: downSince, status: "down", error: m.down.error,
      summary: "The load balancer answers but its upstream (search-7f9c) is down, so nginx returns 503. Check the search service's pods or recent deploys first." }));
    rows.push(insert("events", { monitor_id: m.id, ts: downSince + 6 * MIN, status: "ack", actor: "priya@example.com" }));
  }

  const request = hb ? HB_REQUEST : JSON.stringify(parseCurl(m.curl));
  out.push(insert("monitors", {
    id: m.id, project_id: m.project, type: hb ? "heartbeat" : "http", name: m.name, curl: m.curl ?? "", request,
    steps: JSON.stringify(steps), regions: m.regions ?? 0, slow_ms: m.slow_ms ?? 0, interval_sec: interval, timeout_ms: 10_000,
    expected_status: "200-399", keyword: m.keyword ?? "", paused: 0, public_name: m.public_name ?? "", status: last.isDown ? "down" : "up",
    last_checked_at: last.t, last_latency_ms: last.latency, last_error: last.error, last_ok: lastOk && JSON.stringify(lastOk),
    next_check_at: now + 30 * DAY, // demo data: keep the cron from checking these made-up URLs
    token: hb ? (m.id === "m_backup" ? "a1b2c3d4e5f6a7b8c9d0e1f2" : "f2e1d0c9b8a7f6e5d4c3b2a1") : null,
    last_ping_at: hb ? now - 12 * MIN : null, down_since: downSince,
    acked_by: m.down ? "priya@example.com" : null, acked_at: m.down ? downSince + 6 * MIN : null,
    created_by: user, created_at: now - 20 * DAY,
  }), ...rows);
}

out.push(insert("expiry", { host: "api.shop.example.com", kind: "ssl", expires_at: now + 54 * DAY, checked_at: now, error: null, warned: 0 }));
out.push(insert("expiry", { host: "example.com", kind: "domain", expires_at: now + 212 * DAY, checked_at: now, error: null, warned: 0 }));
out.push(insert("maintenance", { id: "w_db", project_id: "p_auth", title: "Database upgrade", starts_at: now + 2 * DAY, ends_at: now + 2 * DAY + 2 * HOUR, repeat: "weekly", created_by: user, created_at: now }));
// Status page incidents on Storefront: one open, one resolved yesterday.
const incident = (id, title, impact, updates, resolved) => {
  out.push(insert("incidents", { id, project_id: "p_store", title, impact, created_by: user, created_at: now - updates[0][0] * MIN, resolved_at: resolved ? now - updates.at(-1)[0] * MIN : null }));
  for (const [ago, status, message] of updates) out.push(insert("incident_updates", { incident_id: id, ts: now - ago * MIN, status, message, author: "priya@example.com" }));
};
incident("i_search", "Search results are not loading", "minor", [
  [17 * 60, "investigating", "Search is returning errors. Browsing and checkout work normally."],
  [16 * 60, "identified", "A search index rebuild is stuck. We're restarting it; results may be stale until it finishes."],
]);
incident("i_checkout", "Some payments failed", "major", [
  [6 * 60 + 25, "investigating", "Some checkouts are failing with an error. We're looking into it."],
  [6 * 60 + 10, "monitoring", "We rolled back a payment provider change. Checkouts are going through again."],
  [5 * 60 + 40, "resolved", "Fixed. Orders that failed between 09:35 and 09:57 were not charged."],
], true);
console.log(out.join("\n"));
