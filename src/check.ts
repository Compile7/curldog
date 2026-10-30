import type { ParsedRequest } from "./curl.ts";
import type { Alert } from "./notify.ts";
import type { Prober } from "./prober.ts";
import { aiSummary, dnsLookup, type Dns } from "./diagnose.ts";

export interface MonitorRow {
  id: string;
  project_id: string;
  type: "http" | "heartbeat";
  name: string;
  curl: string;
  request: string;
  steps: string; // JSON Step[]
  regions: number;
  interval_sec: number;
  timeout_ms: number;
  expected_status: string;
  keyword: string;
  slow_ms: number;
  slow_since: number | null;
  slow: number;
  paused: number;
  on_status: number;
  public_name: string;
  muted_until: number;
  status: "pending" | "up" | "down";
  last_checked_at: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
  last_ok: string | null;
  next_check_at: number;
  token: string | null;
  last_ping_at: number | null;
  down_since: number | null;
  acked_by: string | null;
  acked_at: number | null;
  reminded_at: number | null;
  escalated_at: number | null;
  created_by: string;
  created_at: number;
}

// A request run before the main one. `vars` copies values out of its response: [name, "$.json.path" | "header:Name"].
export interface Step {
  name: string;
  curl: string;
  request: string;
  vars: [string, string][];
}

export interface Snapshot {
  status_text: string;
  final_url?: string;
  chain?: { status: number; url: string }[];
  headers: [string, string][];
  body: string;
  size: number | null; // bytes, when known
}

export interface CheckResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
  preview?: Snapshot;
  steps?: { name: string; status_code: number | null; latency_ms: number; error: string | null }[];
  regions?: { region: string; ok: boolean; status_code: number | null; latency_ms: number; error: string | null }[];
  attempts?: CheckResult[]; // first try and retry, when a retry happened
}

export type Checkable = Pick<MonitorRow, "request" | "timeout_ms" | "expected_status" | "keyword"> & { steps?: string };

const PART = /^(\d)xx$|^(\d{3})\s*-\s*(\d{3})$|^(\d{3})$/i;
const BODY_LIMIT = 4000;
const FULL_LIMIT = 1_000_000;
const SLOW_FOR = 5 * 60_000;

export function validExpected(spec: string): boolean {
  return spec.split(",").every((p) => PART.test(p.trim()));
}

// "200-299", "2xx", "200,204" — comma separated, any part may match.
export function statusMatches(code: number, spec: string): boolean {
  return spec.split(",").some((part) => {
    const m = PART.exec(part.trim());
    if (!m) return false;
    if (m[1]) return Math.floor(code / 100) === +m[1];
    if (m[2]) return code >= +m[2] && code <= +m[3];
    return code === +m[4];
  });
}

// --- variables for multi-step checks ---

// {{name}}, also after URL parsing turned the braces into %7B%7Bname%7D%7D.
const VAR = /\{\{(\w+)\}\}|%7B%7B(\w+)%7D%7D/gi;

export function fill(req: ParsedRequest, vars: Record<string, string>): ParsedRequest {
  const sub = (s: string) => s.replace(VAR, (_, a, b) => {
    const k = a ?? b;
    if (!(k in vars)) throw new Error(`Variable {{${k}}} isn't set by any step.`);
    return vars[k];
  });
  return { ...req, url: sub(req.url), headers: req.headers.map(([k, v]) => [k, sub(v)]), body: req.body && sub(req.body) };
}

export function extract(specs: [string, string][], headers: [string, string][], body: string, into: Record<string, string>) {
  let json: unknown;
  for (const [name, path] of specs) {
    let value: unknown;
    if (/^header:/i.test(path)) {
      const h = path.slice(7).trim().toLowerCase();
      value = headers.find(([k]) => k.toLowerCase() === h)?.[1];
    } else {
      if (json === undefined) { try { json = JSON.parse(body); } catch { throw new Error("Response isn't JSON, so variables can't be read from it."); } }
      value = path.replace(/^\$\.?/, "").split(/\.|\[(\d+)\]/).filter(Boolean)
        .reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), json);
    }
    if (value === undefined || value === null || typeof value === "object") throw new Error(`Couldn't find ${path} in the response.`);
    into[name] = String(value);
  }
}

// --- running a request ---

