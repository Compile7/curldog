import { CurlError, parseCurl } from "./curl.ts";
import { checkAndRecord, REGIONS, runCheck, validExpected, type MonitorRow, type Row, type Step } from "./check.ts";
import { getUser, type AuthEnv } from "./auth.ts";
import { ackCard, deliver, send, sendAll, testCard, telegramChats, type Channel, type ChannelType } from "./notify.ts";
import { refreshExpiry, registrable, remind, weeklyReport } from "./jobs.ts";
import type { Prober } from "./prober.ts";

export { Prober } from "./prober.ts";

interface Env extends AuthEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai;
  PROBER?: DurableObjectNamespace<Prober>;
  APP_URL?: string; // public URL of this app, used for links in alerts
}

interface Ctx {
  req: Request;
  env: Env;
  exec: ExecutionContext;
  user: string;
  params: Record<string, string>;
}

type Body = Record<string, unknown>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INTERVALS = [60, 300, 600, 900, 1800, 3600];
const REMIND_MIN = [0, 15, 30, 60, 120, 240];
const MUTE_MIN = [0, 30, 60, 120, 240, 480, 1440];
const HEARTBEAT_REQUEST = JSON.stringify({ method: "", url: "", headers: [], body: null, followRedirects: false });
const RETAIN_CHECKS = 30 * DAY;
const RETAIN_EVENTS = 90 * DAY;

const bad = (msg: string): never => { throw new HttpError(400, msg); };
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const json = (data: unknown, status = 200) => Response.json(data, { status });

// --- input validation ---

function projectFields(b: Body, prev?: Record<string, unknown>) {
  const name = String(b.name ?? prev?.name ?? "").trim();
  if (!name || name.length > 80) bad("Project name is required (max 80 characters).");
  const description = String(b.description ?? prev?.description ?? "").trim().slice(0, 280);
  const remind_min = Number(b.remind_min ?? prev?.remind_min ?? 0);
  const escalate_min = Number(b.escalate_min ?? prev?.escalate_min ?? 0);
  if (!REMIND_MIN.includes(remind_min) || !REMIND_MIN.includes(escalate_min)) bad("Pick a valid reminder or escalation time.");
  const escalate_to = JSON.stringify(idList(b.escalate_to) ?? JSON.parse(String(prev?.escalate_to ?? "[]")));
  return { name, description, remind_min, escalate_min, escalate_to };
}

const CHANNEL_TYPES: Record<ChannelType, string> = { google_chat: "Google Chat", telegram: "Telegram", webhook: "Webhook" };

function channelFields(b: Body) {
  const type = String(b.type) as ChannelType;
  if (!(type in CHANNEL_TYPES)) bad("Pick a channel type.");
  const name = String(b.name ?? "").trim() || CHANNEL_TYPES[type];
  if (name.length > 80) bad("Name is too long (max 80 characters).");
  const c = (b.config && typeof b.config === "object" ? b.config : {}) as Body;
  let config: Record<string, string>;
  if (type === "telegram") {
    const token = String(c.token ?? "").trim();
    const chat_id = String(c.chat_id ?? "").trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) bad("That doesn't look like a Telegram bot token (e.g. 123456:ABC-DEF…).");
    if (!/^-?\d+$|^@\w{4,}$/.test(chat_id)) bad("Chat ID must be a number like -1001234567890, or @channelname.");
    config = { token, chat_id };
  } else {
    const url = String(c.url ?? "").trim();
    if (type === "google_chat" && !url.startsWith("https://chat.googleapis.com/")) bad("Google Chat webhook URLs start with https://chat.googleapis.com/");
    if (!/^https:\/\/\S+$/.test(url)) bad("Webhook URL must start with https://");
    config = { url };
  }
  return { name, type, config: JSON.stringify(config) };
}

const idList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? [...new Set(v.map(String))].slice(0, 200) : undefined;

