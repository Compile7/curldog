// Cron work beyond running checks: maintenance windows, reminders and escalation, the weekly report, SSL and domain expiry.
import type { Row } from "./check.ts";
import { reminderCard, sendAll, type Alert, type Card, type Channel } from "./notify.ts";

interface JobEnv {
  DB: D1Database;
  APP_URL?: string;
}

const DAY = 86_400_000;
const pct = (v: number) => `${(Math.floor(v * 10000) / 100).toFixed(v >= 1 ? 0 : 2)}%`;
const ms = (v: number) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

export function alertFrom(m: Row, kind: Alert["kind"] = "down"): Alert {
  const req = m.type === "http" ? JSON.parse(m.request) : null;
  return {
    kind, monitorId: m.id, projectId: m.project_id, project: m.project_name, monitor: m.name,
    method: req?.method ?? "", url: req?.url ?? "Heartbeat", error: m.last_error, statusCode: null, latencyMs: m.last_latency_ms ?? 0,
  };
}

// --- maintenance windows ---

export interface Window {
  id: string;
  project_id: string;
  title: string;
  starts_at: number;
  ends_at: number;
  repeat: "none" | "daily" | "weekly";
}

const PERIOD = { none: 0, daily: DAY, weekly: 7 * DAY };

// The occurrence that's open now, else the next one. null when a one-off window is over.
// ponytail: repeats every 24h / 7d in absolute time, so a window set in local time shifts an hour when DST changes.
// Store a timezone and compute occurrences in it if that bites.
export function occurrence(w: Pick<Window, "starts_at" | "ends_at" | "repeat">, now: number): { start: number; end: number } | null {
  const p = PERIOD[w.repeat];
  if (!p || now < w.starts_at) return now < w.ends_at ? { start: w.starts_at, end: w.ends_at } : null;
  const len = w.ends_at - w.starts_at;
  const start = now - ((now - w.starts_at) % p);
  return now < start + len ? { start, end: start + len } : { start: start + p, end: start + p + len };
}

// Projects with a window open right now: their monitors aren't checked and nobody is alerted.
export async function inMaintenance(db: D1Database, now: number): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT project_id, starts_at, ends_at, repeat FROM maintenance").all<Window>();
  return new Set(results.filter((w) => (occurrence(w, now)?.start ?? Infinity) <= now).map((w) => w.project_id));
}

// --- reminders and escalation ---

type Pending = Row & { remind_min: number; escalate_min: number; escalate_to: string };

export async function remind(env: JobEnv, now: number, channels: Map<string, Channel[]>, maintenance = new Set<string>()) {
  const { results } = await env.DB.prepare(`
    SELECT m.*, p.name AS project_name, p.muted_until AS project_muted_until, p.remind_min, p.escalate_min, p.escalate_to
    FROM monitors m JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'down' AND m.paused = 0 AND m.acked_at IS NULL AND m.down_since IS NOT NULL
      AND (p.remind_min > 0 OR (p.escalate_min > 0 AND m.escalated_at IS NULL))`).all<Pending>();
  if (!results.length) return;
  const all = new Map((await env.DB.prepare("SELECT id, type, config FROM channels").all<Channel & { id: string }>()).results.map((c) => [c.id, c]));
  const app = env.APP_URL ?? "";
  for (const m of results) {
    if (maintenance.has(m.project_id) || Math.max(m.muted_until, m.project_muted_until ?? 0) > now) continue;
    const downFor = now - m.down_since!;
    if (m.escalate_min > 0 && !m.escalated_at && downFor >= m.escalate_min * 60_000) {
      const to = (JSON.parse(m.escalate_to) as string[]).map((id) => all.get(id)).filter((c) => c) as Channel[];
      await sendAll(to.length ? to : channels.get(m.project_id) ?? [], reminderCard(alertFrom(m), downFor, true, app), m.id);
      await env.DB.prepare("UPDATE monitors SET escalated_at = ?1, reminded_at = ?1 WHERE id = ?2").bind(now, m.id).run();
    } else if (m.remind_min > 0 && now - (m.reminded_at ?? m.down_since!) >= m.remind_min * 60_000) {
      await sendAll(channels.get(m.project_id) ?? [], reminderCard(alertFrom(m), downFor, false, app), m.id);
      await env.DB.prepare("UPDATE monitors SET reminded_at = ? WHERE id = ?").bind(now, m.id).run();
    }
  }
}

