// Moniwork UI. No framework, no build step.
import { convertKuma, groupByDomain } from "./kuma.js";

const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");
const modal = $("#modal");
const DAY = 86_400_000;
const INTERVALS = [[60, "1m"], [300, "5m"], [600, "10m"], [900, "15m"], [1800, "30m"], [3600, "1h"]];
const SECRET = /authorization|cookie|token|secret|api[-_]?key|password/i;
const STATUS_LABEL = { up: "Up", down: "Down", pending: "Pending", paused: "Paused" };
const REMIND = [[0, "Off"], [15, "15 min"], [30, "30 min"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"]];
const MUTE = [[30, "30 min"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [480, "8 hours"], [1440, "24 hours"]];

const state = { me: "", projects: [], channels: [], page: {}, filter: { q: "", status: "all" }, chart: null, import: null };

const CHANNEL = {
  google_chat: { label: "Google Chat", icon: "chat", hint: "Post alerts to a Google Chat space." },
  telegram: { label: "Telegram", icon: "send", hint: "Message a Telegram group or chat through your bot." },
  webhook: { label: "Slack / Discord", icon: "link", hint: "Any Slack or Discord incoming webhook." },
};

// ---------- templating: interpolations are escaped unless wrapped in raw() ----------
const RAW = Symbol("raw");
const raw = (s) => ({ [RAW]: String(s) });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const str = (v) => (v == null || v === false ? "" : Array.isArray(v) ? v.map(str).join("") : v[RAW] !== undefined ? v[RAW] : esc(v));
const html = (s, ...v) => raw(s.reduce((a, x, i) => a + x + (i < v.length ? str(v[i]) : ""), ""));

const ICONS = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  play: '<path d="M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  edit: '<path d="M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  grid: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send: '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.03.94l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.93"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  sparkle: '<path d="M9.94 14.06 7 22l-2.94-7.94L-3.88 11.1 4.06 8.16 7 .22l2.94 7.94 7.94 2.94zM20 2v4M22 4h-4"/>',
  turtle: '<path d="M12 10 7 4M12 10l5-6M12 10v8M2 18h20M4 14a8 8 0 0 1 16 0"/>',
  minus: '<path d="M5 12h14"/>',
};
const icon = (name, cls = "") =>
  raw(`<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);

// ---------- formatting ----------
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const ms = (v) => (v == null ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const pct = (v) => (v == null ? "—" : `${(Math.floor(v * 10000) / 100).toFixed(v >= 1 ? 0 : 2)}%`);
const tone = (v) => (v == null ? "" : v >= 0.99 ? "good" : v >= 0.95 ? "warn" : "bad");
const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const stamp = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const every = (s) => (INTERVALS.find(([v]) => v === s) || [0, `${Math.round(s / 60)}m`])[1];
const bytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const initials = (email) => (email || "?").split("@")[0].split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

const statusOf = (m) => (m.paused ? "paused" : m.status);
const dot = (s) => html`<span class="dot ${s}"></span>`;
const pill = (s) => html`<span class="pill ${s}">${dot(s)}${STATUS_LABEL[s]}</span>`;
// URL parsing escapes {{var}} placeholders; show them as typed.
const showUrl = (u) => String(u).replace(/%7B%7B(\w+)%7D%7D/gi, "{{$1}}");
const method = (m) => html`<span class="method m-${m.toLowerCase()}">${m}</span>`;

// ---------- api ----------
async function api(path, { method: verb, body } = {}) {
  const res = await fetch("/api" + path, {
    method: verb || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { setup: data.setup });
  return data;
}

// ---------- router ----------
const routes = [
  [/^\/$/, viewOverview],
  [/^\/projects\/([\w-]+)$/, viewProject],
  [/^\/monitors\/([\w-]+)$/, viewMonitor],
  [/^\/notifications$/, viewNotifications],
];

function navigate(path, replace = false) {
  history[replace ? "replaceState" : "pushState"](null, "", path);
  render();
  window.scrollTo(0, 0);
}

let renderSeq = 0;
async function render({ quiet = false } = {}) {
  const seq = ++renderSeq;
  const route = routes.find(([re]) => re.test(location.pathname));
  if (!route) return navigate("/", true);
  const params = location.pathname.match(route[0]).slice(1);
  if (!quiet) {
    main.innerHTML = str(skeleton());
    document.body.classList.remove("nav-open");
  }
  const projectsP = api("/projects").then((p) => (state.projects = p));
  try {
    const content = await route[1](params, projectsP);
    await projectsP;
    if (seq !== renderSeq) return;
    const keep = snapshot();
    $("#sidebar").innerHTML = str(sidebar());
    main.innerHTML = str(content);
    restore(keep);
  } catch (err) {
    if (seq !== renderSeq || quiet) return;
    await projectsP.catch(() => {});
    $("#sidebar").innerHTML = str(sidebar());
    if (err.setup) return void (main.innerHTML = str(setupView()));
    main.innerHTML = str(html`<div class="empty card"><div class="glyph">${icon("alert")}</div><h2>Couldn't load this page</h2><p>${err.message}</p><a class="btn" href="/">Back to overview</a></div>`);
  }
}

// Background refreshes replace the DOM, so keep focus, caret and open <details> intact.
function snapshot() {
  const a = document.activeElement;
  return {
    id: main.contains(a) && a.id ? a.id : null,
    sel: a && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null,
    open: [...main.querySelectorAll("details[data-key][open]")].map((d) => d.dataset.key),
  };
}
function restore({ id, sel, open }) {
  for (const k of open) main.querySelector(`details[data-key="${k}"]`)?.setAttribute("open", "");
  const el = id && document.getElementById(id);
  if (!el) return;
  el.focus();
  try { if (sel) el.setSelectionRange(...sel); } catch {}
}

// ---------- shared pieces ----------
function sidebar() {
  const pid = state.page.projectId;
  return html`
    <div class="side-head"><a href="/" class="brand"><span class="logo"></span>Moniwork</a></div>
    <nav class="side-nav">
      <a href="/" class="nav-item ${location.pathname === "/" ? "active" : ""}">${icon("grid")}Overview</a>
      <a href="/notifications" class="nav-item ${location.pathname === "/notifications" ? "active" : ""}">${icon("bell")}Notifications</a>
    </nav>
    <div class="side-section">
      <span>Projects</span>
      <button class="btn icon ghost xs" data-action="new-project" data-tip="New project" aria-label="New project">${icon("plus")}</button>
    </div>
    <nav class="side-nav projects">
      ${state.projects.map((p) => html`
        <a href="/projects/${p.id}" class="nav-item ${pid === p.id ? "active" : ""}">
          <span class="dot ${p.down ? "down" : p.up ? "up" : p.pending ? "pending" : "idle"}"></span>
          <span class="truncate">${p.name}</span>
          ${p.down ? html`<span class="badge down" data-tip="${plural(p.down, "monitor")} down">${p.down}</span>` : html`<span class="count">${p.total}</span>`}
        </a>`)}
      ${state.projects.length ? "" : html`<p class="side-empty">No projects yet.</p>`}
    </nav>
    <div class="side-foot">
      <div class="me"><span class="avatar">${initials(state.me)}</span><span class="truncate">${state.me}</span></div>
      <button class="btn icon ghost" data-action="toggle-theme" aria-label="Toggle theme" data-tip="Toggle theme">${icon("sun", "only-dark")}${icon("moon", "only-light")}</button>
    </div>`;
}

function skeleton() {
  return html`
    <div class="skel" style="width:220px;height:28px;margin-bottom:10px"></div>
    <div class="skel" style="width:320px;height:16px;margin-bottom:32px"></div>
    <div class="tiles">${[1, 2, 3, 4].map(() => html`<div class="skel" style="height:78px;border-radius:12px"></div>`)}</div>
    <div class="skel" style="height:320px;border-radius:12px;margin-top:20px"></div>`;
}

const tile = (label, value, cls = "") => html`<div class="tile"><div class="l">${label}</div><div class="v ${cls}">${value}</div></div>`;

// ---------- overview ----------
async function viewOverview(_, projectsP) {
  state.page = {};
  const [d, projects] = await Promise.all([api("/overview"), projectsP]);
  if (!projects.length) return welcome();

  const sum = (k) => projects.reduce((n, p) => n + p[k], 0);
  const total = sum("total"), down = sum("down"), up = sum("up"), paused = sum("paused");
  const active = total - paused;

  return html`
    <header class="page-head">
      <div class="head-main"><h1>Overview</h1><p class="sub">${plural(projects.length, "project")} · ${plural(total, "monitor")}</p></div>
      <div class="actions">
        <button class="btn" data-action="import">${icon("upload")}Import</button>
        <button class="btn" data-action="new-project">${icon("plus")}New project</button>
      </div>
    </header>

    <div class="banner ${down ? "down" : "up"}">
      <div class="orb">${icon(down ? "alert" : "check")}</div>
      <div>
        <strong>${down ? `${plural(down, "monitor")} down` : active ? "All systems operational" : "No active monitors"}</strong>
        <span>${down ? "Failing checks are listed below." : active ? `${plural(up, "monitor")} passing their latest check.` : "Add a monitor to a project to start checking."}</span>
      </div>
    </div>

    <div class="tiles">
      ${tile("Monitors", total)}
      ${tile("Up", up, up ? "good" : "")}
      ${tile("Down", down, down ? "bad" : "")}
      ${tile("Paused", paused)}
    </div>

    ${d.down.length ? html`
      <div class="section-head"><h2>Needs attention</h2></div>
      <div class="card"><div class="list">
        ${d.down.map((m) => html`
          <a class="list-row" href="/monitors/${m.id}">
            ${dot("down")}
            <div class="main-col">
              <span class="t truncate">${m.name} <span class="muted">· ${m.project_name}</span></span>
              <span class="err truncate">${m.last_error}</span>
            </div>
            <span class="muted">${ago(m.last_checked_at)}</span>
            ${icon("chev", "chev")}
          </a>`)}
      </div></div>` : ""}

    <div class="section-head"><h2>Projects</h2></div>
    <div class="grid">${projects.map(projectCard)}</div>

    <div class="section-head"><h2>Recent incidents</h2><span class="muted">Status changes</span></div>
    <div class="card">
      ${d.events.length ? timeline(d.events, true) : html`<div class="empty" style="padding:36px"><p class="muted">No incidents yet. Down and recovery events show up here.</p></div>`}
    </div>`;
}

function projectCard(p) {
  const w = (n) => (p.total ? `${(n / p.total) * 100}%` : "0");
  return html`
    <a class="card project-card" href="/projects/${p.id}">
      <div class="top">${dot(p.down ? "down" : p.up ? "up" : p.pending ? "pending" : "idle")}<h3 class="truncate">${p.name}</h3></div>
      <p>${p.description || "No description"}</p>
      <div class="stack">
        ${p.total
          ? ["up", "down", "pending", "paused"].map((k) => (p[k] ? html`<i class="${k}" style="width:${w(p[k])}"></i>` : ""))
          : ""}
      </div>
      <div class="foot"><span>${plural(p.total, "monitor")}</span>${p.down ? html`<b>${p.down} down</b>` : html`<span>${!p.total ? "Empty" : p.pending ? "Checking…" : "All good"}</span>`}</div>
    </a>`;
}

const EVENT = {
  down: ["arrowDown", "went down"], up: ["arrowUp", "recovered"], ack: ["eye", "acknowledged"],
  slow: ["turtle", "got slow"], fast: ["zap", "back to normal speed"],
};

function timeline(events, withNames) {
  return html`<ul class="timeline">
    ${events.map((e) => html`
      <li>
        <span class="ev-icon ${e.status}">${icon(EVENT[e.status]?.[0] ?? "pulse")}</span>
        <div class="ev-body">
          <div>${withNames ? html`<a href="/monitors/${e.monitor_id}"><b>${e.monitor_name}</b></a> <span class="muted">· ${e.project_name}</span> ` : ""}${e.status === "ack" ? html`<b>${e.actor}</b> acknowledged` : EVENT[e.status]?.[1] ?? e.status}</div>
          ${e.error ? html`<div class="err">${e.error}</div>` : ""}
          ${e.summary ? html`<div class="ev-summary">${icon("sparkle")}${e.summary}</div>` : ""}
        </div>
        <time data-tip="${stamp(e.ts)}">${ago(e.ts)}</time>
      </li>`)}
  </ul>`;
}

// Shown after a fresh deploy, until Cloudflare Access protects the app. The API refuses everything until then.
function setupView() {
  return html`
    <div class="welcome empty setup">
      <div class="glyph">${icon("check")}</div>
      <h1>Moniwork is deployed</h1>
      <p>One step left: put it behind Cloudflare Access so only your team can sign in. Until then, the API stays locked.</p>
      <ol class="setup-steps">
        <li><b>Turn on Access.</b> In the Cloudflare dashboard, open <b>Workers & Pages → moniwork → Settings → Domains & Routes</b>. Next to your workers.dev URL, choose <b>Enable Cloudflare Access</b>. Using a custom domain? Add a self-hosted Access application for it instead.</li>
        <li><b>Choose who gets in.</b> Click <b>Manage Cloudflare Access</b> and edit the policy, for example: emails ending in <code>@yourcompany.com</code>.</li>
        <li><b>Copy two values</b> from that Access application: the <b>Application Audience (AUD) tag</b> and your <b>team domain</b> (like <code>acme.cloudflareaccess.com</code>).</li>
        <li><b>Add them to the Worker.</b> <b>Settings → Variables and Secrets → Add</b>: <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code>. Saving redeploys automatically.</li>
        <li><b>Reload this page.</b> You'll sign in through Access and land on an empty dashboard.</li>
      </ol>
      <p class="hint">Using heartbeat monitors? Also add an Access application for the <code>/hb</code> path with a <b>Bypass</b> policy, so your servers can ping without signing in.</p>
      <a class="btn primary" href="https://github.com/Compile7/moniwork#2-lock-it-down-with-cloudflare-access" target="_blank" rel="noopener">Setup guide</a>
    </div>`;
}

function welcome() {
  return html`
    <div class="welcome empty">
      <div class="glyph">${icon("pulse")}</div>
      <h1>Welcome to Moniwork</h1>
      <p>Watch your team's HTTP endpoints. Paste a curl command, pick how often to check it, and see when it breaks.</p>
      <div class="steps">
        <div class="step"><b>1</b>Create a project for a service or team</div>
        <div class="step"><b>2</b>Add monitors by pasting curl commands</div>
        <div class="step"><b>3</b>Connect Google Chat, Telegram or Slack for alerts</div>
      </div>
      <button class="btn primary" data-action="new-project">${icon("plus")}Create your first project</button>
      <button class="btn ghost" data-action="import">${icon("upload")}Or import from Uptime Kuma</button>
    </div>`;
}

// ---------- project ----------
async function viewProject([id]) {
  const d = await api(`/projects/${id}`);
  if (state.page.projectId !== id) state.filter = { q: "", status: "all" };
  state.page = { projectId: id, project: d.project, monitors: d.monitors };
  const p = d.project;

  return html`
    <nav class="crumbs"><a href="/">Overview</a>${icon("chev")}<span>Project</span></nav>
    <header class="page-head">
      <div class="head-main">
        <h1>${p.name}</h1>
        ${p.description ? html`<p class="sub">${p.description}</p>` : ""}
        <p class="notify-line ${p.channels.length ? "" : "none"}">${icon("bell")}<span>${p.channels.length
          ? html`Alerts go to ${p.channels.map((c, i) => html`${i ? ", " : ""}<b>${c.name}</b>`)}${p.remind_min ? ` · reminders every ${label(REMIND, p.remind_min)}` : ""}${p.escalate_min ? ` · escalates after ${label(REMIND, p.escalate_min)}` : ""}`
          : html`No alerts set up. <button class="linkish" data-action="edit-project">Add a channel</button>`}</span></p>
        ${mutedLine(p.muted_until, "projects", p.id)}
      </div>
      <div class="actions">
        ${p.muted_until > Date.now() ? "" : html`<button class="btn icon" data-action="mute" data-target="projects" data-id="${p.id}" aria-label="Mute alerts" data-tip="Mute alerts for this project">${icon("bellOff")}</button>`}
        <button class="btn icon" data-action="import" aria-label="Import from Uptime Kuma" data-tip="Import from Uptime Kuma">${icon("upload")}</button>
        <button class="btn" data-action="edit-project">${icon("sliders")}Settings</button>
        <button class="btn primary" data-action="new-monitor">${icon("plus")}New monitor</button>
      </div>
    </header>
    ${d.monitors.length
      ? html`<div class="toolbar" id="mon-toolbar">${toolbar()}</div><div class="card" id="mon-list">${monitorList()}</div>`
      : html`
        <div class="card empty">
          <div class="glyph">${icon("terminal")}</div>
          <h2>No monitors yet</h2>
          <p>Paste any curl command, from a terminal or from your browser's "Copy as cURL". We'll run it on a schedule.</p>
          <button class="btn primary" data-action="new-monitor">${icon("plus")}Add your first monitor</button>
          <button class="btn ghost" data-action="import">${icon("upload")}Or import from Uptime Kuma</button>
        </div>`}`;
}

const label = (list, v) => (list.find(([k]) => k === v) || [0, `${v} min`])[1];
const until = (ts) => (ts - Date.now() < DAY ? clock(ts) : stamp(ts));
const mutedLine = (ts, target, id) => (ts > Date.now()
  ? html`<p class="notify-line muted-line">${icon("bellOff")}<span>Alerts muted until ${until(ts)} <button class="linkish" data-action="unmute" data-target="${target}" data-id="${id}">Unmute</button></span></p>`
  : "");

function filteredMonitors() {
  const { q, status } = state.filter;
  const needle = q.trim().toLowerCase();
  return state.page.monitors.filter((m) =>
    (status === "all" || statusOf(m) === status) &&
    (!needle || m.name.toLowerCase().includes(needle) || m.url.toLowerCase().includes(needle)));
}

function toolbar() {
  const all = state.page.monitors;
  const count = (s) => (s === "all" ? all.length : all.filter((m) => statusOf(m) === s).length);
  return html`
    <label class="search">${icon("search")}<input id="mon-search" class="input" placeholder="Filter by name or URL" value="${state.filter.q}" autocomplete="off"></label>
    <div class="chips">
      ${["all", "up", "down", "paused"].map((s) => html`
        <button class="chip ${state.filter.status === s ? "active" : ""}" data-action="filter" data-status="${s}">${s === "all" ? "All" : STATUS_LABEL[s]} <span>${count(s)}</span></button>`)}
    </div>`;
}

function monitorList() {
  const list = filteredMonitors();
  if (!list.length) return html`<div class="empty" style="padding:40px"><p class="muted">No monitors match this filter.</p></div>`;
  return list.map((m) => {
    const s = statusOf(m);
    return html`
      <a class="mon-row" href="/monitors/${m.id}">
        ${dot(s)}
        <span class="mon-main">
          <span class="mon-name">${m.name}${m.slow && s === "up" ? html` <span class="pill slow">Slow</span>` : ""}${m.muted_until > Date.now() ? html` <span class="muted" data-tip="Alerts muted">${icon("bellOff", "tiny")}</span>` : ""}</span>
          <span class="mon-url">${method(m.method)}<span class="truncate">${showUrl(m.url)}</span></span>
        </span>
        ${spark(m.spark)}
        <span class="mon-stat"><span class="v ${tone(m.uptime)}">${pct(m.uptime)}</span><span class="l">uptime 24h</span></span>
        <span class="mon-stat hide-md hide-sm"><span class="v">${ms(m.last_latency_ms)}</span><span class="l">every ${every(m.interval_sec)}</span></span>
        <span class="mon-ago hide-md hide-sm">${s === "paused" ? "Paused" : ago(m.last_checked_at)}</span>
        ${icon("chev", "chev")}
      </a>`;
  });
}

function spark(points = []) {
  const N = 30;
  const max = Math.max(1, ...points.filter((p) => p.ok).map((p) => p.latency_ms));
  return html`<span class="spark hide-sm" aria-hidden="true">
    ${Array.from({ length: N - points.length }, () => html`<i class="none"></i>`)}
    ${points.map((p) => html`<i class="${p.ok ? "up" : "down"}" style="--h:${p.ok ? Math.max(14, (p.latency_ms / max) * 100) : 100}%" data-tip="${clock(p.ts)} · ${p.ok ? ms(p.latency_ms) : "Failed"}"></i>`)}
  </span>`;
}

function rerenderList() {
  $("#mon-list").innerHTML = str(monitorList());
  for (const chip of document.querySelectorAll(".chip")) chip.classList.toggle("active", chip.dataset.status === state.filter.status);
}

// ---------- monitor ----------
// Alert buttons link here with ?do=ack or ?do=mute. Run it once, then drop it from the URL.
async function linkAction(id) {
  const intent = new URLSearchParams(location.search).get("do");
  if (!intent) return;
  history.replaceState(null, "", location.pathname);
  try {
    if (intent === "ack") {
      const r = await api(`/monitors/${id}/ack`, { body: {} });
      toast(r.acked_by === state.me ? "Acknowledged. Reminders stopped." : `Already acknowledged by ${r.acked_by}`);
    }
    if (intent === "mute") {
      await api(`/monitors/${id}/mute`, { body: { minutes: 60 } });
      toast("Alerts muted for 1 hour");
    }
  } catch (err) { toast(err.message, "err"); }
}

async function viewMonitor([id]) {
  await linkAction(id);
  const d = await api(`/monitors/${id}`);
  const m = d.monitor;
  state.page = { projectId: m.project_id, monitor: m };
  const s = statusOf(m);
  const hb = m.type === "heartbeat";
  const okLat = d.checks.filter((c) => c.ok).map((c) => c.latency_ms).sort((a, b) => a - b);
  const p95 = okLat.length ? okLat[Math.min(okLat.length - 1, Math.floor(okLat.length * 0.95))] : null;
  const recent = d.checks.slice(-15).reverse();
  const incident = d.events.find((e) => e.status === "down");
  const muted = m.muted_until > Date.now();

  return html`
    <nav class="crumbs"><a href="/">Overview</a>${icon("chev")}<a href="/projects/${m.project_id}">${m.project_name}</a>${icon("chev")}<span class="truncate">${m.name}</span></nav>
    <header class="page-head">
      <div class="head-main">
        <div class="title-row"><h1>${m.name}</h1>${pill(s)}${m.slow && s === "up" ? html`<span class="pill slow">${icon("turtle")}Slow</span>` : ""}</div>
        <div class="url-line">${hb ? html`${method("PING")}<span class="truncate">${pingUrl(m)}</span>` : html`${method(m.request.method)}<span class="truncate">${showUrl(m.request.url)}</span>`}</div>
        <p class="meta">${hb ? `Expects a ping every ${every(m.interval_sec)} · Last ping ${ago(m.last_ping_at)}` : html`Checks every ${every(m.interval_sec)}${m.regions ? " from US, EU and Asia" : ""} · Last check ${ago(m.last_checked_at)}${m.last_latency_ms != null ? ` · ${ms(m.last_latency_ms)}` : ""}`}</p>
        ${mutedLine(m.muted_until, "monitors", m.id)}
      </div>
      <div class="actions">
        ${s === "down" && !m.acked_by ? html`<button class="btn primary" data-action="ack">${icon("eye")}Acknowledge</button>` : ""}
        ${hb ? "" : html`<button class="btn" data-action="run-now">${icon("refresh")}Run now</button>`}
        ${muted ? "" : html`<button class="btn icon" data-action="mute" data-target="monitors" data-id="${m.id}" aria-label="Mute alerts" data-tip="Mute alerts">${icon("bellOff")}</button>`}
        <button class="btn icon" data-action="toggle-pause" aria-label="${m.paused ? "Resume" : "Pause"}" data-tip="${m.paused ? "Resume checks" : "Pause checks"}">${icon(m.paused ? "play" : "pause")}</button>
        <button class="btn" data-action="edit-monitor">${icon("edit")}Edit</button>
        <button class="btn icon danger-ghost" data-action="delete-monitor" aria-label="Delete monitor" data-tip="Delete monitor">${icon("trash")}</button>
      </div>
    </header>

    ${s === "down" && m.last_error ? html`
      <div class="alert">${icon("alert")}<div>
        <strong>This monitor is failing${m.down_since ? ` · ${ago(m.down_since).replace(" ago", "")}` : ""}</strong>
        <span>${m.last_error}</span>
        ${incident?.summary ? html`<p class="ai-line">${icon("sparkle")}${incident.summary}</p>` : ""}
        <p class="ack-line">${m.acked_by ? html`${icon("eye")}<b>${m.acked_by}</b> acknowledged ${ago(m.acked_at)}` : "Nobody has acknowledged this yet."}</p>
      </div></div>` : ""}
    ${s === "pending" ? html`<div class="alert" style="background:var(--warn-soft);color:var(--warn)">${icon("refresh")}<div><strong>${hb ? "Waiting for the first ping" : "Waiting for the first check"}</strong><span>${hb ? "Send a request to the ping URL below from your job." : "Results show up here in a few seconds."}</span></div></div>` : ""}

    <div class="tiles five">
      ${tile("Uptime · 24h", pct(d.stats.u24), tone(d.stats.u24))}
      ${tile("Uptime · 7d", pct(d.stats.u7), tone(d.stats.u7))}
      ${tile("Uptime · 30d", pct(d.stats.u30), tone(d.stats.u30))}
      ${hb ? tile("Last ping", ago(m.last_ping_at)) : tile("Avg response · 24h", ms(d.stats.avg24))}
      ${hb ? tile("Expected every", every(m.interval_sec)) : tile("P95 · 24h", ms(p95))}
    </div>

    <div class="card">
      <div class="card-head"><h2>Availability</h2><span class="muted">Last 24 hours · 30 min blocks</span></div>
      ${uptimeBar(d.checks)}
    </div>

    ${hb ? "" : html`
      <div class="card">
        <div class="card-head"><h2>Response time</h2>
          <span class="legend">${m.slow_ms ? html`<span><i style="background:var(--warn)"></i>Slow over ${ms(m.slow_ms)}</span>` : ""}<span><i style="background:var(--chart)"></i>Response</span><span><i style="background:var(--down)"></i>Failed</span></span>
        </div>
        ${chart(d.checks, m.interval_sec, m.slow_ms)}
      </div>`}

    <div class="two-col">
      <div class="card">
        <div class="card-head"><h2>${hb ? "Recent checks" : "Recent checks"}</h2><span class="muted">${plural(d.checks.length, "check")} in 24h</span></div>
        ${recent.length ? html`
          <table class="table">
            <thead><tr><th>Time</th><th>Status</th>${hb ? "" : html`<th>Response</th>`}<th class="hide-sm">Detail</th></tr></thead>
            <tbody>${recent.map((c) => html`
              <tr ${!c.has_detail ? "" : raw(`class="clickable" data-action="check-detail" data-id="${c.id}" data-tip="Diagnose this failure"`)}>
                <td data-tip="${stamp(c.ts)}">${ago(c.ts)}</td>
                <td><span class="code-chip ${c.ok ? "" : "bad"}">${hb ? (c.ok ? "OK" : "LATE") : c.status_code ?? "ERR"}</span></td>
                ${hb ? "" : html`<td>${ms(c.latency_ms)}</td>`}
                <td class="hide-sm">${c.error ? html`<span class="err">${c.error}</span>${c.has_detail ? html` <span class="linkish">Diagnose</span>` : ""}` : html`<span class="muted">OK</span>`}</td>
              </tr>`)}
            </tbody>
          </table>` : html`<div class="empty" style="padding:32px"><p class="muted">No checks yet.</p></div>`}
      </div>

      <div class="stackcol">
        <div class="card">
          <div class="card-head"><h2>Incidents</h2></div>
          ${d.events.length ? timeline(d.events, false) : html`<div class="empty" style="padding:28px"><p class="muted">No incidents. Nice.</p></div>`}
        </div>
        ${hb ? pingCard(m) : requestCard(m, d.expiry)}
      </div>
    </div>`;
}

const pingUrl = (m) => `${location.origin}/hb/${m.token}`;

function pingCard(m) {
  const url = pingUrl(m);
  const cron = `curl -fsS -m 10 --retry 3 ${url}`;
  return html`
    <div class="card">
      <div class="card-head"><h2>Ping URL</h2></div>
      <div class="how-to">
        <p>Call this URL every time your job finishes. If no ping arrives within ${every(m.interval_sec)} plus a grace period, this monitor goes down.</p>
        <div class="code-block flush"><pre>${url}</pre><button class="btn icon xs" data-action="copy" data-value="${url}" data-tip="Copy" aria-label="Copy URL">${icon("copy")}</button></div>
        <p class="muted">At the end of a cron job or script:</p>
        <div class="code-block flush"><pre>${cron}</pre><button class="btn icon xs" data-action="copy" data-value="${cron}" data-tip="Copy" aria-label="Copy command">${icon("copy")}</button></div>
        <p class="hint">GET, POST and HEAD all work. The URL is the secret: anyone with it can send pings.</p>
      </div>
    </div>`;
}

function expiryLine(e) {
  const what = e.kind === "ssl" ? "SSL certificate" : `Domain ${e.host}`;
  if (!e.expires_at) return html`<dt>${what}</dt><dd class="muted">${e.error || "Unknown"}</dd>`;
  const days = Math.floor((e.expires_at - Date.now()) / DAY);
  return html`<dt>${what}</dt><dd class="${days <= 14 ? "warn-text" : ""}">Expires in ${plural(days, "day")} <span class="muted">(${new Date(e.expires_at).toLocaleDateString()})</span></dd>`;
}

function requestCard(m, expiry) {
  return html`
    <div class="card">
      <div class="card-head"><h2>Request</h2></div>
      <dl class="kv">
        ${m.steps.length ? html`<dt>Steps</dt><dd class="plain">${m.steps.map((st, i) => html`<div>${i + 1}. ${st.name}${st.vars.length ? html` <span class="muted">→ ${st.vars.map(([k]) => `{{${k}}}`).join(", ")}</span>` : ""}</div>`)}<div>${m.steps.length + 1}. Main request</div></dd>` : ""}
        <dt>Method</dt><dd>${m.request.method}</dd>
        <dt>URL</dt><dd>${showUrl(m.request.url)}</dd>
        ${m.request.headers.map(([k, v]) => html`<dt class="mono">${k}</dt><dd>${SECRET.test(k) ? html`<span class="secret" data-action="reveal" data-value="${v}" data-tip="Click to reveal">••••••••</span>` : v}</dd>`)}
        <dt>Expect</dt><dd>Status ${m.expected_status}${m.keyword ? html`, body contains “${m.keyword}”` : ""}</dd>
        <dt>Timeout</dt><dd>${m.timeout_ms / 1000}s${m.request.followRedirects ? " · follows redirects" : ""}</dd>
        ${m.slow_ms ? html`<dt>Slow alert</dt><dd>Over ${ms(m.slow_ms)} for 5 minutes</dd>` : ""}
        ${m.regions ? html`<dt>Regions</dt><dd>US, EU, Asia · down when 2 of 3 fail</dd>` : ""}
        ${expiry.map(expiryLine)}
      </dl>
      <details class="disclose" data-key="curl">
        <summary>${icon("chev")}Show cURL command</summary>
        <div class="code-block"><pre>${m.curl}</pre><button class="btn icon xs" data-action="copy" data-value="${m.curl}" data-tip="Copy" aria-label="Copy curl">${icon("copy")}</button></div>
      </details>
    </div>`;
}

function uptimeBar(checks) {
  const N = 48, size = DAY / N, start = Date.now() - DAY;
  const b = Array.from({ length: N }, () => ({ ok: 0, fail: 0 }));
  for (const c of checks) {
    const i = Math.floor((c.ts - start) / size);
    if (i >= 0 && i < N) c.ok ? b[i].ok++ : b[i].fail++;
  }
  return html`
    <div class="ubar">
      ${b.map(({ ok, fail }, i) => {
        const n = ok + fail;
        const cls = !n ? "none" : !fail ? "up" : ok ? "warn" : "down";
        const t = start + i * size;
        return html`<span class="${cls}" data-tip="${clock(t)}–${clock(t + size)} · ${!n ? "No data" : fail ? `${fail} of ${n} failed` : `${plural(n, "check")} OK`}"></span>`;
      })}
    </div>
    <div class="axis"><span>24h ago</span><span>Now</span></div>`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 10)));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= v);
}