// Replace the links on one side of project_channels. Unknown ids are skipped by the INSERT ... SELECT.
function linkStatements(env: Env, side: "project" | "channel", id: string, others: string[]) {
  const [mine, theirs, table] = side === "project" ? ["project_id", "channel_id", "channels"] : ["channel_id", "project_id", "projects"];
  return [
    env.DB.prepare(`DELETE FROM project_channels WHERE ${mine} = ?`).bind(id),
    ...others.map((o) => env.DB.prepare(
      `INSERT OR IGNORE INTO project_channels (${mine}, ${theirs}) SELECT ?, id FROM ${table} WHERE id = ?`).bind(id, o)),
  ];
}

// Channels per project, for alerting.
async function channelsByProject(env: Env, projectId?: string) {
  const q = `SELECT pc.project_id, c.type, c.config FROM project_channels pc JOIN channels c ON c.id = pc.channel_id`;
  const { results } = await (projectId
    ? env.DB.prepare(q + " WHERE pc.project_id = ?").bind(projectId)
    : env.DB.prepare(q)).all<Channel & { project_id: string }>();
  const map = new Map<string, Channel[]>();
  for (const r of results) {
    if (!map.has(r.project_id)) map.set(r.project_id, []);
    map.get(r.project_id)!.push(r);
  }
  return map;
}

// "token = $.access_token" and "session = header:Set-Cookie", one per line.
function parseVars(v: unknown, label: string): [string, string][] {
  if (Array.isArray(v)) return v.map(([k, p]) => [String(k), String(p)]);
  return String(v ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = /^(\w+)\s*=\s*(\$\S*|header:\s*[\w-]+)$/i.exec(line);
    if (!m) bad(`${label}: "${line}" should look like "token = $.access_token" or "sid = header:Set-Cookie".`);
    return [m![1], m![2]] as [string, string];
  });
}

function stepFields(list: unknown): Step[] {
  if (!Array.isArray(list)) return [];
  if (list.length > 5) bad("Up to 5 steps before the main request.");
  return list.map((raw, i) => {
    const s = (raw && typeof raw === "object" ? raw : {}) as Body;
    const label = `Step ${i + 1}`;
    const curl = String(s.curl ?? "").trim();
    if (!curl) bad(`${label}: paste a curl command.`);
    let request;
    try { request = parseCurl(curl); } catch (e) { bad(`${label}: ${(e as Error).message}`); }
    return { name: String(s.name ?? "").trim().slice(0, 60) || label, curl, request: JSON.stringify(request), vars: parseVars(s.vars, label) };
  });
}

function monitorFields(b: Body, prev?: MonitorRow) {
  const name = String(b.name ?? prev?.name ?? "").trim();
  if (!name || name.length > 100) bad("Monitor name is required (max 100 characters).");
  const type = prev?.type ?? (b.type === "heartbeat" ? "heartbeat" : "http");
  const interval_sec = Number(b.interval_sec ?? prev?.interval_sec ?? 300);
  if (!INTERVALS.includes(interval_sec)) bad("Pick a valid check interval.");
  const paused = b.paused === undefined ? (prev?.paused ?? 0) : b.paused ? 1 : 0;
  if (type === "heartbeat") {
    return { type, name, curl: "", request: HEARTBEAT_REQUEST, steps: "[]", regions: 0, slow_ms: 0, interval_sec,
      timeout_ms: 10_000, expected_status: "200-399", keyword: "", paused };
  }
  const curl = String(b.curl ?? prev?.curl ?? "").trim();
  if (!curl) bad("Paste a curl command.");
  if (curl.length > 20_000) bad("curl command is too long.");
  const request = parseCurl(curl);
  const steps = JSON.stringify(b.steps === undefined ? JSON.parse(prev?.steps ?? "[]") : stepFields(b.steps));
  const regions = (b.regions ?? prev?.regions) ? 1 : 0;
  const slow_ms = Number(b.slow_ms ?? prev?.slow_ms ?? 0);
  if (slow_ms && !(slow_ms >= 100 && slow_ms <= 60_000)) bad("Slow alert threshold must be between 100 ms and 60 s.");
  const timeout_ms = Number(b.timeout_ms ?? prev?.timeout_ms ?? request.timeoutMs ?? 10_000);
  if (!(timeout_ms >= 1000 && timeout_ms <= 30_000)) bad("Timeout must be between 1 and 30 seconds.");
  const expected_status = String(b.expected_status ?? prev?.expected_status ?? "").trim() || "200-399";
  if (!validExpected(expected_status)) bad('Expected status must look like "200", "2xx", "200-299" or "200,204".');
  const keyword = String(b.keyword ?? prev?.keyword ?? "").slice(0, 500);
  return { type, name, curl, request: JSON.stringify(request), steps, regions, slow_ms, interval_sec, timeout_ms, expected_status, keyword, paused };
}

