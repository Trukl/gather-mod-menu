// Community hub: browse, preview, add and publish presets shared by others
// (Cloudflare Worker, see the gather-mod-hub repo). Tabs follow the installed
// preset modules (outfits, desks, constructions).
window.__gatherMods.define("hub", (ctx) => {
  const { me, escapeHtml, readJson, writeJson } = ctx;
  const previews = ctx.use("previews");
  const hubFetch = ctx.use("hub-api").request;
  const HUB_TOKENS_KEY = "gathermodv2:hubTokens";
  const hub = { type: null, q: "", items: [], searchTimer: null };

  const isModalOpen = () => !!document.getElementById("gm-hub-grid");
  const presetType = () => ctx.presetType(hub.type);
  function setStatus(text) {
    for (const id of ["gm-hub-status", "gm-modal-status"]) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }
  }

  async function refresh() {
    if (!isModalOpen() || !presetType()) return;
    if (presetType().needsCatalog) previews.ensureCatalog();
    setStatus("Loading…");
    try {
      hub.items = (await hubFetch(`/presets/${hub.type}?q=${encodeURIComponent(hub.q)}`)).items;
      setStatus(hub.items.length ? "" : "Nothing here yet");
    } catch (e) {
      hub.items = [];
      setStatus("Hub error: " + e.message);
    }
    renderGrid();
  }
  previews.onCatalog(renderGrid);

  function addFromHub(id) {
    const item = hub.items.find((i) => i.id === id);
    if (!item) return;
    setStatus(
      ctx.addPresets(item.type, [item.data])
        ? `Added "${item.name}" to my ${item.type}s`
        : `"${item.name}" is already in my ${item.type}s`,
    );
  }
  async function publish(type, preset) {
    setStatus("Publishing…");
    try {
      const { id, deleteToken } = await hubFetch(`/presets/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: me().name, data: preset }),
      });
      writeJson(HUB_TOKENS_KEY, {
        ...readJson(HUB_TOKENS_KEY, {}),
        [`${type}:${id}`]: deleteToken,
      });
      if (hub.type === type) await refresh();
      setStatus(`Published "${preset.name}"`);
    } catch (e) {
      setStatus("Publish failed: " + e.message);
    }
  }
  async function remove(type, id) {
    const tokens = readJson(HUB_TOKENS_KEY, {});
    const key = `${type}:${id}`;
    try {
      await hubFetch(`/presets/${type}/${id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + tokens[key] },
      });
      delete tokens[key];
      writeJson(HUB_TOKENS_KEY, tokens);
      hub.items = hub.items.filter((i) => i.id !== id);
      setStatus("Deleted from the hub");
      renderGrid();
    } catch (e) {
      setStatus("Delete failed: " + e.message);
    }
  }

  function renderGrid() {
    const grid = document.getElementById("gm-hub-grid");
    const type = presetType();
    if (!grid || !type) return;
    const tokens = readJson(HUB_TOKENS_KEY, {});
    grid.innerHTML = hub.items
      .map((p) => {
        const id = escapeHtml(p.id);
        const del = tokens[`${p.type}:${p.id}`]
          ? `<button class="gm-btn" data-hdel="${id}">Delete</button>`
          : "";
        return `<div class="gm-card" title="${escapeHtml(p.summary)}">
          <div class="gm-preview">${type.preview(p.data)}</div>
          <div class="gm-card-name">${escapeHtml(p.name)}</div>
          <div class="gm-card-author">by ${escapeHtml(p.author)}</div>
          <div class="gm-card-actions"><button class="gm-btn" data-add="${id}">Add</button>${del}</div>
        </div>`;
      })
      .join("");
    previews.fitImages(grid);
    grid.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => addFromHub(b.dataset.add);
    });
    grid.querySelectorAll("[data-hdel]").forEach((b) => {
      b.onclick = () => remove(hub.type, b.dataset.hdel);
    });
  }

  function openHubModal() {
    const types = ctx.presetTypes();
    if (isModalOpen()) return;
    if (!types.length) {
      setStatus("Install Outfits, Desks or Constructions to use the hub");
      return;
    }
    if (!types.some((t) => t.type === hub.type)) hub.type = types[0].type;
    const modal = ctx.openModal(
      "Community hub",
      `
      <div class="gm-toolbar">
        ${types.map((t) => `<button class="gm-btn" data-hub-type="${t.type}">${escapeHtml(t.label)}</button>`).join("")}
        <input class="gm-input" id="gm-hub-search" placeholder="Search by name, author or item..." />
      </div>
      <div class="gm-grid" id="gm-hub-grid"></div>
      <div class="gm-status"><span id="gm-modal-status"></span><span class="gm-link" id="gm-hub-refresh">Refresh</span></div>`,
    );
    const syncTabs = () =>
      modal
        .querySelectorAll("[data-hub-type]")
        .forEach((b) => b.classList.toggle("active", b.dataset.hubType === hub.type));
    modal.querySelectorAll("[data-hub-type]").forEach((b) => {
      b.onclick = () => {
        hub.type = b.dataset.hubType;
        syncTabs();
        refresh();
      };
    });
    syncTabs();
    const search = modal.querySelector("#gm-hub-search");
    search.value = hub.q;
    search.addEventListener("input", () => {
      clearTimeout(hub.searchTimer);
      hub.searchTimer = setTimeout(() => {
        hub.q = search.value.trim();
        refresh();
      }, 300);
    });
    modal.querySelector("#gm-hub-refresh").onclick = refresh;
    refresh();
    search.focus();
  }

  ctx.section({
    title: "Community hub",
    html: `
      <button class="gm-btn" id="gm-hub-open">Browse community presets</button>
      <div class="gm-status"><span id="gm-hub-status"></span></div>`,
    mount(el) {
      el.querySelector("#gm-hub-open").onclick = openHubModal;
    },
  });
  ctx.style(`
    #gather-mods-modal .gm-toolbar { display:flex; gap:6px; align-items:center; }
    #gather-mods-modal .gm-toolbar button.gm-btn { width:auto; text-align:center; padding:7px 14px; margin:0; }
    #gather-mods-modal .gm-toolbar .gm-input { flex:1; margin:0; }
    #gather-mods-modal .gm-grid { flex:1; overflow-y:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:10px; align-content:start; }
    #gather-mods-modal .gm-card { display:flex; flex-direction:column; gap:4px; padding:8px; background:var(--gm-surface); border-radius:10px; }
    #gather-mods-modal .gm-card-name { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; }
    #gather-mods-modal .gm-card-author { font-size:11px; color:var(--gm-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #gather-mods-modal .gm-card-actions { display:flex; gap:6px; margin-top:4px; }
    #gather-mods-modal .gm-card-actions button.gm-btn { flex:1; text-align:center; padding:5px; margin:0; }
  `);

  return { publish };
});