function chart(checks, intervalSec, slowMs = 0) {
  if (!checks.length) return html`<div class="chart-empty">No checks in the last 24 hours</div>`;
  const W = 1000, H = 200, now = Date.now(), t0 = now - DAY;
  const ok = checks.filter((c) => c.ok);
  const sorted = ok.map((c) => c.latency_ms).sort((a, b) => a - b);
  const max = niceMax(sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.99)] * 1.15 : 100);
  const x = (t) => (((t - t0) / DAY) * W).toFixed(1);
  const y = (v) => (H - (Math.min(v, max) / max) * H).toFixed(1);
  state.chart = { t0, max, checks };

  // Break the line where checks are missing (paused, or before the monitor existed).
  const gap = Math.max(intervalSec * 3000, 20 * 60_000);
  const segments = [];
  let seg = [];
  for (const c of ok) {
    if (seg.length && c.ts - seg[seg.length - 1].ts > gap) { segments.push(seg); seg = []; }
    seg.push(c);
  }
  if (seg.length) segments.push(seg);
  const line = segments.map((s) => "M" + s.map((c) => `${x(c.ts)},${y(c.latency_ms)}`).join("L")).join("");
  const area = segments.filter((s) => s.length > 1)
    .map((s) => `M${x(s[0].ts)},${H}L` + s.map((c) => `${x(c.ts)},${y(c.latency_ms)}`).join("L") + `L${x(s[s.length - 1].ts)},${H}Z`).join("");

  return html`
    <div class="chart">
      <div class="chart-y"><span>${ms(max)}</span><span>${ms(max / 2)}</span><span>0</span></div>
      <div class="chart-plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Response time over the last 24 hours">
          <defs><linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" style="stop-color:var(--chart);stop-opacity:.22"/><stop offset="1" style="stop-color:var(--chart);stop-opacity:0"/>
          </linearGradient></defs>
          <line class="chart-grid" x1="0" x2="${W}" y1="0" y2="0" vector-effect="non-scaling-stroke"/>
          <line class="chart-grid" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" vector-effect="non-scaling-stroke"/>
          <line class="chart-grid" x1="0" x2="${W}" y1="${H}" y2="${H}" vector-effect="non-scaling-stroke" style="stroke-dasharray:none"/>
          ${slowMs && slowMs < max ? html`<line class="chart-slow" x1="0" x2="${W}" y1="${y(slowMs)}" y2="${y(slowMs)}" vector-effect="non-scaling-stroke"/>` : ""}
          ${checks.filter((c) => !c.ok).map((c) => html`<line class="chart-fail" x1="${x(c.ts)}" x2="${x(c.ts)}" y1="0" y2="${H}" vector-effect="non-scaling-stroke"/>`)}
          <path d="${area}" fill="url(#area-fill)"/>
          <path d="${line}" class="chart-line" fill="none" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="chart-cursor"></div><div class="chart-dot"></div><div class="chart-tip"></div>
      </div>
      <div class="chart-x">${[24, 18, 12, 6, 0].map((h) => html`<span>${h ? clock(now - h * 3_600_000) : "Now"}</span>`)}</div>
    </div>`;
}