const publicMonitor = ({ last_ok: _, ...m }: MonitorRow) => ({ ...m, request: JSON.parse(m.request), steps: JSON.parse(m.steps) });

async function getProject(env: Env, id: string) {
  const p = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  return p ?? bad("Project not found.");
}

async function getMonitor(env: Env, id: string) {
  const m = await env.DB.prepare(
    "SELECT m.*, p.name AS project_name FROM monitors m JOIN projects p ON p.id = m.project_id WHERE m.id = ?",
  ).bind(id).first<MonitorRow & { project_name: string }>();
  if (!m) throw new HttpError(404, "Monitor not found.");
  return m;
}

const PROJECTS_SQL = `
  SELECT p.id, p.name, p.description, p.muted_until, p.created_by, p.created_at,
    (SELECT COUNT(*) FROM project_channels pc WHERE pc.project_id = p.id) AS channels,
    COUNT(m.id) AS total,
    COALESCE(SUM(m.paused = 0 AND m.status = 'up'), 0) AS up,
    COALESCE(SUM(m.paused = 0 AND m.status = 'down'), 0) AS down,
    COALESCE(SUM(m.paused = 0 AND m.status = 'pending'), 0) AS pending,
    COALESCE(SUM(m.paused), 0) AS paused
  FROM projects p LEFT JOIN monitors m ON m.project_id = p.id
  GROUP BY p.id ORDER BY p.name COLLATE NOCASE`;

// --- routes ---

const routes: [string, RegExp, (c: Ctx) => Promise<unknown>][] = [];
const route = (method: string, path: string, h: (c: Ctx) => Promise<unknown>) =>
  routes.push([method, new RegExp("^/api" + path.replace(/:(\w+)/g, "(?<$1>[\\w-]+)") + "$"), h]);
const body = async (c: Ctx) => ((await c.req.json().catch(() => ({}))) ?? {}) as Body;

route("GET", "/me", async (c) => ({ email: c.user }));

route("GET", "/projects", async (c) => (await c.env.DB.prepare(PROJECTS_SQL).all()).results);

route("GET", "/overview", async (c) => {
  const [down, events] = await c.env.DB.batch([
    c.env.DB.prepare(`
      SELECT m.id, m.name, m.project_id, p.name AS project_name, m.last_error, m.last_checked_at, m.request
      FROM monitors m JOIN projects p ON p.id = m.project_id
      WHERE m.paused = 0 AND m.status = 'down' ORDER BY m.last_checked_at DESC`),
    c.env.DB.prepare(`
      SELECT e.ts, e.status, e.error, m.id AS monitor_id, m.name AS monitor_name, p.name AS project_name
      FROM events e JOIN monitors m ON m.id = e.monitor_id JOIN projects p ON p.id = m.project_id
      ORDER BY e.ts DESC LIMIT 12`),
  ]);
  return {
    down: (down.results as unknown as MonitorRow[]).map((m) => ({ ...m, request: JSON.parse(m.request) })),
    events: events.results,
  };
});

