import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCurl, CurlError } from "./curl.ts";
import { extract, fill, heartbeatResult, statusMatches, validExpected } from "./check.ts";
import { getUser } from "./auth.ts";
import { alertCard, buildRequest, duration, groupCard, testCard } from "./notify.ts";
import { registrable } from "./jobs.ts";

test("parses a Chrome 'Copy as cURL' command", () => {
  const r = parseCurl(`curl 'https://api.example.com/v1/items?x=1' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer abc' \\
  --data-raw $'{"name":"it\\'s"}' \\
  --compressed`);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://api.example.com/v1/items?x=1");
  assert.equal(r.body, `{"name":"it's"}`);
  assert.deepEqual(r.headers.find(([k]) => k === "authorization"), ["authorization", "Bearer abc"]);
  assert.ok(r.headers.some(([k, v]) => k === "Content-Type" && v === "application/x-www-form-urlencoded"));
  assert.equal(r.followRedirects, false);
});

test("handles bundled and attached short flags", () => {
  const r = parseCurl(`curl -sSL -XPUT -H"X-Id: 7" -d a=1 -d b=2 example.com/x -m 5`);
  assert.equal(r.method, "PUT");
  assert.equal(r.url, "http://example.com/x");
  assert.equal(r.body, "a=1&b=2");
  assert.equal(r.followRedirects, true);
  assert.equal(r.timeoutMs, 5000);
  assert.deepEqual(r.headers[0], ["X-Id", "7"]);
});

test("--json, -G, -u, -I and URL credentials", () => {
  const j = parseCurl(`curl --json '{"a":1}' https://x.dev`);
  assert.equal(j.method, "POST");
  assert.ok(j.headers.some(([k, v]) => k === "Content-Type" && v === "application/json"));

  const g = parseCurl(`curl -G -d q=hi --data-urlencode 'n=a b' https://x.dev/s?p=1`);
  assert.equal(g.method, "GET");
  assert.equal(g.body, null);
  assert.equal(g.url, "https://x.dev/s?p=1&q=hi&n=a%20b");

  const u = parseCurl(`curl -u bob:pw https://x.dev`);
  assert.deepEqual(u.headers.at(-1), ["Authorization", "Basic " + btoa("bob:pw")]);

  const c = parseCurl(`curl https://bob:pw@x.dev/`);
  assert.equal(c.url, "https://x.dev/");
  assert.deepEqual(c.headers.at(-1), ["Authorization", "Basic " + btoa("bob:pw")]);

  assert.equal(parseCurl(`curl -I https://x.dev`).method, "HEAD");
});

test("rejects what Workers can't do", () => {
  for (const cmd of [
    "curl -k https://x.dev",
    "curl -d @body.json https://x.dev",
    "curl -F a=1 https://x.dev",
    "curl --bogus https://x.dev",
    "curl -H 'x' https://x.dev",
    "curl ftp://x.dev",
    "curl -X GET -d a=1 https://x.dev",
    "curl 'https://x.dev",
    "curl -s",
  ]) {
    assert.throws(() => parseCurl(cmd), CurlError, cmd);
  }
});

test("expected status specs", () => {
  assert.ok(statusMatches(204, "2xx"));
  assert.ok(statusMatches(302, "200-399"));
  assert.ok(statusMatches(201, "200, 201"));
  assert.ok(!statusMatches(500, "200-399"));
  assert.ok(!statusMatches(404, "200"));
  assert.ok(validExpected("200-299,404"));
  assert.ok(!validExpected("ok"));
  assert.ok(!validExpected("200,"));
});

