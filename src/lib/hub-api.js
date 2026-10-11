// Hub API library: JSON requests to the community hub worker (see the
// gather-mod-hub repo). The URL can be overridden in localStorage for local development.
window.__gatherMods.define("hub-api", () => {
  const DEFAULT_URL = "https://gather-mods-hub.minnecorentin.workers.dev";
  const URL_KEY = "gathermodv2:hubUrl";

  async function request(path, init) {
    const r = await fetch((localStorage.getItem(URL_KEY) || DEFAULT_URL) + path, init);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
    return body;
  }

  return { request };
});
