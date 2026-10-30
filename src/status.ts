// Public status page for a project, at /status/<slug>. Server-rendered, no login, no JavaScript needed.
// Shows monitor names and up/down history only: never URLs, errors or response bodies, which can leak internals.
import { occurrence, type Window } from "./jobs.ts";

const DAY = 86_400_000;
const DAYS = 30;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (v: number) => `${(Math.floor(v * 10000) / 100).toFixed(v >= 1 ? 0 : 2)}%`;
const time = (ts: number) => `<time datetime="${new Date(ts).toISOString()}">${new Date(ts).toUTCString().slice(5, 22)} UTC</time>`;
const day = (d: number) => new Date(d * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function took(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.round(m / 1440)}d`;
}

interface Data {
  project: { name: string; description: string };
  monitors: { id: string; name: string; status: string }[];
  days: { monitor_id: string; day: number; up: number; n: number }[];
  events: { monitor_id: string; ts: number; status: string }[];
  windows: Window[];
}

export async function loadStatus(db: D1Database, slug: string, now: number): Promise<Data | null> {
  const p = await db.prepare("SELECT id, name, description FROM projects WHERE status_slug = ?").bind(slug).first<{ id: string; name: string; description: string }>();
  if (!p) return null;
  const since = (Math.floor(now / DAY) - DAYS + 1) * DAY;
  // ponytail: aggregates raw checks on every view (cached 60s). Fine for thousands of checks a day; keep daily rollups if pages get slow.
  const [monitors, days, events, windows] = await db.batch([
    db.prepare("SELECT id, name, status FROM monitors WHERE project_id = ? AND paused = 0 ORDER BY name COLLATE NOCASE").bind(p.id),
    db.prepare(`
      SELECT c.monitor_id, c.ts / ${DAY} AS day, AVG(c.ok) AS up, COUNT(*) AS n FROM checks c JOIN monitors m ON m.id = c.monitor_id
      WHERE m.project_id = ? AND m.paused = 0 AND c.ts >= ? GROUP BY c.monitor_id, day`).bind(p.id, since),
    db.prepare(`
      SELECT e.monitor_id, e.ts, e.status FROM events e JOIN monitors m ON m.id = e.monitor_id
      WHERE m.project_id = ? AND m.paused = 0 AND e.status IN ('down', 'up') AND e.ts > ? ORDER BY e.ts`).bind(p.id, now - 14 * DAY),
    db.prepare("SELECT * FROM maintenance WHERE project_id = ?").bind(p.id),
  ]);
  return {
    project: p,
    monitors: monitors.results as Data["monitors"],
    days: days.results as Data["days"],
    events: events.results as Data["events"],
    windows: windows.results as unknown as Window[],
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

export function renderStatus(d: Data, now: number): string {
  const names = new Map(d.monitors.map((m) => [m.id, m.name]));
  const windows = d.windows.map((w) => ({ w, o: occurrence(w, now) })).filter((x) => x.o) as { w: Window; o: { start: number; end: number } }[];
  const active = windows.filter((x) => x.o.start <= now);
  const upcoming = windows.filter((x) => x.o.start > now && x.o.start - now < 7 * DAY).sort((a, b) => a.o.start - b.o.start);
  const down = d.monitors.filter((m) => m.status === "down").length;

  const [tone, headline] = active.length ? ["maint", "Scheduled maintenance in progress"]
    : !down ? ["up", "All systems operational"]
    : down === d.monitors.length ? ["down", "Major outage"]
    : ["partial", `${down === 1 ? "1 system" : `${down} systems`} down`];

  const today = Math.floor(now / DAY);
  const rows = d.monitors.map((m) => {
    const byDay = new Map(d.days.filter((x) => x.monitor_id === m.id).map((x) => [x.day, x]));
    const total = [...byDay.values()].reduce((a, x) => a + x.n, 0);
    const uptime = total ? [...byDay.values()].reduce((a, x) => a + x.up * x.n, 0) / total : null;
    const bars = Array.from({ length: DAYS }, (_, i) => {
      const dd = today - DAYS + 1 + i, x = byDay.get(dd);
      const cls = !x ? "none" : x.up >= 0.999 ? "up" : x.up >= 0.98 ? "partial" : "down";
      return `<i class="${cls}" title="${day(dd)} · ${x ? pct(x.up) : "No data"}"></i>`;
    }).join("");
    const state = active.length ? "maint" : m.status === "down" ? "down" : m.status === "up" ? "up" : "none";
    const label = { maint: "Maintenance", down: "Down", up: "Operational", none: "Pending" }[state];
    return `<section class="mon">
      <div class="mon-head"><span class="name">${esc(m.name)}</span><span class="state ${state}">${label}</span></div>
      <div class="bars">${bars}</div>
      <div class="legend"><span>${DAYS} days ago</span><span>${uptime == null ? "" : `${pct(uptime)} uptime`}</span><span>Today</span></div>
    </section>`;
  }).join("");

  const maint = [...active, ...upcoming].map(({ w, o }) => `<li><b>${esc(w.title)}</b><span>${o.start <= now ? `Until ${time(o.end)}` : `${time(o.start)} to ${time(o.end)}`}${w.repeat === "none" ? "" : ` · repeats ${w.repeat}`}</span></li>`).join("");
  const past = incidents(d.events, names).slice(0, 20).map((i) => `<li>
      <b>${esc(i.name)} ${i.end ? "was down" : "is down"}</b>
      <span>${time(i.start)}${i.end ? ` · resolved after ${took(i.end - i.start)}` : " · investigating"}</span></li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(d.project.name)} status</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${{ up: "#2f9e5b", partial: "#e0a030", down: "#d64545", maint: "#4a7fd4" }[tone]}"/></svg>`)}">
