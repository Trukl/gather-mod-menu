import { catalogErrors, releaseChanges } from "../../launcher/mod-release.mjs";

const LEGACY_RELEASE_KEY = "mod:latest";
const CATALOG_KEY = "catalog:latest";
const codeKey = (hash) => `code:${hash}`;
const HASH_RE = /^[0-9a-f]{64}$/;
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const REPOSITORY_ID = "1406362143";
const REPOSITORY_OWNER_ID = "26184788";
const WORKFLOW_REF = "Trukl/gather-mod-menu/.github/workflows/release.yml@refs/heads/main";
const MAX_CODE_CHARS = 1_000_000;

const HEADERS = {
  "Access-Control-Allow-Origin": "https://app.v2.gather.town",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

const base64UrlBytes = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const base64UrlJson = (s) => JSON.parse(new TextDecoder().decode(base64UrlBytes(s)));

async function verifyGithubToken(token, audience) {
  const [header, payload, signature] = token.split(".");
  if (!signature) return null;
  const { kid, alg } = base64UrlJson(header);
  if (alg !== "RS256") return null;
  const jwks = await fetch(`${GITHUB_ISSUER}/.well-known/jwks`).then((r) => r.json());
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return null;
  const claims = base64UrlJson(payload);
  const now = Date.now() / 1000;
  const authorized =
    claims.iss === GITHUB_ISSUER &&
    claims.aud === audience &&
    claims.exp > now &&
    (claims.nbf ?? 0) <= now + 60 &&
    claims.repository_id === REPOSITORY_ID &&
    claims.repository_owner_id === REPOSITORY_OWNER_ID &&
    claims.ref === "refs/heads/main" &&
    claims.workflow_ref === WORKFLOW_REF;
  return authorized ? claims : null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function publishRelease(request, env, url) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const claims = token && (await verifyGithubToken(token, url.origin).catch(() => null));
  if (!claims) return json({ error: "forbidden" }, 403);
  const body = await request.json().catch(() => null);
  let manifest;
  try {
    manifest = JSON.parse(body?.manifest);
  } catch {
    return json({ error: "invalid manifest" }, 400);
  }
  const modules = manifest?.modules;
  if (
    manifest?.commit !== claims.sha ||
    !Array.isArray(modules) ||
    typeof body.bundle !== "object" ||
    body.bundle === null ||
    typeof body.codes !== "object" ||
    body.codes === null
  )
    return json({ error: "invalid release" }, 400);
  const errors = catalogErrors(modules);
  if (modules.some((m) => !HASH_RE.test(m.hash))) errors.push("invalid module hash");
  const newCodes = {};
  for (const m of modules) {
    const code = body.codes[m.hash];
    if (typeof code === "string") {
      if (code.length > MAX_CODE_CHARS || (await sha256Hex(code)) !== m.hash)
        errors.push(`${m.id}: code does not match its hash`);
      else newCodes[m.hash] = code;
    } else if (!(await env.RELEASES.get(codeKey(m.hash)))) errors.push(`${m.id}: missing code`);
  }
  if (errors.length) return json({ error: errors.join("; ") }, 400);
  const current = await env.RELEASES.get(CATALOG_KEY, "json");
  const { errors: versionErrors, changed } = releaseChanges(
    modules,
    current ? JSON.parse(current.manifest).modules : null,
  );
  if (versionErrors.length) return json({ error: versionErrors.join("; ") }, 409);
  if (!changed.length) return json({ error: "nothing changed" }, 409);
  const release = {
    manifest: body.manifest,
    bundle: body.bundle,
    publishedAt: new Date().toISOString(),
  };
  if (url.searchParams.get("dryRun") !== "1") {
    for (const [hash, code] of Object.entries(newCodes))
      await env.RELEASES.put(codeKey(hash), code);
    await env.RELEASES.put(CATALOG_KEY, JSON.stringify(release));
  }
  return json({ ...release, changed }, 201);
}

async function serve(env, key, headers = HEADERS) {
  const value = await env.RELEASES.get(key);
  return value === null ? json({ error: "not found" }, 404) : new Response(value, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/release")
      return request.method === "POST"
        ? publishRelease(request, env, url)
        : json({ error: "method not allowed" }, 405);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (url.pathname === "/catalog") return serve(env, CATALOG_KEY);
    if (url.pathname === "/latest") return serve(env, LEGACY_RELEASE_KEY);
    const hash = url.pathname.match(/^\/modules\/([0-9a-f]{64})$/)?.[1];
    if (hash)
      return serve(env, codeKey(hash), {
        ...HEADERS,
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    return json({ error: "not found" }, 404);
  },
};