function chartHover(e) {
  const plot = e.target.closest?.(".chart-plot");
  for (const el of document.querySelectorAll(".chart-plot.hover")) if (el !== plot) el.classList.remove("hover");
  if (!plot || !state.chart) return;
  const { t0, max, checks } = state.chart;
  const r = plot.getBoundingClientRect();
  const t = t0 + ((e.clientX - r.left) / r.width) * DAY;
  let lo = 0, hi = checks.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; checks[mid].ts < t ? (lo = mid + 1) : (hi = mid); }
  const c = lo > 0 && t - checks[lo - 1].ts < checks[lo].ts - t ? checks[lo - 1] : checks[lo];
  const px = `${((c.ts - t0) / DAY) * 100}%`;
  const py = c.ok ? `${(1 - Math.min(c.latency_ms, max) / max) * 100}%` : "100%";
  plot.classList.add("hover");
  $(".chart-cursor", plot).style.left = px;
  Object.assign($(".chart-dot", plot).style, { left: px, top: py });
  $(".chart-dot", plot).classList.toggle("fail", !c.ok);
  const tip = $(".chart-tip", plot);
  tip.innerHTML = str(html`<b>${c.ok ? ms(c.latency_ms) : c.status_code ? `Failed · ${c.status_code}` : "Failed"}</b><span>${stamp(c.ts)}</span>`);
  // Keep the tooltip inside the plot near the edges.
  const frac = (c.ts - t0) / DAY;
  tip.style.left = px;
  tip.style.translate = `${frac < 0.15 ? "0" : frac > 0.85 ? "-100%" : "-50%"} -100%`;
}

