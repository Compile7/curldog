// Builds and sends messages to Google Chat, Telegram, Slack/Discord-style webhooks, email, PagerDuty and SMS.
// Every message is a Card first; each channel type renders it in its own markup.

export type ChannelType = "google_chat" | "telegram" | "webhook" | "email" | "pagerduty" | "sms";

export interface Channel {
  type: ChannelType;
  // JSON: {url} | {token, chat_id} | email {api_key, from, to} | pagerduty {routing_key} | sms {account_sid, auth_token, from, to}
  config: string;
}

export interface Alert {
  kind: "down" | "up" | "slow" | "fast";
  monitorId: string;
  projectId: string;
  project: string;
  monitor: string;
  method: string;
  url: string;
  error: string | null;
  statusCode: number | null;
  latencyMs: number;
  slowMs?: number;
  uptime7d?: number | null; // on down
  snippet?: string; // on down: start of the response body
  summary?: string | null; // on down: AI explanation
  downForMs?: number; // on recovery
  failedChecks?: number; // on recovery
  firstError?: string | null; // on recovery
}

type Line = string | { code: string };
export interface Card {
  title: string;
  lines: Line[];
  buttons: { label: string; url: string }[];
  // Set on cards about an incident. PagerDuty and SMS only get these; reports and expiry warnings stay in chat and email.
  incidents?: Incident[];
}