// --- weekly report ---

async function channelProjects(env: JobEnv) {
  const { results } = await env.DB.prepare(`
    SELECT pc.channel_id, pc.project_id, c.type, c.config FROM project_channels pc JOIN channels c ON c.id = pc.channel_id`)
    .all<Channel & { channel_id: string; project_id: string }>();
  const out = new Map<string, { channel: Channel; projects: string[] }>();
  for (const r of results) {
    if (!out.has(r.channel_id)) out.set(r.channel_id, { channel: r, projects: [] });
    out.get(r.channel_id)!.projects.push(r.project_id);
  }
  return out;
}

export async function weeklyReport(env: JobEnv, now: number) {
  const since = now - 7 * DAY;
  const [uptime, incidents, slowest] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`
      SELECT p.id, p.name, AVG(c.ok) AS uptime FROM projects p JOIN monitors m ON m.project_id = p.id
      JOIN checks c ON c.monitor_id = m.id WHERE c.ts > ? GROUP BY p.id`).bind(since),
    env.DB.prepare(`
      SELECT m.project_id, COUNT(*) AS n FROM events e JOIN monitors m ON m.id = e.monitor_id
      WHERE e.status = 'down' AND e.ts > ? GROUP BY m.project_id`).bind(since),
    env.DB.prepare(`
      SELECT m.project_id, m.name, AVG(c.latency_ms) AS avg FROM checks c JOIN monitors m ON m.id = c.monitor_id
      WHERE c.ok = 1 AND c.ts > ? AND m.type = 'http' GROUP BY m.id`).bind(since),
  ]);
  const inc = new Map(incidents.results.map((r) => [r.project_id as string, r.n as number]));
  const slow = new Map<string, { name: string; avg: number }>();
  for (const r of slowest.results as { project_id: string; name: string; avg: number }[]) {
    if (!slow.has(r.project_id) || slow.get(r.project_id)!.avg < r.avg) slow.set(r.project_id, r);
  }
  const stats = new Map((uptime.results as { id: string; name: string; uptime: number }[]).map((r) => [r.id, r]));
  const fmt = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const app = env.APP_URL ?? "";

  await Promise.all([...(await channelProjects(env)).values()].map(({ channel, projects }) => {
    const rows = projects.map((id) => stats.get(id)).filter((p) => p).sort((a, b) => a!.uptime - b!.uptime);
    if (!rows.length) return;
    const card: Card = {
      title: `📊 Weekly report · ${fmt(since)} to ${fmt(now)}`,
      lines: rows.map((p) => {
        const s = slow.get(p!.id);
        return [`${p!.uptime >= 0.999 ? "🟢" : p!.uptime >= 0.99 ? "🟡" : "🔴"} ${p!.name}: ${pct(p!.uptime)} uptime`,
          `${inc.get(p!.id) ?? 0} incidents`, s ? `slowest ${s.name} (${ms(s.avg)})` : ""].filter(Boolean).join(" · ");
      }),
      buttons: app ? [{ label: "Open CurlDog", url: app }] : [],
    };
    return sendAll([channel], card, "weekly report");
  }));
}

// --- SSL and domain expiry ---

const MULTI_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.in", "co.jp", "com.br", "co.nz", "com.sg"]);
export function registrable(host: string) {
  const parts = host.split(".");
  return parts.slice(MULTI_PART_TLDS.has(parts.slice(-2).join(".")) ? -3 : -2).join(".");
}

