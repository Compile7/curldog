// Converts an Uptime Kuma backup (Settings → Backup → Export) into Moniwork monitors.

const INTERVALS = [60, 300, 600, 900, 1800, 3600];
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const nearest = (sec) => INTERVALS.reduce((best, v) => (Math.abs(v - sec) < Math.abs(best - sec) ? v : best));
const CONTENT_TYPES = { json: "application/json", xml: "text/xml", form: "application/x-www-form-urlencoded" };

// Kuma notification config → Moniwork channel. Types we can't send to are left out.
const CHANNELS = {
  GoogleChat: (c) => ({ type: "google_chat", config: { url: c.googleChatWebhookURL } }),
  telegram: (c) => ({ type: "telegram", config: { token: c.telegramBotToken, chat_id: String(c.telegramChatID ?? "") } }),
  slack: (c) => ({ type: "webhook", config: { url: c.slackwebhookURL } }),
  discord: (c) => ({ type: "webhook", config: { url: c.discordWebhookUrl } }),
};

function toMonitor(k) {
  if (k.type === "group") return { skip: "Groups aren't imported" };
  if (k.type !== "http" && k.type !== "keyword") return { skip: `${k.type} monitors aren't HTTP checks` };
  if (!k.url || !/^https?:\/\/[^/]/i.test(k.url)) return { skip: "No valid http(s) URL" };
  if (k.ignoreTls) return { skip: "Ignores TLS errors, which Workers can't do" };
  if (k.upsideDown) return { skip: "Upside-down mode isn't supported" };
  if (k.type === "keyword" && k.invertKeyword) return { skip: "Inverted keyword checks aren't supported" };
  if (k.authMethod && k.authMethod !== "basic") return { skip: `${k.authMethod} auth isn't supported` };

  let headers = {};
  if (k.headers) {
    try { headers = JSON.parse(k.headers); } catch { return { skip: "Headers aren't valid JSON" }; }
  }
  const parts = ["curl"];
  const method = (k.method || "GET").toUpperCase();
  if (method !== "GET") parts.push("-X", method);
  parts.push(quote(k.url));
  if ((k.maxredirects ?? 10) > 0) parts.push("-L");
  for (const [name, value] of Object.entries(headers)) parts.push("-H", quote(`${name}: ${value}`));
  if (k.authMethod === "basic" && k.basic_auth_user) parts.push("-u", quote(`${k.basic_auth_user}:${k.basic_auth_pass ?? ""}`));
  if (k.body) {
    const hasType = Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
    if (!hasType) parts.push("-H", quote(`Content-Type: ${CONTENT_TYPES[k.httpBodyEncoding] || CONTENT_TYPES.json}`));
    parts.push("--data-raw", quote(k.body));
  }

  return {
    monitor: {
      name: String(k.name || k.url).trim().slice(0, 100),
      curl: parts.join(" "),
      interval_sec: nearest(Number(k.interval) || 60),
      timeout_ms: Math.min(30, Math.max(1, Math.round(Number(k.timeout) || 10))) * 1000,
      expected_status: (k.accepted_statuscodes || []).join(",") || "200-299",
      keyword: k.type === "keyword" ? k.keyword || "" : "",
      paused: !k.active,
    },
  };
}

export function convertKuma(data) {
  if (!data || !Array.isArray(data.monitorList)) {
    throw new Error("This doesn't look like an Uptime Kuma backup. Export it from Settings → Backup.");
  }
  const monitors = [];
  const skipped = [];
  for (const k of data.monitorList) {
    const r = toMonitor(k);
    if (r.monitor) monitors.push({ ...r.monitor, method: (k.method || "GET").toUpperCase(), url: k.url });
    else skipped.push({ name: k.name || "Unnamed", reason: r.skip });
  }
  const channels = [];
  for (const n of data.notificationList || []) {
    let config = {};
    try { config = JSON.parse(n.config); } catch {}
    const ch = CHANNELS[config.type]?.(config);
    if (n.active !== false && ch && Object.values(ch.config).every(Boolean)) channels.push({ name: n.name, ...ch });
  }
  return { monitors, skipped, channels };
}

const MULTI_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.in", "co.jp", "com.br", "co.nz", "com.sg"]);

// "https://api.ssojet.com/x" → { key: "ssojet", domain: "ssojet.com" }
export function siteOf(url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length < 2 || /^[\d.]+$/.test(host)) return { key: host, domain: host };
  const n = MULTI_PART_TLDS.has(parts.slice(-2).join(".")) ? 3 : 2;
  return { key: parts[parts.length - n].toLowerCase(), domain: parts.slice(-n).join(".") };
}

// Prefer how the team already wrote the brand in monitor names ("SSOJet API" → "SSOJet").
function brandName(key, names) {
  const re = new RegExp(key.split("").map((c) => c.replace(/[^\w]/g, "\\$&")).join("\\s?"), "i");
  const caps = (s) => s.replace(/[^A-Z]/g, "").length;
  let best = "";
  for (const name of names) {
    const m = re.exec(name)?.[0];
    if (m && (!best || caps(m) > caps(best))) best = m;
  }
  if (!best || best === best.toLowerCase()) best = (best || key).charAt(0).toUpperCase() + (best || key).slice(1);
  return best;
}

// One group per site, for "one project per domain" imports. Items are indexes into `monitors`.
export function groupByDomain(monitors) {
  const groups = new Map();
  monitors.forEach((m, i) => {
    const { key, domain } = siteOf(m.url);
    if (!groups.has(key)) groups.set(key, { key, domains: new Set(), items: [] });
    groups.get(key).domains.add(domain);
    groups.get(key).items.push(i);
  });
  return [...groups.values()]
    .map((g) => ({ name: brandName(g.key, g.items.map((i) => monitors[i].name)), domains: [...g.domains], items: g.items }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