route("POST", "/projects", async (c) => {
  const b = await body(c);
  const f = projectFields(b);
  const p = { id: newId(), ...f, created_by: c.user, created_at: Date.now() };
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO projects (id, name, description, remind_min, escalate_min, escalate_to, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(p.id, p.name, p.description, p.remind_min, p.escalate_min, p.escalate_to, p.created_by, p.created_at),
    ...linkStatements(c.env, "project", p.id, idList(b.channel_ids) ?? []),
  ]);
  return p;
});

route("GET", "/projects/:id", async (c) => {
  const project = await getProject(c.env, c.params.id);
  const since = Date.now() - DAY;
  const [monitors, spark, uptime, channels] = await c.env.DB.batch([
    c.env.DB.prepare(`
      SELECT id, type, name, request, token, interval_sec, paused, status, slow, muted_until, acked_by, last_checked_at, last_latency_ms, last_error
      FROM monitors WHERE project_id = ? ORDER BY name COLLATE NOCASE`).bind(project.id),
    c.env.DB.prepare(`
      SELECT monitor_id, ts, ok, latency_ms FROM (
        SELECT c.monitor_id, c.ts, c.ok, c.latency_ms,
          ROW_NUMBER() OVER (PARTITION BY c.monitor_id ORDER BY c.ts DESC) AS rn
        FROM checks c JOIN monitors m ON m.id = c.monitor_id
        WHERE m.project_id = ? AND c.ts > ?
      ) WHERE rn <= 30 ORDER BY ts`).bind(project.id, since),
    c.env.DB.prepare(`
      SELECT c.monitor_id, AVG(c.ok) AS uptime FROM checks c JOIN monitors m ON m.id = c.monitor_id
      WHERE m.project_id = ? AND c.ts > ? GROUP BY c.monitor_id`).bind(project.id, since),
    c.env.DB.prepare(`
      SELECT c.id, c.name, c.type FROM project_channels pc JOIN channels c ON c.id = pc.channel_id
      WHERE pc.project_id = ? ORDER BY c.name COLLATE NOCASE`).bind(project.id),
  ]);
  const sparks = new Map<string, unknown[]>();
  for (const s of spark.results as { monitor_id: string }[]) {
    if (!sparks.has(s.monitor_id)) sparks.set(s.monitor_id, []);
    sparks.get(s.monitor_id)!.push(s);
  }
  const uptimes = new Map((uptime.results as { monitor_id: string; uptime: number }[]).map((u) => [u.monitor_id, u.uptime]));
  return {
    project: { ...project, channels: channels.results },
    monitors: (monitors.results as unknown as MonitorRow[]).map(({ request, token, ...m }) => {
      const r = JSON.parse(request);
      const [method, url] = m.type === "heartbeat" ? ["PING", `/hb/${token}`] : [r.method, r.url];
      return { ...m, method, url, spark: sparks.get(m.id) ?? [], uptime: uptimes.get(m.id) ?? null };
    }),
  };
});

route("PATCH", "/projects/:id", async (c) => {
  const prev = await getProject(c.env, c.params.id);
  const b = await body(c);
  const f = projectFields(b, prev);
  const ids = idList(b.channel_ids);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE projects SET name = ?, description = ?, remind_min = ?, escalate_min = ?, escalate_to = ? WHERE id = ?")
      .bind(f.name, f.description, f.remind_min, f.escalate_min, f.escalate_to, prev.id),
    ...(ids ? linkStatements(c.env, "project", prev.id as string, ids) : []),
  ]);
  return { ...prev, ...f };
});

// --- notification channels ---