async function domainExpiry(domain: string): Promise<number> {
  const res = await fetch(`https://rdap.org/domain/${domain}`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/rdap+json" } });
  if (!res.ok) throw new Error(res.status === 404 ? "This domain's registry doesn't publish expiry dates (no RDAP)." : `RDAP lookup failed (${res.status}).`);
  const data = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
  const ev = data.events?.find((e) => e.eventAction === "expiration");
  if (!ev) throw new Error("The registry doesn't list an expiry date.");
  return Date.parse(ev.eventDate);
}

// ponytail: Workers can't read the certificate a server presents, so this asks Certificate Transparency logs (crt.sh)
// for the newest valid certificate for the host. That's the one served in practice; a stale cert left on a server
// would be missed. Swap for a real TLS probe if Workers ever expose peer certificates.
async function sslExpiry(host: string, now: number): Promise<number> {
  const parent = host.split(".").slice(1).join(".");
  for (const q of [host, parent.includes(".") ? `*.${parent}` : ""].filter(Boolean)) {
    const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(q)}&output=json&exclude=expired`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Certificate log lookup failed (${res.status}).`);
    const certs = (await res.json()) as { not_before: string; not_after: string }[];
    const valid = certs.map((c) => ({ from: Date.parse(c.not_before + "Z"), to: Date.parse(c.not_after + "Z") })).filter((c) => c.from <= now && c.to > now);
    if (valid.length) return valid.sort((a, b) => b.from - a.from)[0].to;
  }
  throw new Error("No valid certificate found in public logs.");
}

const WARN_DAYS = [14, 3];

// Checks a few hostnames per run (hourly), so a slow lookup never blocks the cron and each host refreshes about daily.
export async function refreshExpiry(env: JobEnv, now: number, channels: Map<string, Channel[]>, perRun = 6) {
  const { results: mons } = await env.DB.prepare("SELECT project_id, request FROM monitors WHERE type = 'http'").all<{ project_id: string; request: string }>();
  const users = new Map<string, Set<string>>(); // "kind host" -> project ids
  for (const m of mons) {
    const u = new URL(JSON.parse(m.request).url);
    if (/^[\d.]+$|:/.test(u.hostname)) continue;
    const keys = [`domain ${registrable(u.hostname)}`, ...(u.protocol === "https:" ? [`ssl ${u.hostname}`] : [])];
    for (const k of keys) users.set(k, (users.get(k) ?? new Set()).add(m.project_id));
  }
  const { results: rows } = await env.DB.prepare("SELECT * FROM expiry").all<{ host: string; kind: string; expires_at: number | null; checked_at: number; warned: number }>();
  const known = new Map(rows.map((r) => [`${r.kind} ${r.host}`, r]));
  const stale = [...users.keys()].filter((k) => !known.has(k) || now - known.get(k)!.checked_at > 20 * 3_600_000).slice(0, perRun);

  for (const key of stale) {
    const [kind, host] = key.split(" ");
    let expires: number | null = null, error: string | null = null;
    try { expires = kind === "ssl" ? await sslExpiry(host, now) : await domainExpiry(host); } catch (e) { error = (e as Error).message; }
    const prev = known.get(key);
    const days = expires ? Math.floor((expires - now) / DAY) : Infinity;
    const level = WARN_DAYS.filter((d) => days <= d).at(-1) ?? 0;
    const warn = level > 0 && (!prev?.warned || level < prev.warned);
    // Remember the tightest warning sent; a renewal (no longer within 14 days) resets it.
    const warned = !expires ? prev?.warned ?? 0 : warn ? level : level ? prev!.warned : 0;
    await env.DB.prepare(`
      INSERT INTO expiry (host, kind, expires_at, checked_at, error, warned) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (host, kind) DO UPDATE SET expires_at = COALESCE(?3, expires_at), checked_at = ?4, error = ?5, warned = ?6`)
      .bind(host, kind, expires, now, error, warned).run();
    if (!warn) continue;
    const what = kind === "ssl" ? `SSL certificate for ${host}` : `Domain ${host}`;
    const card: Card = {
      title: `${kind === "ssl" ? "🔐" : "🌐"} ${what} expires in ${days <= 0 ? "less than a day" : `${days} days`}`,
      lines: [`Expires ${new Date(expires!).toUTCString().slice(0, 16)}.`, kind === "ssl" ? "Renew it, or visitors will see a security error." : "Renew it, or the site and email on it will stop working."],
      buttons: [],
    };
    const to = [...new Map([...users.get(key)!].flatMap((pid) => channels.get(pid) ?? []).map((c) => [c.type + c.config, c])).values()];
    await sendAll(to, card, key);
  }
}