// Follows redirects by hand so the chain can be shown. Mirrors curl -L: 303 (and 301/302 after POST) switch to GET.
async function follow(req: ParsedRequest, signal: AbortSignal) {
  let { method, url, body } = req;
  let headers = req.headers;
  const chain: { status: number; url: string }[] = [];
  for (;;) {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal });
    const loc = res.headers.get("location");
    if (!req.followRedirects || !loc || res.status < 300 || res.status > 399 || chain.length >= 10) return { res, chain, url };
    await res.body?.cancel();
    chain.push({ status: res.status, url });
    const next = new URL(loc, url);
    if (next.origin !== new URL(url).origin) headers = headers.filter(([k]) => !/^(authorization|cookie)$/i.test(k));
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = null;
    }
    url = next.href;
  }
}

// Reads only what we keep, unless the whole body is needed (keyword checks, step variables).
async function readBody(res: Response, limit: number) {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", size: 0 };
  const chunks: Uint8Array[] = [];
  let n = 0, done = false;
  while (n < limit) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    chunks.push(r.value);
    n += r.value.byteLength;
  }
  if (!done) await reader.cancel();
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  const size = done ? n : Number(res.headers.get("content-length")) || null;
  return { text: new TextDecoder().decode(all.subarray(0, limit)), size };
}

async function request(req: ParsedRequest, timeoutMs: number, expected: string, keyword: string, full: boolean) {
  const start = Date.now();
  try {
    const { res, chain, url } = await follow(req, AbortSignal.timeout(timeoutMs));
    const latency_ms = Date.now() - start;
    let error: string | null = statusMatches(res.status, expected) ? null : `Expected status ${expected}, got ${res.status}`;
    const { text, size } = await readBody(res, full || keyword ? FULL_LIMIT : BODY_LIMIT);
    if (!error && keyword && !text.includes(keyword)) error = `Response doesn't contain "${keyword}"`;
    const preview: Snapshot = {
      status_text: res.statusText, headers: [...res.headers], body: text.slice(0, BODY_LIMIT), size,
      ...(chain.length ? { final_url: url, chain } : {}),
    };
    return { result: { ok: !error, status_code: res.status, latency_ms, error, preview } as CheckResult, text };
  } catch (e) {
    const err = e as Error;
    // The cause carries the real reason (DNS, TLS, connection refused) when there is one.
    const error = err.name === "TimeoutError"
      ? `Timed out after ${timeoutMs / 1000}s`
      : [err.message || String(e), (err.cause as Error | undefined)?.message].filter(Boolean).join(": ");
    return { result: { ok: false, status_code: null, latency_ms: Date.now() - start, error } as CheckResult, text: "" };
  }
}

export async function runCheck(m: Checkable): Promise<CheckResult> {
  const vars: Record<string, string> = {};
  const done: NonNullable<CheckResult["steps"]> = [];
  const fail = (error: string, r?: CheckResult): CheckResult =>
    ({ ok: false, status_code: r?.status_code ?? null, latency_ms: r?.latency_ms ?? 0, error, preview: r?.preview, steps: done });
  for (const s of JSON.parse(m.steps || "[]") as Step[]) {
    let req: ParsedRequest;
    try { req = fill(JSON.parse(s.request), vars); } catch (e) { return fail(`Step "${s.name}": ${(e as Error).message}`); }
    const { result: r, text } = await request(req, m.timeout_ms, "200-399", "", true);
    done.push({ name: s.name, status_code: r.status_code, latency_ms: r.latency_ms, error: r.error });
    if (!r.ok) return fail(`Step "${s.name}": ${r.error}`, r);
    try { extract(s.vars, r.preview!.headers, text, vars); } catch (e) { return fail(`Step "${s.name}": ${(e as Error).message}`, r); }
  }
  let req: ParsedRequest;
  try { req = fill(JSON.parse(m.request), vars); } catch (e) { return fail((e as Error).message); }
  const { result } = await request(req, m.timeout_ms, m.expected_status, m.keyword, false);
  return done.length ? { ...result, steps: done } : result;
}

// --- heartbeats ---

// ponytail: fixed grace of half an interval (min 1 minute). Add a per-monitor setting if teams ask for it.
export const graceMs = (intervalSec: number) => Math.max(60, intervalSec / 2) * 1000;