// ---------- dialogs ----------
function openModal(content, size = "") {
  modal.className = `modal ${size}`;
  modal.innerHTML = str(content);
  modal.showModal();
  modal.querySelector("[autofocus]")?.focus();
}
const closeModal = () => modal.close();
const closeBtn = () => html`<button type="button" class="btn icon ghost" data-action="close-modal" aria-label="Close">${icon("x")}</button>`;

function confirmDialog({ title, body, confirm = "Delete" }) {
  const d = $("#confirm");
  d.innerHTML = str(html`
    <form method="dialog" class="confirm">
      <h2>${title}</h2><p>${body}</p>
      <footer><button class="btn ghost" value="cancel">Cancel</button><button class="btn danger" value="ok">${confirm}</button></footer>
    </form>`);
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

function projectForm(p) {
  return html`
    <form id="project-form" class="modal-form" data-id="${p?.id ?? ""}">
      <header class="modal-head">
        <div><h2>${p ? "Project settings" : "New project"}</h2>${p ? "" : html`<p class="sub">Group related monitors, like a service or a team.</p>`}</div>
        ${closeBtn()}
      </header>
      <div class="modal-body">
        <label class="field"><span>Name</span><input class="input" name="name" required maxlength="80" placeholder="Payments API" value="${p?.name ?? ""}" autofocus></label>
        <label class="field"><span>Description<em>optional</em></span><input class="input" name="description" maxlength="280" placeholder="What this project covers" value="${p?.description ?? ""}"></label>
        <div class="field">
          <span>Send alerts to</span>
          ${state.channels.length
            ? checkList("channel_ids", state.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
                (id) => (p ? p.channels.some((c) => c.id === id) : true))
            : html`<p class="hint">No notification channels yet. <a href="/notifications">Set up Google Chat or Telegram</a>.</p>`}
        </div>
        <div class="field">
          <span>If a monitor stays down and nobody acknowledges it</span>
          <div class="row2">
            <label class="field"><span class="sub">Remind every</span>${select("remind_min", REMIND, p?.remind_min ?? 0)}</label>
            <label class="field"><span class="sub">Escalate after</span>${select("escalate_min", REMIND, p?.escalate_min ?? 0)}</label>
          </div>
          ${state.channels.length ? html`
            <span class="sub">Escalate to<em>defaults to the channels above</em></span>
            ${checkList("escalate_to", state.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })), (id) => JSON.parse(p?.escalate_to ?? "[]").includes(id))}` : ""}
        </div>
        ${p ? html`
          <div class="danger-zone">
            <div><strong>Delete project</strong><small>Removes ${plural(state.page.monitors?.length ?? 0, "monitor")} and all their history.</small></div>
            <button type="button" class="btn danger" data-action="delete-project">Delete</button>
          </div>` : ""}
      </div>
      <footer class="modal-foot"><span class="grow"></span>
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${p ? "Save changes" : "Create project"}</button>
      </footer>
    </form>`;
}

function stepBlock(st = {}, i = 0) {
  return html`
    <div class="step">
      <div class="step-head"><b>Step ${i + 1}</b><input class="input sm" name="step_name" maxlength="60" placeholder="Log in" value="${st.name ?? ""}">
        <button type="button" class="btn icon xs ghost" data-action="remove-step" aria-label="Remove step" data-tip="Remove step">${icon("x")}</button></div>
      <textarea name="step_curl" class="input mono" rows="3" spellcheck="false" placeholder="curl https://api.example.com/login --json '{&quot;user&quot;:&quot;…&quot;}'">${st.curl ?? ""}</textarea>
      <textarea name="step_vars" class="input mono" rows="2" spellcheck="false" placeholder="token = $.access_token&#10;session = header:Set-Cookie">${(st.vars ?? []).map(([k, v]) => `${k} = ${v}`).join("\n")}</textarea>
    </div>`;
}

const select = (name, options, value) =>
  html`<select class="input" name="${name}">${options.map(([v, l]) => html`<option value="${v}" ${v === value ? raw("selected") : ""}>${l}</option>`)}</select>`;