route("GET", "/channels", async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT c.*, (SELECT json_group_array(project_id) FROM project_channels pc WHERE pc.channel_id = c.id) AS project_ids
    FROM channels c ORDER BY c.name COLLATE NOCASE`).all<Record<string, string>>();
  return results.map((r) => ({ ...r, config: JSON.parse(r.config), project_ids: JSON.parse(r.project_ids) }));
});

route("POST", "/channels", async (c) => {
  const b = await body(c);
  const f = channelFields(b);
  const ch = { id: newId(), ...f, created_by: c.user, created_at: Date.now() };
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO channels (id, name, type, config, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ch.id, ch.name, ch.type, ch.config, ch.created_by, ch.created_at),
    ...linkStatements(c.env, "channel", ch.id, idList(b.project_ids) ?? []),
  ]);
  return { ...ch, config: JSON.parse(ch.config) };
});

route("PATCH", "/channels/:id", async (c) => {
  const b = await body(c);
  const f = channelFields(b);
  const ids = idList(b.project_ids);
  if (!(await c.env.DB.prepare("SELECT 1 FROM channels WHERE id = ?").bind(c.params.id).first())) {
    throw new HttpError(404, "Channel not found.");
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE channels SET name = ?, type = ?, config = ? WHERE id = ?").bind(f.name, f.type, f.config, c.params.id),
    ...(ids ? linkStatements(c.env, "channel", c.params.id, ids) : []),
  ]);
  return { id: c.params.id, ...f, config: JSON.parse(f.config) };
});

route("DELETE", "/channels/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(c.params.id).run();
});

route("POST", "/channels/test", async (c) => {
  const f = channelFields(await body(c));
  try {
    await send(f, testCard());
  } catch (e) {
    bad(`${CHANNEL_TYPES[f.type]} rejected the message: ${(e as Error).message}`);
  }
});

route("POST", "/telegram/chats", async (c) => {
  const token = String((await body(c)).token ?? "").trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) bad("Enter the bot token first.");
  try {
    return await telegramChats(token);
  } catch (e) {
    bad((e as Error).message);
  }
});

route("DELETE", "/projects/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(c.params.id).run();
});

route("POST", "/parse", async (c) => parseCurl(String((await body(c)).curl ?? "")));

route("POST", "/test", async (c) => {
  const b = await body(c);
  const f = monitorFields({ ...b, name: b.name || "test", type: "http" });
  return runCheck(f);
});

function newMonitor(env: Env, projectId: string, f: ReturnType<typeof monitorFields>, user: string, nextCheckAt: number) {
  const token = f.type === "heartbeat" ? [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, "0")).join("") : null;
  const m: MonitorRow = {
    id: newId(), project_id: projectId, ...f, type: f.type as MonitorRow["type"], status: "pending", token,
    slow: 0, slow_since: null, muted_until: 0, last_ping_at: null, down_since: null, acked_by: null, acked_at: null,
    reminded_at: null, escalated_at: null, last_ok: null,
    last_checked_at: null, last_latency_ms: null, last_error: null,
    next_check_at: nextCheckAt, created_by: user, created_at: Date.now(),
  };
  const stmt = env.DB.prepare(`
    INSERT INTO monitors (id, project_id, type, name, curl, request, steps, regions, slow_ms, token, interval_sec, timeout_ms,
      expected_status, keyword, paused, status, next_check_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(m.id, m.project_id, m.type, m.name, m.curl, m.request, m.steps, m.regions, m.slow_ms, m.token, m.interval_sec,
      m.timeout_ms, m.expected_status, m.keyword, m.paused, m.status, m.next_check_at, m.created_by, m.created_at);
  return { m, stmt };
}

// Runs one monitor now and sends its alert straight away.
async function runOne(env: Env, m: MonitorRow) {
  const p = await env.DB.prepare("SELECT name, muted_until FROM projects WHERE id = ?").bind(m.project_id).first<{ name: string; muted_until: number }>();
  const out = await checkAndRecord(env, { ...m, project_name: p?.name ?? "", project_muted_until: p?.muted_until });
  if (out.alert) await deliver([out.alert], await channelsByProject(env, m.project_id), env.APP_URL);
  return out.result;
}

route("POST", "/projects/:id/monitors", async (c) => {
  const project = await getProject(c.env, c.params.id);
  const f = monitorFields(await body(c));
  const { m, stmt } = newMonitor(c.env, project.id as string, f, c.user, Date.now() + (checkEvery(f)) * 1000);
  await stmt.run();
  // First check right away, so the new monitor isn't blank for a minute.
  if (!m.paused && m.type === "http") c.exec.waitUntil(runOne(c.env, m));
  return publicMonitor(m);
});

// Heartbeats are evaluated every minute; HTTP monitors on their own interval.
const checkEvery = (m: { type: string; interval_sec: number }) => (m.type === "heartbeat" ? 60 : m.interval_sec);

// Bulk create (used by the Uptime Kuma import). Valid monitors are saved; invalid ones come back with a reason.
route("POST", "/projects/:id/import", async (c) => {
  const project = await getProject(c.env, c.params.id);
  const list = (await body(c)).monitors;
  if (!Array.isArray(list) || !list.length || list.length > 500) bad("Send between 1 and 500 monitors.");
  // Re-importing the same backup shouldn't duplicate monitors: skip any curl the project already has.
  const { results } = await c.env.DB.prepare("SELECT curl FROM monitors WHERE project_id = ?").bind(project.id).all<{ curl: string }>();
  const seen = new Set(results.map((r) => r.curl));
  const stmts: D1PreparedStatement[] = [];
  const failed: { name: string; error: string }[] = [];
  let existing = 0;
  for (const item of list as unknown[]) {
    const b = (item && typeof item === "object" ? item : {}) as Body;
    try {
      const f = monitorFields(b);
      if (seen.has(f.curl)) { existing++; continue; }
      seen.add(f.curl);
      // next_check_at 0: everything gets its first check on the next cron tick.
      stmts.push(newMonitor(c.env, project.id as string, f, c.user, 0).stmt);
    } catch (e) {
      if (!(e instanceof HttpError || e instanceof CurlError)) throw e;
      failed.push({ name: String(b.name ?? "Unnamed"), error: e.message });
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
  return { created: stmts.length, existing, failed };
});

route("GET", "/monitors/:id", async (c) => {
  const m = await getMonitor(c.env, c.params.id);
  const now = Date.now();
  const host = m.type === "http" ? new URL(JSON.parse(m.request).url).hostname : "";
  const [stats, checks, events, expiry] = await c.env.DB.batch([
    c.env.DB.prepare(`
      SELECT AVG(CASE WHEN ts > ?1 THEN ok END) AS u24, AVG(CASE WHEN ts > ?2 THEN ok END) AS u7, AVG(ok) AS u30,
        AVG(CASE WHEN ts > ?1 AND ok = 1 THEN latency_ms END) AS avg24
      FROM checks WHERE monitor_id = ?3 AND ts > ?4`).bind(now - DAY, now - 7 * DAY, m.id, now - 30 * DAY),
    c.env.DB.prepare("SELECT rowid AS id, ts, ok, status_code, latency_ms, error, detail IS NOT NULL AS has_detail FROM checks WHERE monitor_id = ? AND ts > ? ORDER BY ts")
      .bind(m.id, now - DAY),
    c.env.DB.prepare("SELECT ts, status, error, summary, actor FROM events WHERE monitor_id = ? ORDER BY ts DESC LIMIT 20").bind(m.id),
    c.env.DB.prepare("SELECT kind, host, expires_at, error, checked_at FROM expiry WHERE (kind = 'ssl' AND host = ?) OR (kind = 'domain' AND host = ?)")
      .bind(host, host && registrable(host)),
  ]);
  return { monitor: publicMonitor(m), stats: stats.results[0], checks: checks.results, events: events.results, expiry: expiry.results };
});

route("PATCH", "/monitors/:id", async (c) => {
  const prev = await getMonitor(c.env, c.params.id);
  const f = monitorFields(await body(c), prev);
  const resumed = prev.paused && !f.paused;
  const requestChanged = f.request !== prev.request || f.steps !== prev.steps || f.expected_status !== prev.expected_status || f.keyword !== prev.keyword;
  // Re-check on the next cron tick after a resume or a request change.
  const next_check_at = resumed || requestChanged ? 0 : prev.next_check_at;
  await c.env.DB.prepare(`
    UPDATE monitors SET name = ?, curl = ?, request = ?, steps = ?, regions = ?, slow_ms = ?, interval_sec = ?, timeout_ms = ?,
      expected_status = ?, keyword = ?, paused = ?, next_check_at = ? WHERE id = ?`)
    .bind(f.name, f.curl, f.request, f.steps, f.regions, f.slow_ms, f.interval_sec, f.timeout_ms, f.expected_status, f.keyword,
      f.paused, next_check_at, prev.id)
    .run();
  return publicMonitor({ ...prev, ...f, next_check_at });
});

route("DELETE", "/monitors/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM monitors WHERE id = ?").bind(c.params.id).run();
});

route("GET", "/checks/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT ts, ok, status_code, latency_ms, error, detail FROM checks WHERE rowid = ?")
    .bind(Number(c.params.id)).first<{ detail: string | null }>();
  if (!r) throw new HttpError(404, "Check not found.");
  const { detail, ...rest } = r;
  const d = detail ? JSON.parse(detail) : {};
  return { ...rest, ...("headers" in d ? { preview: d } : d) }; // older rows stored the response snapshot alone
});

