// Community hub: browse, preview, add and publish presets shared by others
// (Cloudflare Worker, see the gather-mod-hub repo). Tabs follow the installed
// preset modules (outfits, desks, constructions). Your presets are those of
// your Gather account.
window.__gatherMods.define("hub", (ctx) => {
  const { me, escapeHtml, readJson } = ctx;
  const previews = ctx.use("previews");
  const api = ctx.use("hub-api");
  const LEGACY_TOKENS_KEY = "gathermodv2:hubTokens";
  const hub = { type: null, q: "", items: [], searchTimer: null };

  const isModalOpen = () => !!document.getElementById("gm-hub-grid");
  const presetType = () => ctx.presetType(hub.type);
  const STATUS_ICONS = { ok: "circle-check", err: "circle-alert" };
  function setStatus(text, tone) {
    for (const id of ["gm-hub-status", "gm-modal-status"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = text;
      const note = el.parentElement;
      note.classList.toggle("gm-ok", tone === "ok");
      note.classList.toggle("gm-err", tone === "err");
      note.querySelector(".gm-i").dataset.i = STATUS_ICONS[tone] ?? "info";
    }
  }

  // Presets published before sign-in are handed to the Gather account once.
  async function claimLegacyPresets() {
    const tokens = readJson(LEGACY_TOKENS_KEY, null);
    if (!tokens) return;
    await api.claim({
      presets: Object.entries(tokens).map(([key, token]) => {
        const [type, id] = key.split(":");
        return { type, id, token };
      }),
    });
    localStorage.removeItem(LEGACY_TOKENS_KEY);
  }

  async function refresh() {
    if (!isModalOpen() || !presetType()) return;
    if (presetType().needsCatalog) previews.ensureCatalog();
    setStatus("Loading…");
    try {
      await claimLegacyPresets();
      hub.items = (await api.request(`/presets/${hub.type}?q=${encodeURIComponent(hub.q)}`)).items;
      setStatus(hub.items.length ? "" : "Nothing here yet");
    } catch (e) {
      hub.items = [];
      setStatus("Hub error: " + e.message, "err");
    }
    renderGrid();
  }
  previews.onCatalog(renderGrid);

  function addFromHub(id) {
    const item = hub.items.find((i) => i.id === id);
    if (!item) return;
    if (ctx.addPresets(item.type, [item.data]))
      setStatus(`Added "${item.name}" to my ${item.type}s`, "ok");
    else setStatus(`"${item.name}" is already in my ${item.type}s`);
  }
  async function publish(type, preset) {
    setStatus("Publishing…");
    try {
      await api.request(`/presets/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: me().name, data: preset }),
      });
      if (hub.type === type) await refresh();
      setStatus(`Published "${preset.name}"`, "ok");
    } catch (e) {
      setStatus("Publish failed: " + e.message, "err");
    }
  }
  async function remove(type, id) {
    try {
      await api.request(`/presets/${type}/${id}`, { method: "DELETE" });
      hub.items = hub.items.filter((i) => i.id !== id);
      setStatus("Deleted from the hub", "ok");
      renderGrid();
    } catch (e) {
      setStatus("Delete failed: " + e.message, "err");
    }
  }

  function renderGrid() {
    const grid = document.getElementById("gm-hub-grid");
    const type = presetType();
    if (!grid || !type) return;
    grid.innerHTML = hub.items
      .map((p) => {
        const id = escapeHtml(p.id);
        const del = p.mine
          ? `<button class="gm-btn gm-sm gm-ghost gm-danger" data-hdel="${id}"><i class="gm-i sm" data-i="trash-2"></i>Delete</button>`
          : "";
        return `<div class="gm-hub-card" title="${escapeHtml(p.summary)}">
          <div class="gm-preview">${type.preview(p.data)}</div>
          <div class="gm-hub-card-text">
            <div class="gm-hub-card-name">${escapeHtml(p.name)}</div>
            <div class="gm-hub-card-meta">by ${escapeHtml(p.author)}</div>
          </div>
          <div class="gm-hub-card-actions"><button class="gm-btn gm-sm gm-primary" data-add="${id}"><i class="gm-i sm" data-i="plus"></i>Add</button>${del}</div>
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
      <div class="gm-window-body">
        <div class="gm-hub-toolbar">
          <div class="gm-field gm-hub-search"><i class="gm-i" data-i="search"></i><input class="gm-input" id="gm-hub-search" placeholder="Search by name, author or item" /></div>
          ${types.length > 1 ? `<div class="gm-seg">${types.map((t) => `<button data-hub-type="${t.type}">${escapeHtml(t.label)}</button>`).join("")}</div>` : ""}
          <button class="gm-iconbtn" id="gm-hub-refresh" title="Refresh"><i class="gm-i" data-i="refresh-cw"></i></button>
        </div>
        <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span id="gm-modal-status"></span></div>
        <div class="gm-hub-grid" id="gm-hub-grid"></div>
      </div>`,
      "gm-modal-hub",
    );
    const syncTabs = () =>
      modal
        .querySelectorAll("[data-hub-type]")
        .forEach((b) => b.classList.toggle("on", b.dataset.hubType === hub.type));
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
      <button class="gm-btn gm-block" id="gm-hub-open"><i class="gm-i" data-i="globe"></i>Browse community presets</button>
      <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span id="gm-hub-status"></span></div>`,
    mount(el) {
      el.querySelector("#gm-hub-open").onclick = openHubModal;
    },
  });
  ctx.style(`
    #gather-mods-modal .gm-modal-hub { width:min(900px, 92vw); height:min(680px, 86vh); }
    #gather-mods-modal .gm-modal-hub .gm-window-body { flex:1; min-height:0; overflow:hidden; }
    #gather-mods-modal .gm-hub-toolbar { display:flex; gap:8px; align-items:center; }
    #gather-mods-modal .gm-hub-search { flex:1; min-width:0; }
    #gather-mods-modal .gm-hub-search .gm-input { width:100%; }
    #gather-mods-modal .gm-hub-toolbar .gm-seg { flex-shrink:0; }
    #gather-mods-modal .gm-hub-grid { flex:1; min-height:0; overflow-y:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(168px, 1fr));
      gap:12px; align-content:start; }
    #gather-mods-modal .gm-hub-card { display:flex; flex-direction:column; gap:8px; padding:8px; border:1px solid var(--gm-line); border-radius:12px;
      background:var(--gm-surface); }
    #gather-mods-modal .gm-hub-card-text { display:flex; flex-direction:column; gap:1px; min-width:0; padding:0 2px; }
    #gather-mods-modal .gm-hub-card-name { font-size:13px; font-weight:600; color:var(--gm-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #gather-mods-modal .gm-hub-card-meta { font-size:11.5px; color:var(--gm-text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #gather-mods-modal .gm-hub-card-actions { display:flex; gap:6px; }
    #gather-mods-modal .gm-hub-card-actions .gm-btn { flex:1; }
  `);

  return { publish };
});