function monitorForm(m) {
  const interval = m?.interval_sec ?? 300;
  const type = m?.type ?? "http";
  return html`
    <form id="monitor-form" class="modal-form" data-id="${m?.id ?? ""}" data-type="${type}">
      <header class="modal-head">
        <div><h2>${m ? "Edit monitor" : "New monitor"}</h2><p class="sub http-only">Paste a curl command. We'll run it on a schedule and flag failures.</p><p class="sub hb-only">Your job pings a URL. If the pings stop, you get alerted.</p></div>
        ${closeBtn()}
      </header>
      <div class="modal-body split">
        <div class="col">
          ${m ? "" : html`<div class="seg" role="radiogroup">
            <label><input type="radio" name="type" value="http" ${type === "http" ? raw("checked") : ""}><span>HTTP request</span></label>
            <label><input type="radio" name="type" value="heartbeat" ${type === "heartbeat" ? raw("checked") : ""}><span>Heartbeat (cron job)</span></label>
          </div>`}
          <label class="field http-only">
            <span>cURL command</span>
            <textarea name="curl" class="input mono" rows="7" spellcheck="false" autocapitalize="off" ${type === "http" ? raw("autofocus") : ""}
              placeholder="curl https://api.example.com/health \\&#10;  -H 'Authorization: Bearer …'">${m?.curl ?? ""}</textarea>
          </label>
          <div id="parse-preview" class="parse-preview http-only"></div>
          <label class="field"><span>Name</span><input class="input" name="name" required maxlength="100" placeholder="${type === "http" ? "Health check" : "Nightly backup"}" value="${m?.name ?? ""}" ${m ? raw('data-touched="1"') : ""}></label>
          <div class="field">
            <span class="http-only">Check every</span><span class="hb-only">Expect a ping every</span>
            <div class="seg" role="radiogroup">
              ${INTERVALS.map(([v, l]) => html`<label><input type="radio" name="interval_sec" value="${v}" ${v === interval ? raw("checked") : ""}><span>${l}</span></label>`)}
            </div>
            <small class="hint hb-only">Goes down when a ping is more than half an interval late (at least 1 minute).</small>
          </div>
          <details class="advanced http-only" ${m && (m.expected_status !== "200-399" || m.keyword) ? raw("open") : ""}>
            <summary>${icon("chev")}Assertions and timeout</summary>
            <div class="row3">
              <label class="field"><span>Expected status</span><input class="input mono" name="expected_status" placeholder="200-399" value="${m?.expected_status ?? "200-399"}"></label>
              <label class="field"><span>Body contains<em>optional</em></span><input class="input" name="keyword" placeholder="&quot;ok&quot;" value="${m?.keyword ?? ""}"></label>
              <label class="field"><span>Timeout</span><input class="input" name="timeout" type="number" min="1" max="30" step="1" value="${(m?.timeout_ms ?? 10000) / 1000}"></label>
            </div>
          </details>
          <details class="advanced http-only" ${m?.slow_ms || m?.regions ? raw("open") : ""}>
            <summary>${icon("chev")}Slow alerts and regions</summary>
            <div class="col pad">
              <label class="field"><span>Alert when slower than<em>optional</em></span>
                <div class="input-row"><input class="input" name="slow_ms" type="number" min="100" max="60000" step="50" placeholder="e.g. 2000" value="${m?.slow_ms || ""}"><span class="unit">ms, for 5 minutes</span></div>
              </label>
              <label class="check plain"><input type="checkbox" name="regions" ${m?.regions ? raw("checked") : ""}><span>Check from US, EU and Asia. Alert only when 2 of 3 fail.</span></label>
            </div>
          </details>
          <details class="advanced http-only" ${m?.steps?.length ? raw("open") : ""}>
            <summary>${icon("chev")}Steps before this request<em class="muted">log in, get a token</em></summary>
            <div class="col pad">
              <p class="hint">Each step runs first. Save values from its JSON response (<code>$.path</code>) or a header (<code>header:Name</code>), then use them as <code>{{name}}</code> in later steps and the main request.</p>
              <div id="steps">${(m?.steps ?? []).map(stepBlock)}</div>
              <button type="button" class="btn" data-action="add-step">${icon("plus")}Add step</button>
            </div>
          </details>
        </div>
        <aside class="test-panel http-only" id="test-panel">
          <div class="test-idle">${icon("zap")}<strong>Test before saving</strong><span>Send the request once and see exactly what the monitor will see.</span></div>
        </aside>
        <aside class="test-panel hb-only">
          <div class="test-idle">${icon("heart")}<strong>How heartbeats work</strong><span>After you create it, you get a ping URL. Call it at the end of your cron job, backup or worker: <code>curl -fsS …/hb/…</code></span></div>
        </aside>
      </div>
      <footer class="modal-foot">
        <button type="button" class="btn http-only" data-action="test-request">${icon("zap")}Test request</button>
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${m ? "Save changes" : "Create monitor"}</button>
      </footer>
    </form>`;
}

function monitorValues(form) {
  const f = form.elements;
  const base = { type: form.dataset.type, name: f.name.value, interval_sec: Number(f.interval_sec.value) };
  if (form.dataset.type === "heartbeat") return base;
  return {
    ...base,
    curl: f.curl.value,
    expected_status: f.expected_status.value,
    keyword: f.keyword.value,
    timeout_ms: Math.round(Number(f.timeout.value || 10) * 1000),
    slow_ms: Number(f.slow_ms.value || 0),
    regions: f.regions.checked,
    steps: [...form.querySelectorAll(".step")].map((el) => ({
      name: $("[name=step_name]", el).value, curl: $("[name=step_curl]", el).value, vars: $("[name=step_vars]", el).value,
    })),
  };
}

let parseTimer = 0, parseSeq = 0;
async function updatePreview(form) {
  const box = $("#parse-preview", form);
  const curl = form.elements.curl.value.trim();
  const seq = ++parseSeq;
  if (!curl) { box.className = "parse-preview"; box.innerHTML = ""; return; }
  try {
    const r = await api("/parse", { body: { curl } });
    if (seq !== parseSeq) return;
    box.className = "parse-preview";
    box.innerHTML = str(html`${method(r.method)}<span class="url truncate">${showUrl(r.url)}</span>
      <span class="tags">${plural(r.headers.length, "header")}${r.body ? ` · ${bytes(r.body.length)} body` : ""}</span>`);
    const name = form.elements.name;
    if (!name.dataset.touched) {
      const u = new URL(r.url);
      name.value = (u.hostname + (u.pathname === "/" ? "" : u.pathname)).slice(0, 100);
    }
  } catch (err) {
    if (seq !== parseSeq) return;
    box.className = "parse-preview err";
    box.innerHTML = str(html`${icon("alert")}<span>${err.message}</span>`);
  }
}

const pretty = (body) => { try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; } };

function testResult(r) {
  const p = r.preview;
  return html`
    <div class="tr-head">
      <span class="tr-code ${r.ok ? "ok" : "bad"}">${r.status_code ?? "ERR"}</span>
      <span class="tr-text">${p?.status_text || (r.status_code ? "" : "No response")}</span>
      <span class="tr-lat">${ms(r.latency_ms)}</span>
    </div>
    <div class="tr-verdict ${r.ok ? "ok" : "bad"}">${icon(r.ok ? "check" : "alert")}<span>${r.ok ? "Passes. This would count as up." : r.error}</span></div>
    ${r.steps?.length ? html`<ol class="tr-steps">${r.steps.map((st) => html`<li><span class="code-chip ${st.error ? "bad" : ""}">${st.status_code ?? "ERR"}</span>${st.name}<span class="muted">${ms(st.latency_ms)}</span></li>`)}</ol>` : ""}
    ${p?.final_url ? html`<div class="muted" style="margin-top:12px">Redirected to <span class="mono">${p.final_url}</span></div>` : ""}
    ${p ? html`
      <details><summary>Response headers (${p.headers.length})</summary>
        <dl class="kv">${p.headers.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      </details>
      <div class="muted" style="margin-top:12px">Body${p.body.length >= 4000 ? " (first 4 KB)" : ""}</div>
      <pre>${pretty(p.body) || "(empty)"}</pre>` : ""}`;
}

// ---------- diagnose a failed check ----------
const VOLATILE = /^(date|age|expires|last-modified|etag|cf-ray|set-cookie|report-to|nel|server-timing|x-request-id|x-amzn-requestid|x-amz-cf-id|x-cache|cf-cache-status|alt-svc|x-served-by|x-timer)$/i;
const REQUEST_ID = /^(cf-ray|x-request-id|x-amzn-requestid|x-amz-cf-id|x-correlation-id|x-trace-id|traceparent)$/i;

// Line diff (LCS). Bodies are capped at 4 KB, so the n*m table stays small.
function lineDiff(a, b) {
  const A = a.split("\n").slice(0, 300), B = b.split("\n").slice(0, 300);
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) {
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; }
    else if (i < A.length && (j >= B.length || L[i + 1][j] >= L[i][j + 1])) out.push(["-", A[i++]]);
    else out.push(["+", B[j++]]);
  }
  return out;
}

// Long runs of unchanged lines collapse to a "…" row.
function diffView(rows) {
  const keep = rows.map((r, i) => r[0] !== " " || rows.slice(Math.max(0, i - 2), i + 3).some((x) => x[0] !== " "));
  const out = [];
  rows.forEach((r, i) => { if (keep[i]) out.push(r); else if (keep[i - 1] !== false) out.push(["…", ""]); });
  return html`<pre class="diff">${out.map(([t, line]) => html`<span class="d${t === "+" ? " add" : t === "-" ? " del" : t === "…" ? " gap" : ""}">${t === "…" ? "⋯" : `${t} ${line}`}</span>`)}</pre>`;
}

function headerDiff(oldH, newH) {
  const a = new Map(oldH.map(([k, v]) => [k.toLowerCase(), v])), b = new Map(newH.map(([k, v]) => [k.toLowerCase(), v]));
  const rows = [...new Set([...a.keys(), ...b.keys()])].filter((k) => !VOLATILE.test(k) && a.get(k) !== b.get(k));
  if (!rows.length) return html`<p class="muted">No meaningful header changes.</p>`;
  return html`<table class="table compact"><thead><tr><th>Header</th><th>Last good</th><th>Failed</th></tr></thead><tbody>
    ${rows.map((k) => html`<tr><td class="mono">${k}</td><td class="mono ${b.has(k) ? "" : "del-text"}">${a.get(k) ?? "—"}</td><td class="mono ${a.has(k) ? "chg-text" : "add-text"}">${b.get(k) ?? "—"}</td></tr>`)}
  </tbody></table>`;
}

