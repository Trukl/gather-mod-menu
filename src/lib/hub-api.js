// Hub API library: requests to the community hub worker (see the
// gather-mod-hub repo), signed in with the Gather account: Gather's ID token
// is sent once for a hub session. The hub URL and the Gather token come from
// the core.
window.__gatherMods.define("hub-api", (ctx) => {
  const { me, readJson, writeJson, hubUrl, gatherIdToken } = ctx;
  const SESSION_KEY = "gathermodv2:hubSession";
  const RENEW_BEFORE_MS = 24 * 3_600_000;

  async function call(path, init = {}, session) {
    const r = await fetch(hubUrl() + path, {
      ...init,
      headers: { ...init.headers, Authorization: "Bearer " + session },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
      throw Object.assign(new Error(body.error || "HTTP " + r.status), { status: r.status });
    return body;
  }

  let signingIn = null;
  async function signIn() {
    const gatherToken = await gatherIdToken();
    if (!gatherToken) throw new Error("hub sign-in: no Gather session found");
    const r = await fetch(hubUrl() + "/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gatherToken }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("hub sign-in: " + (body.error || "HTTP " + r.status));
    writeJson(SESSION_KEY, { ...body, accountId: me().userAccountId });
    return body.session;
  }
  // A session belongs to one Gather account: switching accounts signs in again.
  function session() {
    const saved = readJson(SESSION_KEY, null);
    if (saved?.accountId === me().userAccountId && saved.expiresAt - Date.now() > RENEW_BEFORE_MS)
      return Promise.resolve(saved.session);
    signingIn ??= signIn().finally(() => (signingIn = null));
    return signingIn;
  }

  // A rejected session (expired, secret changed) is replaced once.
  async function request(path, init) {
    try {
      return await call(path, init, await session());
    } catch (e) {
      if (e.status !== 401) throw e;
      localStorage.removeItem(SESSION_KEY);
      return call(path, init, await session());
    }
  }

  // Hands items published before sign-in to the account, given their tokens.
  const claim = (items) =>
    request("/auth/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(items),
    });

  return { request, claim };
});