route("POST", "/monitors/:id/run", async (c) => {
  const m = await getMonitor(c.env, c.params.id);
  if (m.type === "heartbeat") bad("Heartbeats are checked when they ping, not on demand.");
  return runOne(c.env, m);
});

route("POST", "/monitors/:id/ack", async (c) => {
  const m = await getMonitor(c.env, c.params.id);
  if (m.status !== "down") bad("This monitor isn't down, so there's nothing to acknowledge.");
  if (m.acked_by) return { acked_by: m.acked_by, acked_at: m.acked_at };
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE monitors SET acked_by = ?, acked_at = ? WHERE id = ?").bind(c.user, now, m.id),
    c.env.DB.prepare("INSERT INTO events (monitor_id, ts, status, actor) VALUES (?, ?, 'ack', ?)").bind(m.id, now, c.user),
  ]);
  // Tell the channel, so the rest of the team knows someone is on it.
  c.exec.waitUntil(channelsByProject(c.env, m.project_id).then((ch) =>
    sendAll(ch.get(m.project_id) ?? [], ackCard({ monitorId: m.id, project: m.project_name, monitor: m.name }, c.user, c.env.APP_URL), m.id)));
  return { acked_by: c.user, acked_at: now };
});

const muteUntil = (b: Body) => {
  const min = Number(b.minutes);
  if (!MUTE_MIN.includes(min)) bad("Pick how long to mute alerts for.");
  return min ? Date.now() + min * 60_000 : 0;
};

