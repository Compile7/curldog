// Verifies the Cloudflare Access JWT so the API can't be reached around Access
// (e.g. via the workers.dev URL). Returns the user's email, or null.

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN?: string; // e.g. "acme.cloudflareaccess.com"
  ACCESS_AUD?: string; // Application Audience (AUD) tag
  DEV_USER?: string; // local dev only, set in .dev.vars
}

type Jwk = JsonWebKey & { kid: string };
let keyCache: { domain: string; at: number; keys: Jwk[] } | null = null;

const b64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function getKeys(domain: string): Promise<Jwk[]> {
  if (keyCache?.domain === domain && Date.now() - keyCache.at < 3_600_000) return keyCache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  keyCache = { domain, at: Date.now(), keys };
  return keys;
}

export async function getUser(req: Request, env: AuthEnv): Promise<string | null> {
  if (env.DEV_USER) return env.DEV_USER;
  const token = req.headers.get("cf-access-jwt-assertion");
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (!token || !domain || !env.ACCESS_AUD) return null;
  try {
    const [h, p, sig] = token.split(".");
    const header = decodeJson(h);
    if (header.alg !== "RS256") return null;
    const jwk = (await getKeys(domain)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return null;
    const claims = decodeJson(p);
    const aud: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (claims.iss !== `https://${domain}`) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return claims.email ?? claims.common_name ?? null;
  } catch (e) {
    console.error("access jwt", e);
    return null;
  }
}
