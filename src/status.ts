// Public status page for a project, at /status/<slug>, plus feed.atom, status.json and badge.svg next to it.
// Server-rendered, no login. Shows public monitor names, up/down history and incidents people wrote:
// never URLs, errors, response bodies or who posted, which can leak internals.
import { occurrence, type Window } from "./jobs.ts";

const DAY = 86_400_000;
const DAYS = 30;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (v: number) => `${(Math.floor(v * 10000) / 100).toFixed(v >= 1 ? 0 : 2)}%`;
const iso = (ts: number) => new Date(ts).toISOString();
const time = (ts: number) => `<time datetime="${iso(ts)}">${new Date(ts).toUTCString().slice(5, 22)} UTC</time>`;
const day = (d: number) => new Date(d * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function took(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.round(m / 1440)}d`;
}

export interface Incident {
  id: string;
  title: string;
  impact: "minor" | "major";
  created_at: number;
  resolved_at: number | null;
  updates: { ts: number; status: string; message: string; author?: string }[]; // newest first
}

// Open incidents, and ones resolved after ?2. Shared with the app's project view.
export const incidentsSql = (env: { DB: D1Database }) => env.DB.prepare(`
  SELECT i.id, i.title, i.impact, i.created_at, i.resolved_at,
    (SELECT json_group_array(json_object('ts', u.ts, 'status', u.status, 'message', u.message, 'author', u.author))
      FROM (SELECT * FROM incident_updates WHERE incident_id = i.id ORDER BY ts DESC) u) AS updates
  FROM incidents i WHERE i.project_id = ?1 AND (i.resolved_at IS NULL OR i.resolved_at > ?2) ORDER BY i.created_at DESC`);

export const parseIncidents = (rows: unknown[]) =>
  (rows as (Omit<Incident, "updates"> & { updates: string })[]).map((r) => ({ ...r, updates: JSON.parse(r.updates) }) as Incident);

interface Data {
  project: { name: string; description: string };
  monitors: { id: string; name: string; status: string; slow: number }[];
  days: { monitor_id: string; day: number; up: number; n: number }[];
  events: { monitor_id: string; ts: number; status: string }[];
  windows: Window[];
  incidents: Incident[];
}

export async function loadStatus(db: D1Database, slug: string, now: number): Promise<Data | null> {
  const p = await db.prepare("SELECT id, name, description FROM projects WHERE status_slug = ?").bind(slug).first<{ id: string; name: string; description: string }>();
  if (!p) return null;
  const since = (Math.floor(now / DAY) - DAYS + 1) * DAY;
  const shown = "m.project_id = ?1 AND m.paused = 0 AND m.on_status = 1";
  // ponytail: aggregates raw checks on every view (cached 60s). Fine for thousands of checks a day; keep daily rollups if pages get slow.
  const [monitors, days, events, windows, incidents] = await db.batch([
    db.prepare(`SELECT m.id, CASE WHEN m.public_name != '' THEN m.public_name ELSE m.name END AS name, m.status, m.slow
      FROM monitors m WHERE ${shown} ORDER BY 2 COLLATE NOCASE`).bind(p.id),
    db.prepare(`
      SELECT c.monitor_id, c.ts / ${DAY} AS day, AVG(c.ok) AS up, COUNT(*) AS n FROM checks c JOIN monitors m ON m.id = c.monitor_id
      WHERE ${shown} AND c.ts >= ?2 GROUP BY c.monitor_id, day`).bind(p.id, since),
    db.prepare(`
      SELECT e.monitor_id, e.ts, e.status FROM events e JOIN monitors m ON m.id = e.monitor_id
      WHERE ${shown} AND e.status IN ('down', 'up') AND e.ts > ?2 ORDER BY e.ts`).bind(p.id, now - 14 * DAY),
    db.prepare("SELECT * FROM maintenance WHERE project_id = ?").bind(p.id),
    incidentsSql({ DB: db }).bind(p.id, now - 14 * DAY),
  ]);
  return {
    project: p,
    monitors: monitors.results as Data["monitors"],
    days: days.results as Data["days"],
    events: events.results as Data["events"],
    windows: windows.results as unknown as Window[],
    incidents: parseIncidents(incidents.results),
  };
}

// Pairs each down event with the recovery that followed it.
export function incidents(events: Data["events"], names: Map<string, string>) {
  const open = new Map<string, number>();
  const out: { name: string; start: number; end: number | null }[] = [];
  for (const e of events) {
    if (e.status === "down") open.set(e.monitor_id, e.ts);
    else if (open.has(e.monitor_id)) { out.push({ name: names.get(e.monitor_id) ?? "", start: open.get(e.monitor_id)!, end: e.ts }); open.delete(e.monitor_id); }
  }
  for (const [id, start] of open) out.push({ name: names.get(id) ?? "", start, end: null });
  return out.sort((a, b) => b.start - a.start);
}

type Tone = "up" | "maint" | "degraded" | "partial" | "down";
const RANK: Tone[] = ["up", "maint", "degraded", "partial", "down"];
const HEADLINE: Record<Tone, string> = {
  up: "All systems operational", maint: "Scheduled maintenance in progress", degraded: "Degraded performance",
  partial: "Partial outage", down: "Major outage",
};
const STATE: Record<string, [string, string]> = { // monitor state: label, Statuspage-style component status
  up: ["Operational", "operational"], degraded: ["Degraded", "degraded_performance"], down: ["Down", "major_outage"],
  maint: ["Maintenance", "under_maintenance"], none: ["Pending", "pending"],
};
const UPDATE_LABEL: Record<string, string> = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };
const COLOR: Record<Tone, string> = { up: "#2f9e5b", maint: "#4a7fd4", degraded: "#e0a030", partial: "#e0a030", down: "#d64545" };

// Overall state, from what monitors see and what people posted. The worse one wins.
export function summarize(d: Data, now: number) {
  const windows = d.windows.map((w) => ({ w, o: occurrence(w, now) })).filter((x) => x.o) as { w: Window; o: { start: number; end: number } }[];
  const maint = windows.some((x) => x.o.start <= now);
  const monitors = d.monitors.map((m) => ({
    ...m, state: maint ? "maint" : m.status === "down" ? "down" : m.status !== "up" ? "none" : m.slow ? "degraded" : "up",
  }));
  const down = monitors.filter((m) => m.state === "down").length;
  const auto: Tone = maint ? "maint" : !down ? (monitors.some((m) => m.state === "degraded") ? "degraded" : "up")
    : down === monitors.length ? "down" : "partial";
  const open = d.incidents.filter((i) => !i.resolved_at);
  const posted: Tone = open.some((i) => i.impact === "major") ? "down" : open.length ? "partial" : "up";
  const tone = RANK[Math.max(RANK.indexOf(auto), RANK.indexOf(posted))];
  return { tone, headline: HEADLINE[tone], monitors, windows, open };
}

function updatesHtml(i: Incident) {
  return `<ol class="updates">${i.updates.map((u) => `<li><b>${UPDATE_LABEL[u.status] ?? esc(u.status)}</b><p>${esc(u.message)}</p><span>${time(u.ts)}</span></li>`).join("")}</ol>`;
}

export function renderStatus(d: Data, now: number, base = ""): string {
  const s = summarize(d, now);
  const names = new Map(d.monitors.map((m) => [m.id, m.name]));
  const upcoming = s.windows.filter((x) => x.o.start > now && x.o.start - now < 7 * DAY).sort((a, b) => a.o.start - b.o.start);
  const active = s.windows.filter((x) => x.o.start <= now);

  const today = Math.floor(now / DAY);
  const rows = s.monitors.map((m) => {
    const byDay = new Map(d.days.filter((x) => x.monitor_id === m.id).map((x) => [x.day, x]));
    const total = [...byDay.values()].reduce((a, x) => a + x.n, 0);
    const uptime = total ? [...byDay.values()].reduce((a, x) => a + x.up * x.n, 0) / total : null;
    const bars = Array.from({ length: DAYS }, (_, i) => {
      const dd = today - DAYS + 1 + i, x = byDay.get(dd);
      const cls = !x ? "none" : x.up >= 0.999 ? "up" : x.up >= 0.98 ? "partial" : "down";
      return `<i class="${cls}" title="${day(dd)} · ${x ? pct(x.up) : "No data"}"></i>`;
    }).join("");
    return `<section class="mon">
      <div class="mon-head"><span class="name">${esc(m.name)}</span><span class="state ${m.state}">${STATE[m.state][0]}</span></div>
      <div class="bars">${bars}</div>
      <div class="legend"><span>${DAYS} days ago</span><span>${uptime == null ? "" : `${pct(uptime)} uptime`}</span><span>Today</span></div>
    </section>`;
  }).join("");

  const openHtml = s.open.map((i) => `<section class="card incident ${i.impact}"><h3>${esc(i.title)}</h3>${updatesHtml(i)}</section>`).join("");
  const maint = [...active, ...upcoming].map(({ w, o }) => `<li><b>${esc(w.title)}</b><span>${o.start <= now ? `Until ${time(o.end)}` : `${time(o.start)} to ${time(o.end)}`}${w.repeat === "none" ? "" : ` · repeats ${w.repeat}`}</span></li>`).join("");
  // Past: incidents people wrote, plus outages the monitors caught on their own.
  const past = [
    ...d.incidents.filter((i) => i.resolved_at).map((i) => ({ start: i.created_at, html: `<li><b>${esc(i.title)}</b>${updatesHtml(i)}</li>` })),
    ...incidents(d.events, names).map((i) => ({ start: i.start, html: `<li>
      <b>${esc(i.name)} ${i.end ? "was down" : "is down"}</b>
      <span>${time(i.start)}${i.end ? ` · resolved after ${took(i.end - i.start)}` : " · investigating"}</span></li>` })),
  ].sort((a, b) => b.start - a.start).slice(0, 20).map((x) => x.html).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(d.project.name)} status</title>
<link rel="alternate" type="application/atom+xml" title="${esc(d.project.name)} status" href="${base}/feed.atom">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${COLOR[s.tone]}"/></svg>`)}">
<style>
  :root { --bg: #fffaf4; --card: #fff; --text: #3b2418; --muted: #8a7363; --line: #f0e3d3; --none: #eadfd2;
    --up: #2f9e5b; --partial: #e0a030; --degraded: #e0a030; --down: #d64545; --maint: #4a7fd4; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1511; --card: #271d17; --text: #f6e9dc; --muted: #b29c8a; --line: #3a2c23; --none: #3a2c23; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 16px 56px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 10px; }
  h3 { font-size: 16px; margin: 0 0 8px; }
  .sub { color: var(--muted); margin: 0; }
  .banner { margin: 24px 0; padding: 16px 20px; border-radius: 12px; color: #fff; font-weight: 600; font-size: 17px; background: var(--${s.tone}); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
  .card + .card { margin-top: 16px; }
  .incident { padding: 16px 20px; border-left: 4px solid var(--partial); margin-bottom: 16px; }
  .incident.major { border-left-color: var(--down); }
  .updates { list-style: none; margin: 0; padding: 0; }
  .updates li { padding: 8px 0 0; border: 0; display: block; }
  .updates p { display: inline; margin: 0 0 0 6px; white-space: pre-line; overflow-wrap: anywhere; }
  .updates span { display: block; }
  .mon { padding: 16px 20px; border-top: 1px solid var(--line); }
  .mon:first-child { border-top: 0; }
  .mon-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .state { font-size: 13px; font-weight: 600; white-space: nowrap; }
  .state.up { color: var(--up); } .state.down { color: var(--down); } .state.maint { color: var(--maint); }
  .state.degraded { color: var(--degraded); } .state.none { color: var(--muted); }
  .bars { display: flex; gap: 2px; height: 30px; }
  .bars i { flex: 1; border-radius: 2px; background: var(--none); }
  .bars i.up { background: var(--up); } .bars i.partial { background: var(--partial); } .bars i.down { background: var(--down); }
  .legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  ul > li { padding: 12px 20px; border-top: 1px solid var(--line); display: flex; flex-direction: column; }
  ul > li:first-child { border-top: 0; }
  li span { color: var(--muted); font-size: 13px; }
  .empty { padding: 16px 20px; color: var(--muted); }
  footer { margin-top: 40px; text-align: center; color: var(--muted); font-size: 13px; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${esc(d.project.name)}</h1>
  ${d.project.description ? `<p class="sub">${esc(d.project.description)}</p>` : ""}
  <div class="banner">${s.headline}</div>
  ${openHtml}
  ${maint ? `<h2>Maintenance</h2><ul class="card">${maint}</ul>` : ""}
  <div class="card">${rows || `<p class="empty">No monitors yet.</p>`}</div>
  <h2>Past incidents</h2>
  ${past ? `<ul class="card">${past}</ul>` : `<div class="card empty">No incidents in the last 14 days.</div>`}
  <footer>Updated ${time(now)} · <a href="${base}/feed.atom">Subscribe (RSS)</a> · Powered by <a href="https://github.com/Compile7/curldog">CurlDog</a></footer>
</main>
<script>for (const t of document.querySelectorAll("time")) t.textContent = new Date(t.dateTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });</script>
</body>
</html>`;
}

// Atom feed: one entry per written incident and per outage the monitors caught. Feed readers and Slack's RSS app follow it.
export function renderFeed(d: Data, now: number, base: string): string {
  const names = new Map(d.monitors.map((m) => [m.id, m.name]));
  const entry = (id: string, title: string, updated: number, text: string) =>
    `<entry><id>${esc(id)}</id><title>${esc(title)}</title><updated>${iso(updated)}</updated><link href="${esc(base)}"/><content type="text">${esc(text)}</content></entry>`;
  const entries = [
    ...d.incidents.map((i) => ({
      ts: i.updates[0]?.ts ?? i.created_at,
      xml: entry(`${base}#incident-${i.id}`, i.title, i.updates[0]?.ts ?? i.created_at,
        i.updates.map((u) => `${UPDATE_LABEL[u.status] ?? u.status} (${iso(u.ts)}): ${u.message}`).join("\n\n")),
    })),
    ...incidents(d.events, names).map((i) => ({
      ts: i.end ?? i.start,
      xml: entry(`${base}#outage-${encodeURIComponent(i.name)}-${i.start}`, `${i.name} ${i.end ? "was down" : "is down"}`, i.end ?? i.start,
        i.end ? `Down from ${iso(i.start)} to ${iso(i.end)} (${took(i.end - i.start)}).` : `Down since ${iso(i.start)}.`),
    })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 50);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${esc(base)}</id><title>${esc(d.project.name)} status</title><author><name>${esc(d.project.name)}</name></author>