route("POST", "/monitors/:id/mute", async (c) => {
  const until = muteUntil(await body(c));
  await c.env.DB.prepare("UPDATE monitors SET muted_until = ? WHERE id = ?").bind(until, (await getMonitor(c.env, c.params.id)).id).run();
  return { muted_until: until };
});

route("POST", "/projects/:id/mute", async (c) => {
  const until = muteUntil(await body(c));
  await c.env.DB.prepare("UPDATE projects SET muted_until = ? WHERE id = ?").bind(until, (await getProject(c.env, c.params.id)).id).run();
  return { muted_until: until };
});

route("GET", "/regions", async () => REGIONS.map(([, label]) => label));

// --- scheduler ---

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

async function runDue(env: Env, now: number, channels: Map<string, Channel[]>) {
  // Claim due monitors and push their next run forward in one statement, so overlapping ticks never double-check.
  const { results } = await env.DB.prepare(`
    UPDATE monitors SET next_check_at = ?1 + (CASE type WHEN 'heartbeat' THEN 60 ELSE interval_sec END) * 1000
    WHERE paused = 0 AND next_check_at <= ?1 RETURNING *`,
  ).bind(now).all<MonitorRow>();
  if (!results.length) return;
  const projects = await env.DB.prepare("SELECT id, name, muted_until FROM projects").all<{ id: string; name: string; muted_until: number }>();
  const byId = new Map(projects.results.map((p) => [p.id, p]));
  const alerts: NonNullable<Awaited<ReturnType<typeof checkAndRecord>>["alert"]>[] = [];
  // ponytail: checks fan out from the cron run itself (50 at a time). Past ~1,000 monitors per minute,
  // the per-invocation subrequest limit bites: move checks onto a Cloudflare Queue then.
  await pool(results, 50, async (m) => {
    const p = byId.get(m.project_id);
    try {
      const out = await checkAndRecord(env, { ...m, project_name: p?.name ?? "", project_muted_until: p?.muted_until } as Row, now);
      if (out.alert) alerts.push(out.alert);
    } catch (e) {
      console.error("check failed", m.id, e);
    }
  });
  await deliver(alerts, channels, env.APP_URL);
}

