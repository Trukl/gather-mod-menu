// Previews library: outfit sprites, object layout previews (desks, constructions,
// ghosts) and the hover popover shown next to preset lists.
window.__gatherMods.define("previews", (ctx) => {
  const { GD, escapeHtml } = ctx;
  const TILE_PX = 32;
  const PREVIEW_W = 140;
  const PREVIEW_H = 120;
  const PREVIEW_BOX_H = PREVIEW_H + 10;
  const SPRITE_PROFILE_URL = "https://sprite.v2.gather.town/v2/sprite-profile/avatar-";
  const OUTFIT_SLOTS = [
    "skin",
    "hair",
    "facialHair",
    "top",
    "jacket",
    "bottom",
    "shoes",
    "hat",
    "glasses",
    "other",
    "costume",
    "mobility",
  ];

  const catalog = { unsubscribe: null, promise: null, failed: false, listeners: new Set() };
  // Variant metadata (sprite URL, size, origin) is only loaded for objects on
  // the current map; subscribing to the whole catalog makes any preset previewable.
  function ensureCatalog() {
    catalog.promise ??= (async () => {
      try {
        const sub =
          GD().Repos.gameSpace.spaceClient.modelSubscriptionManager.getSubscription(
            "CatalogItemVariant",
          );
        catalog.unsubscribe = await sub.subscribe("All", new Set());
      } catch (e) {
        catalog.failed = true;
        console.error("[GatherMods] catalog subscription failed", e);
      }
      catalog.listeners.forEach((fn) => fn());
    })();
    return catalog.promise;
  }
  const catalogReady = () => !!catalog.unsubscribe;
  ctx.onCleanup(() => catalog.unsubscribe?.());

  function outfitPreviewHtml(outfit) {
    const ids = OUTFIT_SLOTS.map((s) => outfit[s]).filter(Boolean);
    if (!ids.length) return '<span class="gm-empty">Empty outfit</span>';
    const src = SPRITE_PROFILE_URL + ids.join(".") + ".png";
    return `<div class="gm-outfit-crop"><img class="gm-outfit-img" crossorigin="anonymous" alt="" src="${escapeHtml(src)}"></div>`;
  }
  const outfitCrops = new Map();
  function outfitCrop(img) {
    if (!outfitCrops.has(img.src)) {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const c2d = canvas.getContext("2d");
      c2d.drawImage(img, 0, 0);
      const { data } = c2d.getImageData(0, 0, w, h);
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (data[(y * w + x) * 4 + 3]) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
      outfitCrops.set(img.src, x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return outfitCrops.get(img.src);
  }
  function fitOutfitImg(img) {
    const box = img.parentElement;
    let crop = null;
    try {
      crop = outfitCrop(img);
    } catch (e) {
      console.warn("[GatherMods] outfit preview crop failed", e);
    }
    const { naturalWidth: w, naturalHeight: h } = img;
    const area = crop ?? { x: 0, y: 0, w, h };
    const fit = Math.min(PREVIEW_W / area.w, PREVIEW_BOX_H / area.h, 1);
    const scale = Math.max(Math.floor(fit * 4) / 4, 0.25);
    box.style.width = area.w * scale + "px";
    box.style.height = area.h * scale + "px";
    Object.assign(img.style, {
      left: -area.x * scale + "px",
      top: -area.y * scale + "px",
      width: w * scale + "px",
      height: h * scale + "px",
      visibility: "visible",
    });
  }
  function fitImages(root) {
    root.querySelectorAll("img.gm-outfit-img").forEach((img) => {
      if (img.complete && img.naturalWidth) fitOutfitImg(img);
      else img.onload = () => fitOutfitImg(img);
    });
  }

  // Sprites in draw order (children after their parent), in pixels relative to
  // the items' origin.
  function collectSprites(items, baseX = 0, baseY = 0, out = []) {
    const placed = items.map((item) => {
      const x = baseX + item.x;
      const y = baseY + item.y;
      const variant = GD().Repos.CatalogItemVariant.get(item.variant);
      const size = variant?.dimensionsInPixels;
      if (!size) return { item, x, y, sprite: null, depth: y * TILE_PX };
      const top = y * TILE_PX - variant.originY;
      const depth = top + (variant.mainRenderable?.fold ?? size.height);
      const sprite = {
        url: variant.mainRenderableUrl,
        left: x * TILE_PX - variant.originX,
        top,
        width: size.width,
        height: size.height,
      };
      return { item, x, y, sprite, depth };
    });
    for (const { item, x, y, sprite } of placed.sort((a, b) => a.depth - b.depth)) {
      if (sprite) out.push(sprite);
      collectSprites(item.children, x, y, out);
    }
    return out;
  }

  function layoutPreviewHtml(items, area) {
    if (catalog.failed) return '<span class="gm-empty">Preview unavailable</span>';
    if (!catalogReady()) return '<span class="gm-empty">Loading preview…</span>';
    const sprites = collectSprites(items);
    const zone = area && {
      left: 0,
      top: 0,
      width: area.width * TILE_PX,
      height: area.height * TILE_PX,
    };
    const boxes = zone ? [zone, ...sprites] : sprites;
    if (!boxes.length) return '<span class="gm-empty">No preview</span>';
    const minX = Math.min(...boxes.map((b) => b.left));
    const minY = Math.min(...boxes.map((b) => b.top));
    const width = Math.max(...boxes.map((b) => b.left + b.width)) - minX;
    const height = Math.max(...boxes.map((b) => b.top + b.height)) - minY;
    const scale = Math.min(PREVIEW_W / width, PREVIEW_H / height, 3);
    const place = (b) =>
      `left:${(b.left - minX) * scale}px;top:${(b.top - minY) * scale}px;width:${b.width * scale}px;height:${b.height * scale}px`;
    const imgs = sprites
      .map((s) => `<img alt="" src="${escapeHtml(s.url)}" style="${place(s)}">`)
      .join("");
    const floor = zone ? `<div class="gm-layout-floor" style="${place(zone)}"></div>` : "";
    const outline = zone
      ? `<div class="gm-layout-zone" style="${place(zone)}" title="Desk area"></div>`
      : "";
    return `<div class="gm-layout-preview" style="width:${width * scale}px;height:${height * scale}px">${floor}${imgs}${outline}</div>`;
  }

  let popoverRow = null;
  function hidePopover() {
    popoverRow = null;
    document.getElementById("gather-mods-popover")?.remove();
  }
  function showPopover(row, previewHtml) {
    popoverRow = row;
    let pop = document.getElementById("gather-mods-popover");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "gather-mods-popover";
      document.body.appendChild(pop);
    }
    ctx.applyTheme(pop);
    pop.innerHTML = `<div class="gm-preview">${previewHtml()}</div>`;
    fitImages(pop);
    const rowBox = row.getBoundingClientRect();
    const panelBox = (ctx.panel() ?? row).getBoundingClientRect();
    const top = rowBox.top + rowBox.height / 2 - pop.offsetHeight / 2;
    pop.style.left = panelBox.right + 8 + "px";
    pop.style.top = Math.max(8, Math.min(top, innerHeight - pop.offsetHeight - 8)) + "px";
  }
  // previewHtml() is called on hover; layout previews re-render once the catalog loads.
  function attachPopover(row, previewHtml, needsCatalog) {
    const render = () => {
      if (needsCatalog && !catalogReady() && !catalog.failed)
        ensureCatalog().then(() => {
          if (popoverRow === row) showPopover(row, render);
        });
      return previewHtml();
    };
    row.addEventListener("mouseenter", () => showPopover(row, render));
    row.addEventListener("mouseleave", hidePopover);
  }
  ctx.onCleanup(hidePopover);

  ctx.style(`
    :is(#gather-mods-modal, #gather-mods-popover) .gm-preview { height:${PREVIEW_BOX_H}px; display:flex; align-items:center; justify-content:center; overflow:hidden;
      border-radius:8px; background:var(--gm-input); }
    :is(#gather-mods-modal, #gather-mods-popover) .gm-preview img { image-rendering:pixelated; }
    :is(#gather-mods-modal, #gather-mods-popover) .gm-outfit-crop { position:relative; overflow:hidden; width:${PREVIEW_W}px; height:${PREVIEW_H}px; }
    :is(#gather-mods-modal, #gather-mods-popover) .gm-outfit-img { position:absolute; visibility:hidden; }
    :is(#gather-mods-modal, #gather-mods-popover) .gm-layout-preview { position:relative; flex-shrink:0; }
    :is(#gather-mods-modal, #gather-mods-popover) .gm-layout-preview img { position:absolute; }
    :is(#gather-mods-modal, #gather-mods-popover) .gm-layout-floor { position:absolute; background:var(--gm-surface-hover); }
    :is(#gather-mods-modal, #gather-mods-popover) .gm-layout-zone { position:absolute; box-sizing:border-box; border:1px dashed var(--theme-color-accent,#6c5ce7); pointer-events:none; }
    #gather-mods-popover { position:fixed; z-index:2147483000; width:${PREVIEW_W + 26}px; padding:6px; box-sizing:border-box; pointer-events:none;
      background:var(--gm-bg); border:1px solid var(--gm-border); border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.25); font-family:inherit; }
    #gather-mods-popover .gm-empty { color:var(--gm-muted); font-size:12px; }
  `);

  return {
    OUTFIT_SLOTS,
    ensureCatalog,
    catalogReady,
    onCatalog: (fn) => catalog.listeners.add(fn),
    outfitPreviewHtml,
    layoutPreviewHtml,
    collectSprites,
    fitImages,
    attachPopover,
    hidePopover,
  };
});