const section = (title, body, extra = "") => html`<section class="diag"><h3>${title}${extra ? html`<span class="muted">${extra}</span>` : ""}</h3>${body}</section>`;

function diagnose(c) {
  const p = c.preview;
  const reqId = p?.headers.find(([k]) => REQUEST_ID.test(k));
  const good = c.last_ok;
  return html`
    <header class="modal-head"><div><h2>Failed check</h2><p class="sub">${stamp(c.ts)}</p></div>${closeBtn()}</header>
    <div class="modal-body diag-body">
      ${c.summary ? html`<div class="ai-box">${icon("sparkle")}<div><strong>Likely cause</strong><p>${c.summary}</p></div></div>` : ""}
      <div class="test-panel has-result" style="min-height:0">${testResult(c)}</div>
      ${p ? html`<div class="facts">
        ${reqId ? html`<span><b>${reqId[0]}</b> <code>${reqId[1]}</code></span>` : ""}
        ${p.size != null ? html`<span><b>Size</b> ${bytes(p.size)}</span>` : ""}
        <span><b>Time</b> ${ms(c.latency_ms)}</span>
      </div>` : ""}

      ${c.attempts?.length === 2 ? section("Both attempts", html`<div class="attempts">
        ${c.attempts.map((a, i) => html`<div class="attempt"><span class="muted">${i ? "Retry, 3s later" : "First try"}</span>
          <b class="${a.ok ? "ok-text" : "bad-text"}">${a.status_code ?? "ERR"}</b> <span class="muted">${ms(a.latency_ms)}</span>
          <div class="err">${a.error || "OK"}</div></div>`)}
      </div>`) : ""}

      ${c.regions?.length ? section("Regions", html`<table class="table compact"><tbody>
        ${c.regions.map((r) => html`<tr><td><b>${r.region}</b></td><td><span class="code-chip ${r.ok ? "" : "bad"}">${r.status_code ?? "ERR"}</span></td><td>${ms(r.latency_ms)}</td><td class="err">${r.error || "OK"}</td></tr>`)}
      </tbody></table>`, "Down when 2 of 3 fail") : ""}

      ${c.steps?.length ? section("Steps", html`<table class="table compact"><tbody>
        ${c.steps.map((st) => html`<tr><td><b>${st.name}</b></td><td><span class="code-chip ${st.error ? "bad" : ""}">${st.status_code ?? "ERR"}</span></td><td>${ms(st.latency_ms)}</td><td class="err">${st.error || "OK"}</td></tr>`)}
      </tbody></table>`) : ""}

      ${p?.chain?.length ? section("Redirects", html`<ol class="chain">
        ${p.chain.map((h) => html`<li><span class="code-chip warnchip">${h.status}</span><span class="mono">${h.url}</span></li>`)}
        <li><span class="code-chip bad">${c.status_code ?? "ERR"}</span><span class="mono">${p.final_url}</span></li>
      </ol>`) : ""}

      ${c.dns ? section("DNS", c.dns.error ? html`<p class="err">${c.dns.error}</p>` : html`
        <p><span class="code-chip ${c.dns.status === "NOERROR" ? "" : "bad"}">${c.dns.status}</span>${c.dns.records?.length ? "" : html` <span class="muted">No A or AAAA records</span>`}</p>
        ${c.dns.records?.length ? html`<table class="table compact"><tbody>${c.dns.records.map((r) => html`<tr><td>${r.type}</td><td class="mono">${r.data}</td><td class="muted">TTL ${r.ttl}s</td></tr>`)}</tbody></table>` : ""}`, "Looked up through 1.1.1.1") : ""}

      ${good && p ? section("Compared with the last good response", html`
        <p class="muted">${good.status_code} ${good.status_text} · ${stamp(good.ts)} (${ago(good.ts)})</p>
        <h4>Headers</h4>${headerDiff(good.headers, p.headers)}
        <h4>Body</h4>${good.body === p.body ? html`<p class="muted">Same body.</p>` : diffView(lineDiff(pretty(good.body), pretty(p.body)))}`)
        : p ? section("Compared with the last good response", html`<p class="muted">No passing response saved yet. It's kept from the next successful check onward.</p>`) : ""}
    </div>`;
}

// ---------- notifications ----------
const checked = (form, name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((b) => b.value);
const chIcon = (type, cls = "") => html`<span class="ch-icon ${type} ${cls}">${icon(CHANNEL[type].icon)}</span>`;

function checkList(name, items, isChecked) {
  return html`<div class="check-list">
    ${items.map((it) => html`
      <label class="check">
        <input type="checkbox" name="${name}" value="${it.id}" ${isChecked(it.id) ? raw("checked") : ""}>
        ${it.type ? chIcon(it.type, "sm") : ""}<span class="truncate">${it.name}</span>
        ${it.type ? html`<span class="muted">${CHANNEL[it.type].label}</span>` : ""}
      </label>`)}
  </div>`;
}

function channelTarget(ch) {
  if (ch.type === "telegram") return `Chat ${ch.config.chat_id}`;
  try { const u = new URL(ch.config.url); return u.host + u.pathname.slice(0, 28) + (u.pathname.length > 28 ? "…" : ""); }
  catch { return ch.config.url; }
}

async function viewNotifications(_, projectsP) {
  state.page = {};
  const [channels, projects] = await Promise.all([api("/channels"), projectsP]);
  state.channels = channels;
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return html`
    <header class="page-head">
      <div class="head-main"><h1>Notifications</h1><p class="sub">Where alerts go when a monitor goes down or comes back up.</p></div>
    </header>
    ${channels.length ? html`
      <div class="card">
        ${channels.map((ch) => html`
          <div class="list-row ch-row">
            ${chIcon(ch.type)}
            <div class="main-col"><span class="t truncate">${ch.name}</span><span class="s mono truncate">${CHANNEL[ch.type].label} · ${channelTarget(ch)}</span></div>
            ${ch.project_ids.length
              ? html`<span class="muted hide-sm" data-tip="${ch.project_ids.map((id) => names.get(id)).filter(Boolean).join(", ")}">${plural(ch.project_ids.length, "project")}</span>`
              : html`<span class="pill pending hide-sm">Not used</span>`}
            <button class="btn" data-action="test-channel" data-id="${ch.id}">${icon("send")}Test</button>
            <button class="btn icon" data-action="edit-channel" data-id="${ch.id}" aria-label="Edit channel" data-tip="Edit">${icon("edit")}</button>
            <button class="btn icon danger-ghost" data-action="delete-channel" data-id="${ch.id}" aria-label="Delete channel" data-tip="Delete">${icon("trash")}</button>
          </div>`)}
      </div>` : ""}
    <div class="section-head"><h2>${channels.length ? "Add another channel" : "Pick where alerts should go"}</h2></div>
    <div class="type-grid">
      ${Object.entries(CHANNEL).map(([type, t]) => html`
        <button class="card type-card" data-action="new-channel" data-type="${type}">
          ${chIcon(type)}<strong>${t.label}</strong><span>${t.hint}</span>
        </button>`)}
    </div>`;
}

function channelFieldsHtml(type, cfg = {}) {
  if (type === "telegram") return html`
    <ol class="how">
      <li>Message <b>@BotFather</b> in Telegram, send <code>/newbot</code>, and copy the token.</li>
      <li>Add the bot to your group (or open a chat with it) and send any message.</li>
      <li>Click <b>Detect</b> and pick the chat.</li>
    </ol>
    <label class="field"><span>Bot token</span><input class="input mono" name="token" required autocomplete="off" spellcheck="false" placeholder="123456789:AAH…" value="${cfg.token ?? ""}"></label>
    <div class="field">
      <span>Chat ID</span>
      <div class="input-row">
        <input class="input mono" name="chat_id" required placeholder="-1001234567890" value="${cfg.chat_id ?? ""}">
        <button type="button" class="btn" data-action="detect-chats">${icon("search")}Detect</button>
      </div>
      <div id="chat-results"></div>
    </div>`;
  return html`
    <ol class="how">
      ${type === "google_chat"
        ? html`<li>Open the Google Chat space that should get alerts.</li><li>Click the space name → <b>Apps & integrations</b> → <b>Webhooks</b>.</li><li>Add a webhook and paste its URL here.</li>`
        : html`<li><b>Slack:</b> create an Incoming Webhook for a channel.</li><li><b>Discord:</b> Channel settings → Integrations → Webhooks → New webhook.</li><li>Paste the webhook URL here.</li>`}
    </ol>
    <label class="field"><span>Webhook URL</span><input class="input mono" name="url" type="url" required autocomplete="off"
      placeholder="${type === "google_chat" ? "https://chat.googleapis.com/v1/spaces/…" : "https://hooks.slack.com/services/…"}" value="${cfg.url ?? ""}"></label>`;
}

function channelForm(ch, type = ch?.type ?? "google_chat") {
  const linked = new Set(ch?.project_ids ?? state.projects.map((p) => p.id));
  return html`
    <form id="channel-form" class="modal-form" data-id="${ch?.id ?? ""}">
      <header class="modal-head">
        <div><h2>${ch ? "Edit channel" : "Add notification channel"}</h2><p class="sub">Gets a message when a monitor goes down and when it recovers.</p></div>
        ${closeBtn()}
      </header>
      <div class="modal-body">
        <div class="type-pick" role="radiogroup" ${ch ? raw("hidden") : ""}>
          ${Object.entries(CHANNEL).map(([t, info]) => html`
            <label><input type="radio" name="type" value="${t}" ${t === type ? raw("checked") : ""}><span>${chIcon(t, "sm")}${info.label}</span></label>`)}
        </div>
        <label class="field"><span>Name</span><input class="input" name="name" maxlength="80" placeholder="e.g. Ops alerts" value="${ch?.name ?? ""}"></label>
        <div id="channel-fields" class="col">${channelFieldsHtml(type, ch?.config)}</div>
        <div class="field">
          <span>Send alerts for</span>
          ${state.projects.length
            ? checkList("project_ids", state.projects, (id) => linked.has(id))
            : html`<p class="hint">No projects yet. You can attach this channel from project settings later.</p>`}
        </div>
      </div>
      <footer class="modal-foot">
        <button type="button" class="btn" data-action="test-channel">${icon("send")}Send test</button>
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${ch ? "Save changes" : "Add channel"}</button>
      </footer>
    </form>`;
}

