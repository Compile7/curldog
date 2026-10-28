// Turns a pasted curl command into something fetch() can run.

export interface ParsedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
  followRedirects: boolean;
  timeoutMs?: number;
}

export class CurlError extends Error {}

const SHORT: Record<string, string> = {
  X: "--request", H: "--header", d: "--data", u: "--user", A: "--user-agent", e: "--referer",
  b: "--cookie", m: "--max-time", o: "--output", w: "--write-out", c: "--cookie-jar", D: "--dump-header",
  x: "--proxy", E: "--cert", F: "--form", T: "--upload-file", K: "--config", L: "--location", I: "--head",
  G: "--get", k: "--insecure", s: "--silent", S: "--show-error", v: "--verbose", i: "--include",
  f: "--fail", N: "--no-buffer", g: "--globoff", "#": "--progress-bar", Z: "--parallel",
};

const TAKES_VALUE = new Set([
  "--request", "--header", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode",
  "--json", "--user", "--user-agent", "--referer", "--cookie", "--max-time", "--output", "--write-out",
  "--cookie-jar", "--dump-header", "--proxy", "--cert", "--key", "--cacert", "--capath", "--form",
  "--upload-file", "--config", "--url", "--connect-timeout", "--retry", "--retry-delay",
  "--retry-max-time", "--max-redirs", "--resolve", "--connect-to", "--unix-socket",
]);

// Flags that change nothing about the request we send.
const IGNORED = new Set([
  "--silent", "--show-error", "--verbose", "--include", "--compressed", "--fail", "--fail-with-body",
  "--progress-bar", "--no-buffer", "--globoff", "--http1.0", "--http1.1", "--http2",
  "--http2-prior-knowledge", "--http3", "--parallel", "--output", "--write-out", "--cookie-jar",
  "--dump-header", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--max-redirs",
]);

const UNSUPPORTED: Record<string, string> = {
  "--insecure": "-k/--insecure isn't supported: Cloudflare Workers always verify TLS certificates.",
  "--proxy": "Proxies aren't supported.",
  "--resolve": "--resolve isn't supported. Use the real hostname.",
  "--connect-to": "--connect-to isn't supported. Use the real hostname.",
  "--cert": "Client certificates aren't supported.",
  "--key": "Client certificates aren't supported.",
  "--cacert": "Custom CA certificates aren't supported.",
  "--capath": "Custom CA certificates aren't supported.",
  "--form": "Multipart forms (-F) aren't supported. Send the body with --data instead.",
  "--upload-file": "File uploads (-T) aren't supported.",
  "--config": "Config files (-K) aren't supported.",
  "--unix-socket": "Unix sockets aren't supported.",
};

