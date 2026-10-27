// Hub API library: requests to the community hub worker (see the
// gather-mod-hub repo), signed in with the Gather account: Gather's ID token
// is sent once for a hub session. The hub URL and the session come from the
// core.
window.__gatherMods.define("hub-api", (ctx) => {
  const { hubFetch, hubSession, dropHubSession } = ctx;

  async function call(path, init = {}, session) {
    const r = await hubFetch(path, {
      ...init,
      headers: { ...init.headers, Authorization: "Bearer " + session },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
      throw Object.assign(new Error(body.error || "HTTP " + r.status), { status: r.status });
    return body;
  }

  // A rejected session (expired, secret changed) is replaced once.
  async function request(path, init) {
    try {
      return await call(path, init, await hubSession());
    } catch (e) {
      if (e.status !== 401) throw e;
      dropHubSession();
      return call(path, init, await hubSession());
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