function channelValues(form) {
  const f = form.elements;
  const type = f.type.value;
  return {
    type,
    name: f.name.value,
    config: type === "telegram" ? { token: f.token.value, chat_id: f.chat_id.value } : { url: f.url.value },
    project_ids: checked(form, "project_ids"),
  };
}

async function submitChannel(form) {
  const id = form.dataset.id;
  const body = channelValues(form);
  await (id ? api(`/channels/${id}`, { method: "PATCH", body }) : api("/channels", { body }));
  closeModal();
  toast(id ? "Channel saved" : `${CHANNEL[body.type].label} channel added`);
  render({ quiet: true });
}

// ---------- uptime kuma import ----------
function importPick(error = "") {
  return html`
    <div class="modal-form">
      <header class="modal-head">
        <div><h2>Import from Uptime Kuma</h2><p class="sub">In Uptime Kuma, go to Settings → Backup → Export, then drop the JSON file here.</p></div>
        ${closeBtn()}
      </header>
      <div class="modal-body">
        <label class="dropzone" id="dropzone">
          <input type="file" id="import-file" accept=".json,application/json" class="sr-only">
          <span class="glyph">${icon("upload")}</span>
          <strong>Drop your backup file here</strong>
          <span>or click to choose a .json file</span>
        </label>
        ${error ? html`<div class="tr-verdict bad">${icon("alert")}<span>${error}</span></div>` : ""}
        <p class="hint">HTTP and keyword monitors are imported. Nothing is saved until you confirm.</p>
      </div>
    </div>`;
}

async function readImport(file) {
  try {
    const result = convertKuma(JSON.parse(await file.text()));
    state.import = { ...result, groups: groupByDomain(result.monitors) };
    modal.innerHTML = str(importReview(state.import));
  } catch (err) {
    modal.innerHTML = str(importPick(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message));
  }
}

const findProject = (name) => state.projects.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());

function importReview({ monitors, skipped, channels, groups }) {
  return html`
    <form id="import-form" class="modal-form" data-mode="domains">
      <header class="modal-head">
        <div>
          <h2>Review import</h2>
          <p class="sub">${plural(monitors.length, "monitor")} across ${plural(groups.length, "site")}${skipped.length ? ` · ${skipped.length} skipped` : ""}. Inactive monitors come in paused.</p>
        </div>
        ${closeBtn()}
      </header>
      <div class="modal-body">
        <div class="row2">
          <label class="field"><span>Organize into</span>
            <select class="input" name="target">
              <option value="__domains" selected>One project per site (${groups.length})</option>
              <option value="">A single new project</option>
              ${state.projects.length ? html`<optgroup label="Existing project">
                ${state.projects.map((p) => html`<option value="${p.id}">${p.name}</option>`)}
              </optgroup>` : ""}
            </select>
          </label>
          <label class="field single-new" hidden><span>Project name</span><input class="input" name="project_name" maxlength="80" value="Uptime Kuma"></label>
        </div>
        ${channels.length ? html`
          <div class="field">
            <span>Notifications<em>from Uptime Kuma</em></span>
            ${checkList("kuma_channel", channels.map((c, i) => ({ id: String(i), name: c.name, type: c.type })), () => true)}
            <small class="hint">Added as channels (reused if they already exist) and attached to every imported project.</small>
          </div>` : ""}
        ${monitors.length ? html`
          <div class="import-list">
            <label class="import-row head"><input type="checkbox" id="import-all" checked><span>Select all</span><span class="muted" id="import-count">${monitors.length} selected</span></label>
            ${groups.map((g, gi) => html`
              <div class="import-group">
                <input type="checkbox" name="group" value="${gi}" checked aria-label="Select all ${g.name} monitors">
                <input class="input sm domain-only" name="group_${gi}" value="${g.name}" maxlength="80" required aria-label="Project name for ${g.domains.join(", ")}">
                <span class="group-title single-only">${g.name}</span>
                <span class="muted truncate">${g.domains.join(", ")}</span>
                <span class="domain-only">${findProject(g.name) ? html`<span class="pill">Adds to existing</span>` : html`<span class="pill up">New project</span>`}</span>
              </div>
              ${g.items.map((i) => {
                const m = monitors[i];
                return html`
                  <label class="import-row">
                    <input type="checkbox" name="pick" value="${i}" data-group="${gi}" checked>
                    <span class="mon-main"><span class="mon-name">${m.name}</span><span class="mon-url">${method(m.method)}<span class="truncate">${m.url}</span></span></span>
                    <span class="import-meta">${m.paused ? html`<span class="pill paused">Paused</span>` : ""}every ${every(m.interval_sec)}</span>
                  </label>`;
              })}`)}
          </div>` : html`<div class="tr-verdict bad">${icon("alert")}<span>Nothing in this backup can be imported.</span></div>`}
        ${skipped.length ? html`
          <details class="advanced">
            <summary>${icon("chev")}${plural(skipped.length, "monitor")} skipped</summary>
            <dl class="kv">${skipped.map((s) => html`<dt>${s.name}</dt><dd>${s.reason}</dd>`)}</dl>
          </details>` : ""}
      </div>
      <footer class="modal-foot">
        <button type="button" class="btn ghost" data-action="import">Choose another file</button>
        <span class="grow"></span>
        <button class="btn primary" type="submit" id="import-submit" ${monitors.length ? "" : raw("disabled")}>Import ${plural(monitors.length, "monitor")}</button>
      </footer>
    </form>`;
}

function syncImportCount(form) {
  const boxes = [...form.querySelectorAll("input[name=pick]")];
  const mark = (box, list) => {
    const n = list.filter((b) => b.checked).length;
    box.checked = n === list.length;
    box.indeterminate = n > 0 && n < list.length;
    return n;
  };
  for (const g of form.querySelectorAll("input[name=group]")) mark(g, boxes.filter((b) => b.dataset.group === g.value));
  const n = mark($("#import-all", form), boxes);
  $("#import-count", form).textContent = `${n} selected`;
  const btn = $("#import-submit", form);
  btn.textContent = `Import ${plural(n, "monitor")}`;
  btn.disabled = !n;
}

async function submitImport(form) {
  const f = form.elements;
  const { monitors, groups, channels } = state.import;
  const picked = new Set(checked(form, "pick").map(Number));

  // Create the picked Kuma channels, reusing any channel with the same settings.
  const existingChannels = await api("/channels");
  const channelIds = [];
  for (const i of checked(form, "kuma_channel")) {
    const ch = channels[+i];
    const same = existingChannels.find((e) => e.type === ch.type && JSON.stringify(e.config) === JSON.stringify(ch.config));
    try { channelIds.push(same ? same.id : (await api("/channels", { body: ch })).id); }
    catch (err) { toast(`Skipped channel "${ch.name}": ${err.message}`, "err"); }
  }

  // Which project gets which monitors.
  const target = f.target.value;
  const plan = target === "__domains"
    ? groups.map((g, gi) => ({ name: f[`group_${gi}`].value.trim() || g.name, description: g.domains.join(", "), items: g.items.filter((i) => picked.has(i)) }))
    : [{ id: target || null, name: f.project_name.value.trim() || "Uptime Kuma", items: [...picked] }];

  let created = 0, existing = 0;
  const failed = [], projectIds = new Set();
  for (const p of plan.filter((p) => p.items.length)) {
    let id = p.id ?? findProject(p.name)?.id;
    if (!id) {
      id = (await api("/projects", { body: { name: p.name, description: p.description ?? "", channel_ids: channelIds } })).id;
      state.projects.push({ id, name: p.name }); // two groups renamed to the same name land in one project
    } else if (channelIds.length) {
      const { project } = await api(`/projects/${id}`);
      const ids = [...new Set([...project.channels.map((c) => c.id), ...channelIds])];
      await api(`/projects/${id}`, { method: "PATCH", body: { channel_ids: ids } });
    }
    const r = await api(`/projects/${id}/import`, { body: { monitors: p.items.map((i) => monitors[i]) } });
    created += r.created;
    existing += r.existing;
    failed.push(...r.failed);
    projectIds.add(id);
  }

  state.import = null;
  closeModal();
  navigate(projectIds.size === 1 ? `/projects/${[...projectIds][0]}` : "/");
  const summary = `Imported ${plural(created, "monitor")} into ${plural(projectIds.size, "project")}${existing ? `. Skipped ${plural(existing, "duplicate")}` : ""}.`;
  if (!failed.length) return toast(summary);
  openModal(html`
    <div class="modal-form">
      <header class="modal-head"><div><h2>${summary}</h2><p class="sub">${plural(failed.length, "monitor")} couldn't be imported:</p></div>${closeBtn()}</header>
      <div class="modal-body"><dl class="kv" style="padding:0">${failed.map((x) => html`<dt>${x.name}</dt><dd>${x.error}</dd>`)}</dl></div>
    </div>`);
}

// ---------- actions ----------
function busy(btn, on) { btn.disabled = on; btn.classList.toggle("busy", on); }

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = str(html`${icon(kind === "ok" ? "check" : "alert")}<span>${msg}</span>`);
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 250); }, kind === "ok" ? 3000 : 5000);
}