<style>
  :root { --bg: #fffaf4; --card: #fff; --text: #3b2418; --muted: #8a7363; --line: #f0e3d3; --none: #eadfd2;
    --up: #2f9e5b; --partial: #e0a030; --down: #d64545; --maint: #4a7fd4; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1511; --card: #271d17; --text: #f6e9dc; --muted: #b29c8a; --line: #3a2c23; --none: #3a2c23; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 16px 56px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 10px; }
  .sub { color: var(--muted); margin: 0; }
  .banner { margin: 24px 0; padding: 16px 20px; border-radius: 12px; color: #fff; font-weight: 600; font-size: 17px; background: var(--${tone}); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
  .card + .card { margin-top: 16px; }
  .mon { padding: 16px 20px; border-top: 1px solid var(--line); }
  .mon:first-child { border-top: 0; }
  .mon-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .state { font-size: 13px; font-weight: 600; white-space: nowrap; }
  .state.up { color: var(--up); } .state.down { color: var(--down); } .state.maint { color: var(--maint); } .state.none { color: var(--muted); }
  .bars { display: flex; gap: 2px; height: 30px; }
  .bars i { flex: 1; border-radius: 2px; background: var(--none); }
  .bars i.up { background: var(--up); } .bars i.partial { background: var(--partial); } .bars i.down { background: var(--down); }
  .legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 12px 20px; border-top: 1px solid var(--line); display: flex; flex-direction: column; }
  li:first-child { border-top: 0; }
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
  <div class="banner">${headline}</div>
  ${maint ? `<h2>Maintenance</h2><ul class="card">${maint}</ul>` : ""}
  <div class="card">${rows || `<p class="empty">No monitors yet.</p>`}</div>
  <h2>Past incidents</h2>
  ${past ? `<ul class="card">${past}</ul>` : `<div class="card empty">No incidents in the last 14 days.</div>`}
  <footer>Updated ${time(now)} · Powered by <a href="https://github.com/Compile7/curldog">CurlDog</a></footer>
</main>
<script>for (const t of document.querySelectorAll("time")) t.textContent = new Date(t.dateTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });</script>
</body>
</html>`;
}