export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let i = 0;
  const unclosed = (q: string) => new CurlError(`Unclosed ${q} quote in curl command.`);
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "\n") { i += 2; continue; }
    if (c === "\\" && s[i + 1] === "\r" && s[i + 2] === "\n") { i += 3; continue; }
    if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ""; started = false; }
      i++;
      continue;
    }
    started = true;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw unclosed("single");
      cur += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === "$" && s[i + 1] === "'") {
      // ANSI-C quoting, which Chrome's "Copy as cURL" uses for bodies with special characters.
      const esc: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] !== "\\") { cur += s[i++]; continue; }
        const n = s[i + 1];
        if (n === "x") { cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; }
        else if (n === "u") { cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; }
        else { cur += esc[n] ?? "\\" + n; i += 2; }
      }
      if (i >= s.length) throw unclosed("single");
      i++;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && '"\\$`\n'.includes(s[i + 1])) {
          if (s[i + 1] !== "\n") cur += s[i + 1];
          i += 2;
        } else cur += s[i++];
      }
      if (i >= s.length) throw unclosed("double");
      i++;
    } else if (c === "\\") {
      cur += s[i + 1] ?? "";
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (started) out.push(cur);
  return out;
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function noFiles(flag: string, value: string) {
  if (value.startsWith("@")) throw new CurlError(`${flag} @file isn't supported. Paste the data inline.`);
}

export function parseCurl(input: string): ParsedRequest {
  const tokens = tokenize(input.trim());
  if (tokens[0] === "curl") tokens.shift();
  if (!tokens.length) throw new CurlError("Paste a curl command, e.g. curl https://example.com");

  let method: string | undefined;
  let url: string | undefined;
  let user: string | undefined;
  let timeoutMs: number | undefined;
  let head = false, get = false, json = false, follow = false;
  const headers: [string, string][] = [];
  const data: string[] = [];

  const apply = (flag: string, value = "") => {
    if (UNSUPPORTED[flag]) throw new CurlError(UNSUPPORTED[flag]);
    if (IGNORED.has(flag)) return;
    switch (flag) {
      case "--request": method = value.toUpperCase(); return;
      case "--header": {
        const i = value.indexOf(":");
        if (i < 1) throw new CurlError(`Header "${value}" must look like "Name: value".`);
        const v = value.slice(i + 1).trim();
        if (v) headers.push([value.slice(0, i).trim(), v]);
        return;
      }
      case "--data": case "--data-ascii": case "--data-binary":
        noFiles(flag, value); data.push(value); return;
      case "--data-raw": data.push(value); return;
      case "--json": noFiles(flag, value); data.push(value); json = true; return;
      case "--data-urlencode": {
        noFiles(flag, value);
        const i = value.indexOf("=");
        data.push(i < 0 ? encodeURIComponent(value) : (i ? value.slice(0, i) + "=" : "") + encodeURIComponent(value.slice(i + 1)));
        return;
      }
      case "--user": user = value; return;
      case "--user-agent": headers.push(["User-Agent", value]); return;
      case "--referer": headers.push(["Referer", value]); return;
      case "--cookie":
        if (!value.includes("=")) throw new CurlError("Cookie files aren't supported. Pass cookies inline: -b 'name=value'.");
        headers.push(["Cookie", value]);
        return;
      case "--max-time": timeoutMs = Math.round(parseFloat(value) * 1000) || undefined; return;
      case "--location": follow = true; return;
      case "--head": head = true; return;
      case "--get": get = true; return;
      case "--url": url = value; return;
    }
    throw new CurlError(`Unknown curl option ${flag}.`);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = (flag: string) => {
      if (++i >= tokens.length) throw new CurlError(`${flag} needs a value.`);
      return tokens[i];
    };
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > 0 && TAKES_VALUE.has(t.slice(0, eq))) apply(t.slice(0, eq), t.slice(eq + 1));
      else apply(t, TAKES_VALUE.has(t) ? next(t) : undefined);
    } else if (t.startsWith("-") && t.length > 1) {
      // Short flags can be bundled (-sSL) or carry their value (-XPOST).
      for (let j = 1; j < t.length; j++) {
        const flag = SHORT[t[j]];
        if (!flag) throw new CurlError(`Unknown curl option -${t[j]}.`);
        if (TAKES_VALUE.has(flag)) { apply(flag, t.slice(j + 1) || next(flag)); break; }
        apply(flag);
      }
    } else {
      url = t;
    }
  }

  if (!url) throw new CurlError("No URL found in the curl command.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http://" + url;
  let u: URL;
  try { u = new URL(url); } catch { throw new CurlError(`"${url}" isn't a valid URL.`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new CurlError("Only http:// and https:// URLs can be monitored.");
  if (u.username && user === undefined) user = decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password);
  u.username = u.password = "";

  let body: string | null = data.length ? data.join("&") : null;
  if (get && body !== null) {
    u.search = u.search ? `${u.search}&${body}` : `?${body}`;
    body = null;
  }
  method ??= head ? "HEAD" : body !== null ? "POST" : "GET";
  if (body !== null && (method === "GET" || method === "HEAD")) {
    throw new CurlError(`${method} requests can't have a body. Add -G to send the data as query parameters.`);
  }

  const has = (name: string) => headers.some(([k]) => k.toLowerCase() === name);
  if (body !== null && !has("content-type")) {
    headers.push(["Content-Type", json ? "application/json" : "application/x-www-form-urlencoded"]);
  }
  if (json && !has("accept")) headers.push(["Accept", "application/json"]);
  if (user !== undefined && !has("authorization")) {
    headers.push(["Authorization", "Basic " + base64(user.includes(":") ? user : user + ":")]);
  }

  return { method, url: u.toString(), headers, body, followRedirects: follow, timeoutMs };
}