<updated>${iso(entries[0]?.ts ?? now)}</updated><link href="${esc(base)}"/><link rel="self" href="${esc(base)}/feed.atom"/>
${entries.map((e) => e.xml).join("\n")}
</feed>`;
}

// Machine-readable status, shaped like Atlassian Statuspage's so existing tools can read it.
export function statusJson(d: Data, now: number, base: string) {
  const s = summarize(d, now);
  const indicator = { up: "none", maint: "maintenance", degraded: "minor", partial: "major", down: "critical" }[s.tone];
  return {
    page: { name: d.project.name, url: base, updated_at: iso(now) },
    status: { indicator, description: s.headline },
    components: s.monitors.map((m) => ({ name: m.name, status: STATE[m.state][1] })),
    incidents: s.open.map((i) => ({
      name: i.title, impact: i.impact, status: i.updates[0]?.status, created_at: iso(i.created_at),
      updates: i.updates.map((u) => ({ status: u.status, body: u.message, created_at: iso(u.ts) })),
    })),
  };
}

// Shields-style badge for READMEs: [ status | operational ].
export function badge(d: Data, now: number): string {
  const s = summarize(d, now);
  const text = { up: "operational", maint: "maintenance", degraded: "degraded", partial: "partial outage", down: "major outage" }[s.tone];
  const w1 = 48, w2 = Math.round(text.length * 6.6) + 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w1 + w2}" height="20" role="img" aria-label="status: ${text}">
<title>status: ${text}</title><clipPath id="r"><rect width="${w1 + w2}" height="20" rx="3"/></clipPath>
<g clip-path="url(#r)"><rect width="${w1}" height="20" fill="#555"/><rect x="${w1}" width="${w2}" height="20" fill="${COLOR[s.tone]}"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${w1 / 2}" y="14">status</text><text x="${w1 + w2 / 2}" y="14">${text}</text></g></svg>`;
}