export interface Incident {
  key: string; // stable per monitor, so PagerDuty dedupes triggers and resolves the right incident
  action: "trigger" | "acknowledge" | "resolve";
  severity: "critical" | "warning" | "info";
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const ms = (v: number) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const pct = (v: number) => `${(Math.floor(v * 10000) / 100).toFixed(v >= 1 ? 0 : 2)}%`;

// Links back into the app. Buttons only appear when APP_URL is set.
function links(app: string, a: { monitorId: string }, which: ("open" | "ack" | "mute")[]) {
  if (!app) return [];
  const base = `${app.replace(/\/$/, "")}/monitors/${a.monitorId}`;
  const all = { open: { label: "Open", url: base }, ack: { label: "Acknowledge", url: `${base}?do=ack` }, mute: { label: "Mute 1h", url: `${base}?do=mute` } };
  return which.map((k) => all[k]);
}

const name = (a: Alert) => `${a.project} / ${a.monitor}`;
const target = (a: Alert) => [a.method, a.url].filter(Boolean).join(" ");

const incident = (a: Pick<Alert, "kind" | "monitorId">): Incident => ({
  key: a.kind === "slow" || a.kind === "fast" ? `${a.monitorId}:slow` : a.monitorId,
  action: a.kind === "down" || a.kind === "slow" ? "trigger" : "resolve",
  severity: a.kind === "down" ? "critical" : "warning",
});

export function alertCard(a: Alert, app = ""): Card {
  return { ...alertBody(a, app), incidents: [incident(a)] };
}

function alertBody(a: Alert, app: string): Card {
  if (a.kind === "down") {
    const facts: (string | number)[] = a.method ? [a.statusCode ?? "No response", ms(a.latencyMs)] : [];
    if (a.uptime7d != null) facts.push(`7-day uptime ${pct(a.uptime7d)}`);
    return {
      title: `🔴 ${name(a)} is DOWN`,
      lines: [a.error ?? "Check failed", ...(a.summary ? [`💡 ${a.summary}`] : []), target(a), ...(facts.length ? [facts.join(" · ")] : []), ...(a.snippet ? [{ code: a.snippet }] : [])],
      buttons: links(app, a, ["open", "ack", "mute"]),
    };
  }
  if (a.kind === "up") {
    const timeline = [a.downForMs ? `Down ${duration(a.downForMs)}` : "", a.failedChecks ? `${a.failedChecks} failed checks` : ""].filter(Boolean).join(" · ");
    return {
      title: `🟢 ${name(a)} is back UP${a.downForMs ? ` after ${duration(a.downForMs)}` : ""}`,
      lines: [...(timeline ? [timeline] : []), ...(a.firstError ? [`First error: ${a.firstError}`] : []), ...(a.method ? [`${a.statusCode ?? "OK"} in ${ms(a.latencyMs)}`] : []), target(a)],
      buttons: links(app, a, ["open"]),
    };
  }
  if (a.kind === "slow") {
    return {
      title: `🐢 ${name(a)} is slow`,
      lines: [`Responses have been over ${ms(a.slowMs ?? 0)} for 5+ minutes. Latest: ${ms(a.latencyMs)}.`, target(a)],
      buttons: links(app, a, ["open", "mute"]),
    };
  }
  return { title: `⚡ ${name(a)} is fast again`, lines: [`Latest response: ${ms(a.latencyMs)}.`, target(a)], buttons: links(app, a, ["open"]) };
}

// Several monitors of one project changed in the same run: one message instead of many.
export function groupCard(alerts: Alert[], app = ""): Card {
  const down = alerts.filter((a) => a.kind === "down").length;
  const icon = { down: "🔴", up: "🟢", slow: "🐢", fast: "⚡" };
  const what = { down: "DOWN", up: "back up", slow: "slow", fast: "fast again" };
  const parts = (["down", "up", "slow", "fast"] as const)
    .map((k) => [k, alerts.filter((a) => a.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${what[k]}`);
  return {
    title: `${down ? "🔴" : "🟢"} ${alerts[0].project}: ${parts.join(", ")}`,
    lines: alerts.map((a) => `${icon[a.kind]} ${a.monitor}: ${a.kind === "down" ? a.error ?? "Check failed" : a.kind === "up" && a.downForMs ? `up after ${duration(a.downForMs)}` : a.kind === "slow" ? `${ms(a.latencyMs)}` : "OK"}`),
    buttons: app ? [{ label: "Open project", url: `${app.replace(/\/$/, "")}/projects/${alerts[0].projectId}` }] : [],
    incidents: alerts.map(incident),
  };
}

export function reminderCard(a: Alert, downForMs: number, escalated: boolean, app = ""): Card {
  return {
    title: `${escalated ? "🚨 ESCALATED:" : "⏰ Still DOWN:"} ${name(a)} (${duration(downForMs)})`,
    lines: [a.error ?? "Check failed", target(a), "Nobody has acknowledged this yet."],
    buttons: links(app, a, ["open", "ack", "mute"]),
    incidents: [{ ...incident(a), severity: "critical" }],
  };
}

export function ackCard(a: Pick<Alert, "monitorId" | "project" | "monitor">, by: string, app = ""): Card {
  return {
    title: `👀 ${by} is on ${a.project} / ${a.monitor}`, lines: ["Acknowledged. Reminders are stopped for this incident."], buttons: links(app, a, ["open"]),
    incidents: [{ key: a.monitorId, action: "acknowledge", severity: "critical" }],
  };
}

// PagerDuty gets a test incident that resolves itself straight away.
export const testCard = (): Card => ({
  title: "✅ CurlDog test", lines: ["This channel will get alerts when monitors go down or recover."], buttons: [],
  incidents: [{ key: "test", action: "trigger", severity: "info" }, { key: "test", action: "resolve", severity: "info" }],
});

// --- rendering per channel type ---

function telegram(card: Card) {
  const text = [`<b>${escHtml(card.title)}</b>`, ...card.lines.map((l) => (typeof l === "string" ? escHtml(l) : `<code>${escHtml(l.code)}</code>`))].join("\n");
  const markup = card.buttons.length ? { reply_markup: { inline_keyboard: [card.buttons.map((b) => ({ text: b.label, url: b.url }))] } } : {};
  return { text, parse_mode: "HTML", disable_web_page_preview: true, ...markup };
}

function googleChat(card: Card) {
  const text = card.lines.map((l) => (typeof l === "string" ? escHtml(l) : `<font color="#80868b">${escHtml(l.code)}</font>`)).join("<br>");
  const widgets: unknown[] = [{ textParagraph: { text } }];
  if (card.buttons.length) widgets.push({ buttonList: { buttons: card.buttons.map((b) => ({ text: b.label, onClick: { openLink: { url: b.url } } })) } });
  return { cardsV2: [{ cardId: "curldog", card: { header: { title: card.title }, sections: [{ widgets }] } }] };
}

// Plain text: Google Chat fallback, Slack (*bold*, <url|label>) and Discord (`content`, **bold**).
function plain(card: Card, bold: (s: string) => string, link: (url: string, label: string) => string) {
  return [bold(card.title), ...card.lines.map((l) => (typeof l === "string" ? l : `\`${l.code}\``)), card.buttons.map((b) => link(b.url, b.label)).join(" · ")]
    .filter(Boolean).join("\n");
}

// One Events API v2 call per incident on the card. Cards without incidents (reports, expiry) aren't sent.
export function pagerDuty(routingKey: string, card: Card) {
  return (card.incidents ?? []).map((i) => ({
    routing_key: routingKey,
    event_action: i.action,
    dedup_key: `curldog-${i.key}`,
    ...(i.action === "trigger" ? {
      payload: {
        summary: card.title.slice(0, 1024), source: "CurlDog", severity: i.severity,
        custom_details: { details: card.lines.map((l) => (typeof l === "string" ? l : l.code)).join("\n") },
      },
      links: card.buttons.slice(0, 1).map((b) => ({ href: b.url, text: "Open in CurlDog" })),
    } : {}),
  }));
}

export function buildRequest(ch: Channel, card: Card, asText = false): { url: string; body: unknown } {
  const cfg = JSON.parse(ch.config);
  if (ch.type === "telegram") return { url: `https://api.telegram.org/bot${cfg.token}/sendMessage`, body: { chat_id: cfg.chat_id, ...telegram(card) } };
  const slack = plain(card, (s) => `*${s}*`, (url, label) => `<${url}|${label}>`);
  if (ch.type === "google_chat") return { url: cfg.url, body: asText ? { text: slack } : googleChat(card) };
  return { url: cfg.url, body: { text: slack, content: plain(card, (s) => `**${s}**`, (url, label) => `${label}: ${url}`) } };
}

function email(card: Card) {
  const line = (l: Line) => (typeof l === "string"
    ? `<p style="margin:0 0 10px">${escHtml(l)}</p>`
    : `<pre style="margin:0 0 10px;padding:10px;background:#f5f0ea;border-radius:6px;white-space:pre-wrap">${escHtml(l.code)}</pre>`);
  const buttons = card.buttons.map((b) => `<a href="${escHtml(b.url)}" style="display:inline-block;margin-right:8px;padding:8px 14px;background:#C97B3A;color:#fff;border-radius:6px;text-decoration:none">${escHtml(b.label)}</a>`).join("");
  return {
    subject: card.title,
    html: `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#3B2418;max-width:600px"><h2 style="margin:0 0 14px;font-size:18px">${escHtml(card.title)}</h2>${card.lines.map(line).join("")}${buttons ? `<p style="margin-top:16px">${buttons}</p>` : ""}<p style="margin-top:24px;color:#9a8574;font-size:12px">Sent by CurlDog</p></div>`,
    text: plain(card, (s) => s, (url, label) => `${label}: ${url}`),
  };
}

// SMS: title and the first line only. Twilio splits anything longer into several billed segments.
const sms = (card: Card) => [card.title, ...card.lines.filter((l) => typeof l === "string").slice(0, 1)].join("\n").slice(0, 300);
const recipients = (to: string) => to.split(",").map((s) => s.trim()).filter(Boolean);

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const form = body instanceof URLSearchParams;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...headers },
    body: form ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  let reason = detail.slice(0, 200);
  try { const d = JSON.parse(detail); reason = d.description ?? d.error?.message ?? d.message ?? reason; } catch {}
  throw new Error(`${res.status} ${reason}`.trim());
}