test("verifies Cloudflare Access JWTs", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ keys: [jwk] })) as typeof fetch;

  const b64 = (v: object | Uint8Array) =>
    Buffer.from(v instanceof Uint8Array ? v : JSON.stringify(v)).toString("base64url");
  const sign = async (claims: object, kid = "k1") => {
    const unsigned = `${b64({ alg: "RS256", kid })}.${b64(claims)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64(new Uint8Array(sig))}`;
  };
  const env = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud1" };
  const good = { aud: ["aud1"], iss: "https://team.cloudflareaccess.com", exp: Date.now() / 1000 + 60, email: "a@b.co" };
  const req = (token: string) => new Request("https://app/api/me", { headers: { "cf-access-jwt-assertion": token } });

  try {
    assert.equal(await getUser(req(await sign(good)), env), "a@b.co");
    assert.equal(await getUser(req(await sign({ ...good, aud: ["other"] })), env), null);
    assert.equal(await getUser(req(await sign({ ...good, exp: 1 })), env), null);
    assert.equal(await getUser(req(await sign({ ...good, iss: "https://evil" })), env), null);
    assert.equal(await getUser(req(await sign(good, "nope")), env), null);
    const t = await sign(good);
    assert.equal(await getUser(req(t.slice(0, -4) + "AAAA"), env), null);
    assert.equal(await getUser(new Request("https://app/api/me"), env), null);
    assert.equal(await getUser(req(t), {}), null, "fails closed when Access isn't configured");
    assert.equal(await getUser(req(t), { ...env, ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/cdn-cgi/access/certs" }), "a@b.co", "accepts a pasted certs URL");
    assert.equal(await getUser(new Request("https://app/api/me"), { DEV_USER: "x@y.z" }), null, "DEV_USER never applies off localhost");
    assert.equal(await getUser(new Request("http://localhost:8787/api/me"), {}), "dev@localhost");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("converts an Uptime Kuma backup into curls our parser accepts", async () => {
  const { convertKuma } = await import("../public/kuma.js");
  const base = { type: "http", method: "GET", interval: 60, timeout: 48, active: true, maxredirects: 10, accepted_statuscodes: ["200-299"] };
  const r = convertKuma({
    notificationList: [
      { name: "Chat", active: true, config: JSON.stringify({ type: "GoogleChat", googleChatWebhookURL: "https://chat.googleapis.com/x" }) },
      { name: "TG", active: true, config: JSON.stringify({ type: "telegram", telegramBotToken: "t", telegramChatID: -100 }) },
    ],
    monitorList: [
      { ...base, name: "Site", url: "https://a.dev/it's", interval: 500 },
      { ...base, name: "Post", url: "https://a.dev/p", method: "POST", body: `{"q":"it's"}`, headers: `{"X-Key": "v"}`,
        authMethod: "basic", basic_auth_user: "u", basic_auth_pass: "p", interval: 120, active: false, maxredirects: 0 },
      { ...base, type: "keyword", name: "Kw", url: "https://a.dev", keyword: "ok", accepted_statuscodes: ["200-299", "300-399"] },
      { ...base, type: "mysql", name: "DB", url: "mysql://x" },
      { ...base, name: "Self-signed", url: "https://a.dev", ignoreTls: true },
    ],
  });

  assert.deepEqual(r.skipped.map((s: { name: string }) => s.name), ["DB", "Self-signed"]);
  assert.deepEqual(r.channels, [
    { name: "Chat", type: "google_chat", config: { url: "https://chat.googleapis.com/x" } },
    { name: "TG", type: "telegram", config: { token: "t", chat_id: "-100" } },
  ]);
  const [site, post, kw] = r.monitors;

  assert.equal(site.interval_sec, 600);
  assert.equal(site.timeout_ms, 30_000);
  assert.equal(parseCurl(site.curl).url, "https://a.dev/it's");
  assert.equal(parseCurl(site.curl).followRedirects, true);

  const p = parseCurl(post.curl);
  assert.equal(p.method, "POST");
  assert.equal(p.body, `{"q":"it's"}`);
  assert.equal(p.followRedirects, false);
  assert.ok(p.headers.some(([k, v]) => k === "X-Key" && v === "v"));
  assert.ok(p.headers.some(([k, v]) => k === "Content-Type" && v === "application/json"));
  assert.ok(p.headers.some(([k, v]) => k === "Authorization" && v === "Basic " + btoa("u:p")));
  assert.equal(post.interval_sec, 60);
  assert.equal(post.paused, true);

  assert.equal(kw.keyword, "ok");
  assert.equal(kw.expected_status, "200-299,300-399");
  assert.ok(validExpected(kw.expected_status));

  assert.throws(() => convertKuma({}), /Uptime Kuma backup/);
});

test("builds alert messages per channel type", () => {
  const down = {
    kind: "down" as const, monitorId: "m1", projectId: "p1", project: "Pay <API>", monitor: "Checkout", method: "GET",
    url: "https://x.dev/a?b=1&c=2", error: "Expected status 200-399, got 503", statusCode: 503, latencyMs: 80,
    uptime7d: 0.9912, snippet: "<h1>Service Unavailable</h1>", summary: "The origin is overloaded.",
  };
  const app = "https://mw.dev";
  const tg = buildRequest({ type: "telegram", config: JSON.stringify({ token: "1:abc", chat_id: "-100" }) }, alertCard(down, app));
  assert.equal(tg.url, "https://api.telegram.org/bot1:abc/sendMessage");
  const body = tg.body as { chat_id: string; text: string; parse_mode: string; reply_markup: { inline_keyboard: { text: string; url: string }[][] } };
  assert.equal(body.chat_id, "-100");
  assert.equal(body.parse_mode, "HTML");
  assert.ok(body.text.startsWith("<b>🔴 Pay &lt;API&gt; / Checkout is DOWN</b>"), body.text);
  assert.ok(body.text.includes("https://x.dev/a?b=1&amp;c=2"));
  assert.ok(body.text.includes("💡 The origin is overloaded."));
  assert.ok(body.text.includes("503 · 80 ms · 7-day uptime 99.12%"));
  assert.ok(body.text.includes("<code>&lt;h1&gt;Service Unavailable&lt;/h1&gt;</code>"));
  assert.deepEqual(body.reply_markup.inline_keyboard[0].map((b) => b.url),
    ["https://mw.dev/monitors/m1", "https://mw.dev/monitors/m1?do=ack", "https://mw.dev/monitors/m1?do=mute"]);

  const up = { ...down, kind: "up" as const, statusCode: 200, downForMs: 780_000, failedChecks: 14, firstError: "502" };
  const gc = buildRequest({ type: "google_chat", config: JSON.stringify({ url: "https://chat.googleapis.com/x" }) }, alertCard(up, app));
  const card = (gc.body as { cardsV2: { card: { header: { title: string }; sections: { widgets: Record<string, any>[] }[] } }[] }).cardsV2[0].card;
  assert.equal(card.header.title, "🟢 Pay <API> / Checkout is back UP after 13m");
  assert.ok(card.sections[0].widgets[0].textParagraph.text.startsWith("Down 13m · 14 failed checks<br>First error: 502"));
  assert.deepEqual(card.sections[0].widgets[1].buttonList.buttons[0].onClick.openLink.url, "https://mw.dev/monitors/m1");

  const text = buildRequest({ type: "google_chat", config: JSON.stringify({ url: "https://chat.googleapis.com/x" }) }, alertCard(up), true);
  assert.ok((text.body as { text: string }).text.startsWith("*🟢 Pay <API> / Checkout is back UP after 13m*"));

  const wh = buildRequest({ type: "webhook", config: JSON.stringify({ url: "https://hooks.slack.com/x" }) }, testCard());
  assert.ok((wh.body as { content: string }).content.includes("**✅ CurlDog test**"));

  const g = groupCard([down, { ...down, monitor: "Refunds", error: "Timed out after 10s" }, { ...up, monitor: "Login" }], app);
  assert.equal(g.title, "🔴 Pay <API>: 2 DOWN, 1 back up");
  assert.deepEqual(g.lines, ["🔴 Checkout: Expected status 200-399, got 503", "🔴 Refunds: Timed out after 10s", "🟢 Login: up after 13m"]);
  assert.equal(g.buttons[0].url, "https://mw.dev/projects/p1");

  assert.equal(duration(30_000), "under a minute");
  assert.equal(duration(90 * 60_000), "1h 30m");
});

test("multi-step variables: extract and fill", () => {
  const vars: Record<string, string> = {};
  extract([["token", "$.data.items[0].token"], ["sid", "header:Set-Cookie"]], [["set-cookie", "s=1"]], `{"data":{"items":[{"token":"abc"}]}}`, vars);
  assert.deepEqual(vars, { token: "abc", sid: "s=1" });
  assert.throws(() => extract([["x", "$.nope"]], [], "{}", {}), /Couldn't find \$\.nope/);
  assert.throws(() => extract([["x", "$.a"]], [], "<html>", {}), /isn't JSON/);

  const req = parseCurl(`curl https://x.dev/u/{{token}} -H 'Authorization: Bearer {{token}}' -d '{"s":"{{sid}}"}'`);
  const filled = fill(req, vars);
  assert.equal(filled.url, "https://x.dev/u/abc");
  assert.ok(filled.headers.some(([k, v]) => k === "Authorization" && v === "Bearer abc"));
  assert.equal(filled.body, `{"s":"s=1"}`);
  assert.throws(() => fill(req, {}), /Variable \{\{token\}\} isn't set/);
});

test("heartbeats go down after interval plus grace", () => {
  const m = { interval_sec: 300, created_at: 0, last_ping_at: null as number | null };
  assert.equal(heartbeatResult(m, 60_000), null, "new heartbeat waits for its first ping");
  assert.equal(heartbeatResult(m, 10 * 60_000)?.error, "No ping received yet");
  m.last_ping_at = 1;
  assert.equal(heartbeatResult(m, 7 * 60_000)?.ok, true, "within 5m + 2.5m grace");
  assert.equal(heartbeatResult(m, 8 * 60_000)?.error, "No ping for 8m (expected every 5m)");
});

test("registrable domain for expiry checks", () => {
  assert.equal(registrable("auth.ssojet.com"), "ssojet.com");
  assert.equal(registrable("www.shop.co.uk"), "shop.co.uk");
});

test("groups Kuma monitors into one project per site", async () => {
  const { groupByDomain, siteOf } = await import("../public/kuma.js");
  assert.deepEqual(siteOf("https://sso-only.auth.ssojet.com/v1"), { key: "ssojet", domain: "ssojet.com" });
  assert.deepEqual(siteOf("https://www.shop.co.uk/x"), { key: "shop", domain: "shop.co.uk" });
  const groups = groupByDomain([
    { name: "https://ssojet.com/news", url: "https://ssojet.com/news" },
    { name: "SSOJet API", url: "https://api.ssojet.com/v1" },
    { name: "publish 7 dashboard", url: "https://publish7.com/health" },
    { name: "Compile7 Org", url: "https://compile7.org/" },
    { name: "https://compile7.com/blog", url: "https://compile7.com/blog" },
    { name: "Blog", url: "https://mailazy.com/blog" },
  ]);
  assert.deepEqual(groups.map((g: { name: string; domains: string[]; items: number[] }) => [g.name, g.domains, g.items]), [
    ["Compile7", ["compile7.org", "compile7.com"], [3, 4]],
    ["Mailazy", ["mailazy.com"], [5]],
    ["Publish 7", ["publish7.com"], [2]],
    ["SSOJet", ["ssojet.com"], [0, 1]],
  ]);
});
