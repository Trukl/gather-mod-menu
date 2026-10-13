// Hub API library: requests to the community hub worker (see the
// gather-mod-hub repo), signed in with the Gather account: Gather's ID token
// is sent once for a hub session. The URL can be overridden in localStorage
// for local development.
window.__gatherMods.define("hub-api", (ctx) => {
  const { me, readJson, writeJson } = ctx;
  const DEFAULT_URL = "https://gather-mods-hub.minnecorentin.workers.dev";
  const URL_KEY = "gathermodv2:hubUrl";
  const SESSION_KEY = "gathermodv2:hubSession";
  const RENEW_BEFORE_MS = 24 * 3_600_000;

  async function call(path, init = {}, session) {
    const r = await fetch((localStorage.getItem(URL_KEY) || DEFAULT_URL) + path, {
      ...init,
      headers: { ...init.headers, Authorization: "Bearer " + session },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
      throw Object.assign(new Error(body.error || "HTTP " + r.status), { status: r.status });
    return body;
  }

  // Firebase keeps the signed-in user, with an ID token it refreshes, in IndexedDB.
  async function gatherIdToken() {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("firebaseLocalStorageDb");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const rows = await new Promise((resolve, reject) => {
        const read = db
          .transaction("firebaseLocalStorage")
          .objectStore("firebaseLocalStorage")
          .getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      const user = rows.find((r) => String(r.fbase_key).startsWith("firebase:authUser:"))?.value;
      return user?.stsTokenManager?.accessToken ?? null;
    } finally {
      db.close();
    }
  }

  let signingIn = null;
  async function signIn() {
    const gatherToken = await gatherIdToken();
    if (!gatherToken) throw new Error("hub sign-in: no Gather session found");
    const r = await fetch((localStorage.getItem(URL_KEY) || DEFAULT_URL) + "/auth", {
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