const actions = {
  async "new-project"() {
    state.channels = await api("/channels");
    openModal(projectForm());
  },
  async "edit-project"() {
    state.channels = await api("/channels");
    openModal(projectForm(state.page.project));
  },
  "new-channel": (el) => openModal(channelForm(null, el.dataset.type)),
  "edit-channel": (el) => openModal(channelForm(state.channels.find((c) => c.id === el.dataset.id))),

  async "delete-channel"(el) {
    const ch = state.channels.find((c) => c.id === el.dataset.id);
    if (!(await confirmDialog({ title: `Delete "${ch.name}"?`, body: `Projects using it will stop sending alerts to this ${CHANNEL[ch.type].label} channel.` }))) return;
    await api(`/channels/${ch.id}`, { method: "DELETE" });
    toast("Channel deleted");
    render({ quiet: true });
  },

  async "test-channel"(btn) {
    const form = btn.closest("#channel-form");
    const body = form ? channelValues(form) : state.channels.find((c) => c.id === btn.dataset.id);
    busy(btn, true);
    try {
      await api("/channels/test", { body: { type: body.type, name: body.name, config: body.config } });
      toast(`Test sent. Check ${CHANNEL[body.type].label}.`);
    } finally { busy(btn, false); }
  },

  async "detect-chats"(btn) {
    const form = btn.closest("form");
    const box = $("#chat-results", form);
    busy(btn, true);
    try {
      const chats = await api("/telegram/chats", { body: { token: form.elements.token.value } });
      box.innerHTML = str(chats.length
        ? html`<div class="chat-chips">${chats.map((c) => html`<button type="button" class="chip" data-action="pick-chat" data-id="${c.id}">${c.title}<span>${c.id}</span></button>`)}</div>`
        : html`<p class="hint">No chats found. Send your bot a message (or post in the group it's in), then click Detect again.</p>`);
      if (chats.length === 1) form.elements.chat_id.value = chats[0].id;
    } finally { busy(btn, false); }
  },

  "pick-chat"(el) {
    el.closest("form").elements.chat_id.value = el.dataset.id;
    for (const c of el.parentElement.children) c.classList.toggle("active", c === el);
  },
  "new-monitor": () => openModal(monitorForm(), "wide"),
  "edit-monitor": () => {
    openModal(monitorForm(state.page.monitor), "wide");
    updatePreview($("#monitor-form"));
  },
  "close-modal": closeModal,
  import: () => openModal(importPick()),

  async "delete-project"() {
    const p = state.page.project;
    if (!(await confirmDialog({ title: `Delete "${p.name}"?`, body: "All monitors and their history in this project will be deleted. This can't be undone." }))) return;
    await api(`/projects/${p.id}`, { method: "DELETE" });
    closeModal();
    toast("Project deleted");
    navigate("/");
  },

  async "delete-monitor"() {
    const m = state.page.monitor;
    if (!(await confirmDialog({ title: `Delete "${m.name}"?`, body: "Its check history will be deleted too. This can't be undone." }))) return;
    await api(`/monitors/${m.id}`, { method: "DELETE" });
    toast("Monitor deleted");
    navigate(`/projects/${m.project_id}`);
  },

  async "toggle-pause"(btn) {
    const m = state.page.monitor;
    busy(btn, true);
    try {
      await api(`/monitors/${m.id}`, { method: "PATCH", body: { paused: !m.paused } });
      toast(m.paused ? "Monitor resumed" : "Monitor paused");
      await render({ quiet: true });
    } finally { busy(btn, false); }
  },

  async ack(btn) {
    busy(btn, true);
    try {
      await api(`/monitors/${state.page.monitor.id}/ack`, { body: {} });
      toast("Acknowledged. Reminders stopped, and the team was told.");
      await render({ quiet: true });
    } finally { busy(btn, false); }
  },

  mute(el) {
    const what = el.dataset.target === "projects" ? "this project" : "this monitor";
    openModal(html`
      <div class="modal-form">
        <header class="modal-head"><div><h2>Mute alerts</h2><p class="sub">Checks keep running and history is kept. Only messages to Google Chat and Telegram stop for ${what}.</p></div>${closeBtn()}</header>
        <div class="modal-body"><div class="mute-grid">
          ${MUTE.map(([v, l]) => html`<button class="btn" data-action="mute-set" data-target="${el.dataset.target}" data-id="${el.dataset.id}" data-minutes="${v}">${l}</button>`)}
        </div></div>
      </div>`);
  },

  "mute-set": (el) => setMute(el.dataset.target, el.dataset.id, Number(el.dataset.minutes)),
  unmute: (el) => setMute(el.dataset.target, el.dataset.id, 0),

  "add-step"() {
    const list = $("#steps");
    list.insertAdjacentHTML("beforeend", str(stepBlock({}, list.children.length)));
    list.lastElementChild.querySelector("[name=step_name]").focus();
  },

  "remove-step"(el) {
    const list = el.closest("#steps");
    el.closest(".step").remove();
    [...list.children].forEach((st, i) => { st.querySelector("b").textContent = `Step ${i + 1}`; });
  },

  async "check-detail"(el) {
    hideTip();
    openModal(diagnose(await api(`/checks/${el.dataset.id}`)), "wide");
  },

  async "run-now"(btn) {
    busy(btn, true);
    try {
      const r = await api(`/monitors/${state.page.monitor.id}/run`, { body: {} });
      toast(r.ok ? `Up · ${r.status_code} in ${ms(r.latency_ms)}` : `Down · ${r.error}`, r.ok ? "ok" : "err");
      await render({ quiet: true });
    } finally { busy(btn, false); }
  },

  async "test-request"(btn) {
    const form = btn.closest("form");
    const panel = $("#test-panel", form);
    busy(btn, true);
    panel.classList.add("has-result");
    panel.innerHTML = str(html`<div class="test-loading"><span class="spinner"></span>Sending request…</div>`);
    try {
      panel.innerHTML = str(testResult(await api("/test", { body: monitorValues(form) })));
    } catch (err) {
      panel.innerHTML = str(html`<div class="tr-verdict bad">${icon("alert")}<span>${err.message}</span></div>`);
    } finally { busy(btn, false); }
  },

  filter(btn) {
    state.filter.status = btn.dataset.status;
    rerenderList();
  },

  reveal(el) {
    el.textContent = el.dataset.value;
    el.classList.remove("secret");
    el.removeAttribute("data-action");
    el.removeAttribute("data-tip");
    hideTip();
  },

  async copy(btn) {
    await navigator.clipboard.writeText(btn.dataset.value);
    toast("Copied to clipboard");
  },

  "toggle-theme"() {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.dataset.theme || (dark ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  },

  "toggle-nav"() { document.body.classList.toggle("nav-open"); },
};

async function setMute(target, id, minutes) {
  await api(`/${target}/${id}/mute`, { body: { minutes } });
  if (modal.open) closeModal();
  toast(minutes ? `Alerts muted for ${label(MUTE, minutes)}` : "Alerts unmuted");
  render({ quiet: true });
}

async function submitProject(form) {
  const id = form.dataset.id;
  const f = form.elements;
  const body = {
    name: f.name.value, description: f.description.value, channel_ids: checked(form, "channel_ids"),
    remind_min: Number(f.remind_min.value), escalate_min: Number(f.escalate_min.value), escalate_to: checked(form, "escalate_to"),
  };
  const p = id ? await api(`/projects/${id}`, { method: "PATCH", body }) : await api("/projects", { body });
  closeModal();
  toast(id ? "Project saved" : "Project created");
  id ? render({ quiet: true }) : navigate(`/projects/${p.id}`);
}

async function submitMonitor(form) {
  const id = form.dataset.id;
  const body = monitorValues(form);
  const m = id
    ? await api(`/monitors/${id}`, { method: "PATCH", body })
    : await api(`/projects/${state.page.projectId}/monitors`, { body });
  closeModal();
  if (id) {
    toast("Monitor saved");
    return render({ quiet: true });
  }
  if (m.type === "heartbeat") {
    toast("Heartbeat created. Add the ping URL to your job.");
    return navigate(`/monitors/${m.id}`);
  }
  toast("Monitor created. Running the first check…");
  navigate(`/monitors/${m.id}`);
  // The first check runs in the background. Pick up its result.
  setTimeout(() => location.pathname === `/monitors/${m.id}` && render({ quiet: true }), 2500);
}

// ---------- tooltip ----------
const tip = $("#tip");
function hideTip() { tip.classList.remove("show"); }
document.addEventListener("pointerover", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el || e.pointerType === "touch") return hideTip();
  tip.textContent = el.dataset.tip;
  tip.classList.add("show");
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
  const top = r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
});
document.addEventListener("scroll", hideTip, true);

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[href^='/']");
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
    e.preventDefault();
    if (modal.open) closeModal();
    if (link.getAttribute("href") !== location.pathname) navigate(link.getAttribute("href"));
    else document.body.classList.remove("nav-open");
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  try { await actions[el.dataset.action](el, e); }
  catch (err) { toast(err.message, "err"); }
});

document.addEventListener("submit", async (e) => {
  const form = e.target;
  const handler = { "project-form": submitProject, "monitor-form": submitMonitor, "import-form": submitImport, "channel-form": submitChannel }[form.id];
  if (!handler) return;
  e.preventDefault();
  const btn = form.querySelector("[type=submit]");
  busy(btn, true);
  try { await handler(form); }
  catch (err) { toast(err.message, "err"); }
  finally { busy(btn, false); }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "mon-search") { state.filter.q = t.value; rerenderList(); }
  if (t.form?.id === "monitor-form" && t.name === "name") t.dataset.touched = "1";
  if (t.form?.id === "monitor-form" && t.name === "curl") {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => updatePreview(t.form), 250);
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "import-file" && t.files[0]) readImport(t.files[0]);
  if (t.name === "type" && t.form?.id === "channel-form") $("#channel-fields", t.form).innerHTML = str(channelFieldsHtml(t.value));
  if (t.name === "type" && t.form?.id === "monitor-form") t.form.dataset.type = t.value;
  const form = t.closest?.("#import-form");
  if (!form) return;
  if (t.name === "target") {
    form.dataset.mode = t.value === "__domains" ? "domains" : "single";
    $(".single-new", form).hidden = t.value !== "";
  }
  if (t.id === "import-all") for (const b of form.querySelectorAll("input[name=pick]")) b.checked = t.checked;
  if (t.name === "group") for (const b of form.querySelectorAll(`input[name=pick][data-group="${t.value}"]`)) b.checked = t.checked;
  if (t.id === "import-all" || t.name === "pick" || t.name === "group") syncImportCount(form);
});

// Drag and drop onto the import drop zone.
for (const type of ["dragover", "dragleave", "drop"]) {
  document.addEventListener(type, (e) => {
    const zone = e.target.closest?.("#dropzone");
    if (!zone) return;
    e.preventDefault();
    zone.classList.toggle("over", type === "dragover");
    if (type === "drop" && e.dataTransfer.files[0]) readImport(e.dataTransfer.files[0]);
  });
}

document.addEventListener("pointermove", chartHover);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
$("#confirm").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
addEventListener("popstate", () => render());
addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.body.classList.remove("nav-open");
});

// Live-ish: refresh the current page every 20s while visible and not mid-edit.
setInterval(() => {
  if (document.visibilityState === "visible" && !modal.open && !$("#confirm").open) render({ quiet: true });
}, 20_000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && !modal.open && render({ quiet: true }));

api("/me").then((r) => { state.me = r.email; }).catch(() => {}).finally(() => render());