// Heartbeat ping: public (no Access login), authenticated by the unguessable token in the URL.
async function ping(token: string, env: Env, exec: ExecutionContext) {
  const m = await env.DB.prepare("UPDATE monitors SET last_ping_at = ? WHERE token = ? AND type = 'heartbeat' RETURNING *")
    .bind(Date.now(), token).first<MonitorRow>();
  if (!m) return new Response("Unknown heartbeat URL.\n", { status: 404 });
  if (!m.paused && m.status !== "up") exec.waitUntil(runOne(env, m));
  return new Response("OK\n");
}

export default {
  async fetch(req, env, exec): Promise<Response> {
    const url = new URL(req.url);
    const hb = /^\/hb\/([a-f0-9]{24})\/?$/.exec(url.pathname);
    if (hb) return ping(hb[1], env, exec);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const user = await getUser(req, env);
    if (!user) return json({ error: "Not signed in. Open this app through Cloudflare Access." }, 401);
    // JSON-only writes: a cross-site <form> can't send application/json, which blocks CSRF.
    if ((req.method === "POST" || req.method === "PATCH") && !req.headers.get("content-type")?.includes("application/json")) {
      return json({ error: "Expected a JSON body." }, 415);
    }

    for (const [method, re, handler] of routes) {
      const match = method === req.method && re.exec(url.pathname);
      if (!match) continue;
      try {
        const out = await handler({ req, env, exec, user, params: match.groups ?? {} });
        return json(out ?? { ok: true });
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        if (e instanceof CurlError) return json({ error: e.message }, 400);
        console.error(e);
        return json({ error: "Something went wrong on our side." }, 500);
      }
    }
    return json({ error: "Not found." }, 404);
  },

  async scheduled(event, env, exec) {
    const now = event.scheduledTime;
    const channels = await channelsByProject(env);
    await runDue(env, now, channels);
    await remind(env, now, channels);
    const t = new Date(now);
    if (t.getUTCMinutes() !== 0) return;
    // Hourly housekeeping runs after checks, in the background, so it never delays them.
    exec.waitUntil((async () => {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM checks WHERE ts < ?").bind(now - RETAIN_CHECKS),
        env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(now - RETAIN_EVENTS),
      ]);
      await refreshExpiry(env, now, channels);
      // Monday 04:00 UTC (09:30 in India).
      if (t.getUTCDay() === 1 && t.getUTCHours() === 4) await weeklyReport(env, now);
    })().catch((e) => console.error("hourly jobs failed", e)));
  },
} satisfies ExportedHandler<Env>;