export function heartbeatResult(m: Pick<MonitorRow, "interval_sec" | "last_ping_at" | "created_at">, now: number): CheckResult | null {
  const limit = m.interval_sec * 1000 + graceMs(m.interval_sec);
  const result = (error: string | null): CheckResult => ({ ok: !error, status_code: null, latency_ms: 0, error });
  if (!m.last_ping_at) return now - m.created_at < limit ? null : result("No ping received yet");
  const late = now - m.last_ping_at;
  if (late <= limit) return result(null);
  const mins = Math.round(late / 60_000);
  return result(`No ping for ${mins < 120 ? `${mins}m` : `${Math.round(mins / 60)}h`} (expected every ${every(m.interval_sec)})`);
}

const every = (s: number) => (s < 3600 ? `${s / 60}m` : `${s / 3600}h`);

// --- regions ---

export const REGIONS = [["enam", "US"], ["weur", "EU"], ["apac", "Asia"]] as const;

// Same check from three places. Down only when at least two agree, so one region's network blip doesn't page anyone.
async function regional(ns: DurableObjectNamespace<Prober>, m: Checkable): Promise<CheckResult> {
  const job = { request: m.request, timeout_ms: m.timeout_ms, expected_status: m.expected_status, keyword: m.keyword, steps: m.steps };
  const results = await Promise.all(REGIONS.map(async ([hint, region]) => {
    try {
      const r = (await ns.get(ns.idFromName(hint), { locationHint: hint }).check(job)) as unknown as CheckResult;
      return { region, ...r };
    } catch (e) {
      return { region, ok: false, status_code: null, latency_ms: 0, error: `Probe failed: ${(e as Error).message}` } as CheckResult & { region: string };
    }
  }));
  const failed = results.filter((r) => !r.ok);
  const main = failed.length >= 2 ? failed[0] : results.find((r) => r.ok)!;
  return {
    ...main,
    ok: failed.length < 2,
    error: failed.length >= 2 ? `${failed.length} of ${results.length} regions failing. ${failed[0].region}: ${failed[0].error}` : null,
    regions: results.map(({ region, ok, status_code, latency_ms, error }) => ({ region, ok, status_code, latency_ms, error })),
  };
}

// --- recording ---

export interface Deps {
  DB: D1Database;
  AI?: Ai;
  PROBER?: DurableObjectNamespace<Prober>;
}
export type Row = MonitorRow & { project_name: string; project_muted_until?: number };

async function evaluate(env: Deps, m: Row, now: number): Promise<CheckResult | null> {
  if (m.type === "heartbeat") return heartbeatResult(m, now);
  if (m.regions && env.PROBER) return regional(env.PROBER, m);
  const first = await runCheck(m);
  if (first.ok || m.status === "down") return first;
  // One retry before declaring an outage, so a single blip doesn't page anyone.
  await new Promise((res) => setTimeout(res, 3000));
  const second = await runCheck(m);
  return { ...second, attempts: [first, second] };
}

