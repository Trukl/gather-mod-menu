// Outfits: save and apply outfit presets, including "No outfit" and "Invisible".
window.__gatherMods.define("outfits", (ctx) => {
  const { GD, me, escapeHtml, readJson, writeJson, onEnter, flash } = ctx;
  const previews = ctx.use("previews");
  const { OUTFIT_SLOTS } = previews;
  const OUTFITS_KEY = "gathermodv2:outfits";
  const BOWTIE_ID = "9bdd32b6-afa0-4325-ad5b-8702c9ac2eb3";
  const BUILTIN_OUTFITS = [
    { name: "No outfit", summary: "Empty, shows after reload", outfit: {} },
    { name: "Invisible", summary: "Bowtie", outfit: { other: BOWTIE_ID } },
  ];

  const getOutfits = () => readJson(OUTFITS_KEY, []);
  const saveOutfits = (l) => writeJson(OUTFITS_KEY, l);

  function snapshotOutfit(name) {
    const current = me().outfit;
    if (!current) return null;
    const outfit = {};
    const parts = [];
    for (const slot of OUTFIT_SLOTS) {
      if (!current[slot]) continue;
      outfit[slot] = current[slot];
      const wearable = GD().Repos.Wearable.get(current[slot]);
      if (wearable?.name) parts.push(wearable.name);
    }
    return { name, outfit, summary: parts.join(", ") };
  }
  // Keys set to undefined clear the slot; absent keys would keep it.
  const applyOutfit = (preset) =>
    me().saveSpaceOutfit(Object.fromEntries(OUTFIT_SLOTS.map((s) => [s, preset.outfit[s]])));

  function cleanOutfit(p) {
    if (typeof p?.name !== "string" || typeof p.outfit !== "object" || p.outfit === null)
      return null;
    return {
      name: p.name,
      outfit: Object.fromEntries(
        OUTFIT_SLOTS.filter((s) => typeof p.outfit[s] === "string").map((s) => [s, p.outfit[s]]),
      ),
      summary: typeof p.summary === "string" ? p.summary : "",
    };
  }

  let root = null;
  function renderList() {
    if (!root?.isConnected) return;
    const list = root.querySelector("#gm-outfits");
    const hub = ctx.use("hub");
    const builtinRows = BUILTIN_OUTFITS.map(
      (p, i) =>
        `<div class="gm-item" data-builtin="${i}" title="${escapeHtml(p.summary)}"><span class="gm-name">${escapeHtml(p.name)}</span></div>`,
    );
    const savedRows = getOutfits().map(
      (p, i) =>
        `<div class="gm-item" data-idx="${i}" title="${escapeHtml(p.summary || "")}"><span class="gm-name">${escapeHtml(p.name)}</span><span class="gm-actions">${hub ? `<span class="gm-pub" data-pub="${i}" title="Publish to the community hub">⇪</span>` : ""}<span class="gm-del" data-del="${i}">✕</span></span></div>`,
    );
    previews.hidePopover();
    list.innerHTML = [...builtinRows, ...savedRows].join("");
    const presetOf = (row) =>
      row.dataset.builtin ? BUILTIN_OUTFITS[+row.dataset.builtin] : getOutfits()[+row.dataset.idx];
    list.querySelectorAll(".gm-item").forEach((row) => {
      previews.attachPopover(row, () => {
        const preset = presetOf(row);
        return preset ? previews.outfitPreviewHtml(preset.outfit) : "";
      });
      row.onclick = () => {
        const preset = presetOf(row);
        if (preset) applyOutfit(preset);
      };
    });
    list.querySelectorAll(".gm-del").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        const l = getOutfits();
        l.splice(+d.dataset.del, 1);
        saveOutfits(l);
        renderList();
      };
    });
    list.querySelectorAll(".gm-pub").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        hub?.publish("outfit", getOutfits()[+b.dataset.pub]);
      };
    });
  }

  ctx.registerPresetType({
    type: "outfit",
    key: "outfits",
    label: "Outfits",
    list: getOutfits,
    save: saveOutfits,
    clean: cleanOutfit,
    preview: (p) => previews.outfitPreviewHtml(p.outfit),
    needsCatalog: false,
    onChange: renderList,
  });

  ctx.section({
    title: "Outfits",
    html: `
      <div class="gm-row">
        <input class="gm-input" id="gm-outfit-name" placeholder="Name this outfit..." />
        <button class="gm-btn" id="gm-outfit-save">Save</button>
      </div>
      <div class="gm-list" id="gm-outfits"></div>`,
    mount(el) {
      root = el;
      const input = el.querySelector("#gm-outfit-name");
      const saveBtn = el.querySelector("#gm-outfit-save");
      const save = () => {
        const name = input.value.trim();
        if (!name) return;
        const preset = snapshotOutfit(name);
        if (!preset) return flash(saveBtn, "No outfit");
        saveOutfits([...getOutfits(), preset]);
        input.value = "";
        renderList();
      };
      onEnter(input, save);
      saveBtn.onclick = save;
      renderList();
    },
  });
});