export async function send(ch: Channel, card: Card): Promise<void> {
  const cfg = JSON.parse(ch.config);
  if (ch.type === "email") {
    return post("https://api.resend.com/emails", { from: cfg.from, to: recipients(cfg.to), ...email(card) }, { authorization: `Bearer ${cfg.api_key}` });
  }
  if (ch.type === "pagerduty") {
    for (const body of pagerDuty(cfg.routing_key, card)) await post("https://events.pagerduty.com/v2/enqueue", body);
    return;
  }
  if (ch.type === "sms") {
    if (!card.incidents) return;
    const auth = { authorization: `Basic ${btoa(`${cfg.account_sid}:${cfg.auth_token}`)}` };
    await Promise.all(recipients(cfg.to).map((to) => post(`https://api.twilio.com/2010-04-01/Accounts/${cfg.account_sid}/Messages.json`,
      new URLSearchParams({ From: cfg.from, To: to, Body: sms(card) }), auth)));
    return;
  }
  const { url, body } = buildRequest(ch, card);
  try {
    await post(url, body);
  } catch (e) {
    // A card Google Chat won't render still gets through as plain text.
    if (ch.type !== "google_chat") throw e;
    await post(url, buildRequest(ch, card, true).body);
  }
}

// Alerts from one run: one message per project, grouped when several monitors changed together.
export async function deliver(alerts: Alert[], channels: Map<string, Channel[]>, app = "") {
  const byProject = new Map<string, Alert[]>();
  for (const a of alerts) byProject.set(a.projectId, [...(byProject.get(a.projectId) ?? []), a]);
  await Promise.all([...byProject].map(([pid, list]) =>
    sendAll(channels.get(pid) ?? [], list.length === 1 ? alertCard(list[0], app) : groupCard(list, app), pid)));
}

export async function sendAll(channels: Channel[], card: Card, tag = "") {
  const results = await Promise.allSettled(channels.map((ch) => send(ch, card)));
  for (const r of results) if (r.status === "rejected") console.error("alert failed", tag, r.reason);
}

// Telegram: list chats that recently messaged the bot, so users don't have to look up chat IDs.
export async function telegramChats(token: string): Promise<{ id: string; title: string }[]> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`, { signal: AbortSignal.timeout(10_000) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: Record<string, any>[] };
  if (!data.ok) throw new Error(`Telegram says "${data.description || "error"}". Check the bot token.`);
  const chats = new Map<string, string>();
  for (const u of data.result ?? []) {
    const chat = (u.message ?? u.channel_post ?? u.my_chat_member ?? u.edited_message)?.chat;
    if (!chat) continue;
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username;
    chats.set(String(chat.id), `${name || chat.id} (${chat.type})`);
  }
  return [...chats].map(([id, title]) => ({ id, title }));
}