// Runs a monitor, stores the result, and returns the alert to send when something changed (unless muted).
export async function checkAndRecord(env: Deps, m: Row, now = Date.now()): Promise<{ result: CheckResult | null; alert?: Alert }> {
  const r = await evaluate(env, m, now);
  if (!r) return { result: null }; // heartbeat that hasn't had its first ping yet, still within grace
  const db = env.DB;
  const at = Date.now();
  const status = r.ok ? "up" : "down";
  const wentDown = !r.ok && m.status !== "down";
  const recovered = r.ok && m.status === "down";
  const req = m.type === "http" ? (JSON.parse(m.request) as ParsedRequest) : null;

  let dns: Dns | undefined, summary: string | null = null;
  if (!r.ok && req) {
    dns = await dnsLookup(new URL(req.url).hostname);
    if (wentDown) {
      summary = await aiSummary(env.AI, {
        method: req.method, url: req.url, expected: m.expected_status, statusCode: r.status_code, error: r.error,
        headers: r.preview?.headers, body: r.preview?.body, dns, chain: r.preview?.chain, regions: r.regions,
      });
    }
  }

  let slow = m.slow, slowSince = m.slow_since, slowEvent: "slow" | "fast" | null = null;
  if (r.ok && m.slow_ms > 0 && r.latency_ms > m.slow_ms) {
    slowSince ??= at;
    if (!slow && at - slowSince >= SLOW_FOR) { slow = 1; slowEvent = "slow"; }
  } else {
    if (slow && r.ok) slowEvent = "fast";
    slow = 0;
    slowSince = null;
  }

  const detail = r.ok || !req ? null : JSON.stringify({
    preview: r.preview, attempts: r.attempts, steps: r.steps, regions: r.regions, dns, summary,
    last_ok: m.last_ok ? JSON.parse(m.last_ok) : undefined,
  });
  const lastOk = r.ok && r.preview ? JSON.stringify({ ts: at, status_code: r.status_code, ...r.preview }) : null;
  const latency = m.type === "heartbeat" ? null : r.latency_ms;
  const changed = wentDown || recovered ? 1 : 0;

  let since: number | null | undefined, stats: { n: number; first: string | null } | null = null, uptime7d: number | null = null;
  if (recovered) {
    since = m.down_since ?? (await db.prepare("SELECT MAX(ts) AS ts FROM events WHERE monitor_id = ? AND status = 'down'").bind(m.id).first<{ ts: number }>())?.ts;
    if (since) {
      stats = await db.prepare(`
        SELECT COUNT(*) AS n, (SELECT error FROM events WHERE monitor_id = ?1 AND status = 'down' AND ts >= ?2 ORDER BY ts LIMIT 1) AS first
        FROM checks WHERE monitor_id = ?1 AND ts >= ?2 AND ok = 0`).bind(m.id, since).first();
    }
  }
  if (wentDown) {
    uptime7d = (await db.prepare("SELECT AVG(ok) AS u FROM checks WHERE monitor_id = ? AND ts > ?").bind(m.id, at - 7 * 86_400_000).first<{ u: number | null }>())?.u ?? null;
  }

  const stmts = [
    db.prepare("INSERT INTO checks (monitor_id, ts, ok, status_code, latency_ms, error, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(m.id, at, r.ok ? 1 : 0, r.status_code, latency, r.error, detail),
    // Incident fields reset on every status change. Done in SQL so an Acknowledge made mid-check isn't overwritten.
    db.prepare(`
      UPDATE monitors SET status = ?1, last_checked_at = ?2, last_latency_ms = ?3, last_error = ?4, slow = ?5, slow_since = ?6,
        last_ok = COALESCE(?7, last_ok),
        down_since = CASE WHEN ?8 THEN ?2 WHEN ?9 THEN NULL ELSE down_since END,
        acked_by = CASE WHEN ?10 THEN NULL ELSE acked_by END, acked_at = CASE WHEN ?10 THEN NULL ELSE acked_at END,
        reminded_at = CASE WHEN ?10 THEN NULL ELSE reminded_at END, escalated_at = CASE WHEN ?10 THEN NULL ELSE escalated_at END
      WHERE id = ?11`)
      .bind(status, at, latency, r.error, slow, slowSince, lastOk, wentDown ? 1 : 0, recovered ? 1 : 0, changed, m.id),
  ];
  if (changed) stmts.push(db.prepare("INSERT INTO events (monitor_id, ts, status, error, summary) VALUES (?, ?, ?, ?, ?)").bind(m.id, at, status, r.error, summary));
  if (slowEvent) stmts.push(db.prepare("INSERT INTO events (monitor_id, ts, status, error) VALUES (?, ?, ?, ?)").bind(m.id, at, slowEvent, null));
  await db.batch(stmts);

  const kind = wentDown ? "down" : recovered ? "up" : slowEvent;
  if (!kind || Math.max(m.muted_until, m.project_muted_until ?? 0) > at) return { result: r };
  return {
    result: r,
    alert: {
      kind, monitorId: m.id, projectId: m.project_id, project: m.project_name, monitor: m.name,
      method: req?.method ?? "", url: req?.url ?? `Heartbeat, expected every ${every(m.interval_sec)}`,
      error: r.error, statusCode: r.status_code, latencyMs: r.latency_ms, slowMs: m.slow_ms, uptime7d, summary,
      snippet: r.preview?.body ? r.preview.body.replace(/\s+/g, " ").trim().slice(0, 160) : undefined,
      downForMs: since ? at - since : undefined, failedChecks: stats?.n, firstError: stats?.first,
    },
  };
}
