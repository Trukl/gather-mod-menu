// Map picking library: one pick session at a time, with pixel-precise hover,
// wheel cycling through stacked objects, click to toggle and drag to box-select.
window.__gatherMods.define("map-pick", (ctx) => {
  const map = ctx.use("map");
  const { TILE_PX } = map;
  const POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"];
  const WHEEL_STEP_PX = 50;
  const MARQUEE_THRESHOLD_PX = 4;
  const HOVER_COLOR = 0xffd400;

  const state = {
    session: null,
    graphics: null,
    hoverGraphics: null,
    hoverId: null,
    hoverFrame: 0,
    lastPointer: null,
    cycleKey: "",
    cycleIndex: 0,
    wheelDelta: 0,
    drag: null,
  };
  const listeners = new Set();

  const spritePixelCache = new Map();
  function spritePixels(url) {
    if (spritePixelCache.has(url)) return spritePixelCache.get(url);
    spritePixelCache.set(url, null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const c2d = canvas.getContext("2d");
        c2d.drawImage(img, 0, 0);
        const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
        spritePixelCache.set(url, { data, width: canvas.width, height: canvas.height });
      } catch (e) {
        console.warn("[GatherMods] sprite pixels unavailable", url, e);
      }
      if (state.session && state.lastPointer) updateHover(state.lastPointer);
    };
    img.src = url;
    return null;
  }
  function isOpaqueAt(o, tileX, tileY) {
    if (o.isVirtual) return o.isOpaqueAt(tileX, tileY);
    const variant = o.catalogItemVariant;
    const pixels = spritePixels(variant.mainRenderableUrl);
    if (!pixels) return true;
    const tl = o.topLeftAbsolutePosition;
    const size = variant.dimensionsInPixels;
    const x = Math.floor(((tileX - tl.x) * TILE_PX * pixels.width) / size.width);
    const y = Math.floor(((tileY - tl.y) * TILE_PX * pixels.height) / size.height);
    if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return false;
    return pixels.data[(y * pixels.width + x) * 4 + 3] > 16;
  }
  function drawOrderPath(o) {
    if (o.isVirtual) return [o.drawY()];
    const path = [];
    for (let cur = o; cur?.mapEntityType === "MapObject"; cur = cur.parent) {
      const variant = cur.catalogItemVariant;
      const fold = variant.mainRenderable?.fold ?? variant.dimensionsInPixels.height;
      path.unshift(cur.topLeftAbsolutePosition.y * TILE_PX + fold);
    }
    return path;
  }
  function compareDrawOrder(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }
  // Sessions with `virtual: true` also pick the mod's virtual objects.
  const pickable = () => [
    ...map.mapObjects(),
    ...(state.session?.virtual ? map.virtualObjects() : []),
  ];
  function objectsAtTile(tileX, tileY) {
    const hits = [];
    for (const o of pickable()) {
      const tl = o.topLeftAbsolutePosition;
      const d = o.getDimensionsInTiles();
      if (
        tileX >= tl.x &&
        tileY >= tl.y &&
        tileX <= tl.x + d.width &&
        tileY <= tl.y + d.height &&
        isOpaqueAt(o, tileX, tileY)
      )
        hits.push({ o, order: drawOrderPath(o) });
    }
    return hits.sort((a, b) => compareDrawOrder(b.order, a.order)).map((h) => h.o);
  }
  function objectsInScreenRect(a, b) {
    const p = map.pointerWorldPoint({ clientX: a.x, clientY: a.y });
    const q = map.pointerWorldPoint(b);
    const x0 = Math.min(p.x, q.x) / TILE_PX;
    const x1 = Math.max(p.x, q.x) / TILE_PX;
    const y0 = Math.min(p.y, q.y) / TILE_PX;
    const y1 = Math.max(p.y, q.y) / TILE_PX;
    return pickable().filter((o) => {
      const tl = o.topLeftAbsolutePosition;
      const d = o.getDimensionsInTiles();
      return tl.x >= x0 && tl.y >= y0 && tl.x + d.width <= x1 && tl.y + d.height <= y1;
    });
  }

  function currentPick(e) {
    const p = map.pointerWorldPoint(e);
    const candidates = objectsAtTile(p.x / TILE_PX, p.y / TILE_PX);
    const choices = state.session?.candidates ? state.session.candidates(candidates) : candidates;
    const key = choices.map((c) => c.id).join(",");
    if (key !== state.cycleKey) {
      state.cycleKey = key;
      state.cycleIndex = 0;
      state.wheelDelta = 0;
    }
    if (!choices.length) return { target: null, index: 0, total: 0 };
    const index = state.cycleIndex % choices.length;
    return { target: choices[index], index, total: choices.length };
  }
  const isRaw = () => !!state.session?.pointerDown;
  const canMarquee = () => !isRaw() && (state.session?.marquee?.() ?? true);

  function onPointer(e) {
    const drag = state.drag;
    if (!map.isOnMap(e) && !(drag && e.type === "pointerup")) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const session = state.session;
    if (isRaw()) {
      if (e.type === "pointerdown") session.pointerDown(e);
      return;
    }
    if (e.type === "pointerdown") {
      if (e.button === 0) state.drag = { x: e.clientX, y: e.clientY, active: false };
      return;
    }
    if (e.type !== "pointerup" || !drag) return;
    state.drag = null;
    if (drag.active) {
      document.getElementById("gather-mods-marquee")?.remove();
      session.onBox?.(objectsInScreenRect(drag, e));
    } else {
      const { target } = currentPick(e);
      if (target) session.onPick?.(target);
    }
    if (state.session) {
      redraw();
      updateHover(e);
    }
  }
  function renderMarquee(drag, e) {
    let box = document.getElementById("gather-mods-marquee");
    if (!box) {
      box = document.createElement("div");
      box.id = "gather-mods-marquee";
      ctx.applyTheme(box);
      document.body.appendChild(box);
      clearHoverHighlight();
    }
    box.classList.toggle("is-danger", !!state.session?.danger);
    Object.assign(box.style, {
      left: Math.min(drag.x, e.clientX) + "px",
      top: Math.min(drag.y, e.clientY) + "px",
      width: Math.abs(e.clientX - drag.x) + "px",
      height: Math.abs(e.clientY - drag.y) + "px",
    });
  }
  function onWheel(e) {
    if (!map.isOnMap(e)) return;
    if (isRaw()) {
      onHover(e);
      return;
    }
    const { total } = currentPick(e);
    if (total < 2) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    state.wheelDelta += e.deltaY;
    const steps = Math.trunc(state.wheelDelta / WHEEL_STEP_PX);
    if (!steps) return;
    state.wheelDelta -= steps * WHEEL_STEP_PX;
    state.cycleIndex = (((state.cycleIndex + steps) % total) + total) % total;
    updateHover(e);
  }
  function onHover(e) {
    const drag = state.drag;
    if (drag && e.buttons & 1 && canMarquee()) {
      if (!drag.active && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < MARQUEE_THRESHOLD_PX)
        return;
      drag.active = true;
      renderMarquee(drag, e);
      return;
    }
    state.lastPointer = e;
    if (state.hoverFrame) return;
    state.hoverFrame = requestAnimationFrame(() => {
      state.hoverFrame = 0;
      updateHover(state.lastPointer);
    });
  }
  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      stop();
    } else if (!e.target.closest?.("input, textarea") && state.session?.onKey?.(e)) {
      e.stopPropagation();
    }
  }

  // Re-themed on every update: the theme can change while it is shown.
  function hoverTip() {
    let tip = document.getElementById("gather-mods-hover-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "gather-mods-hover-tip";
      document.body.appendChild(tip);
    }
    ctx.applyTheme(tip);
    return tip;
  }
  function clearHoverHighlight() {
    document.getElementById("gather-mods-hover-tip")?.remove();
    state.hoverId = null;
    if (!state.hoverGraphics) return;
    state.hoverGraphics.destroy();
    state.hoverGraphics = null;
    map.requestRender();
  }
  // The outline is redrawn (with a forced frame) only when the hovered object
  // changes, otherwise Gather may keep showing the previous one.
  function updateHover(e) {
    const session = state.session;
    if (!session || session.hover) {
      clearHoverHighlight();
      session?.hover(e && map.isOnMap(e) ? e : null);
      return;
    }
    const { target, index, total } = e && map.isOnMap(e) ? currentPick(e) : { target: null };
    if (!target) {
      clearHoverHighlight();
      return;
    }
    if (target.id !== state.hoverId) {
      state.hoverGraphics?.destroy();
      const g = map
        .scene()
        .add.graphics()
        .setDepth(1e9 + 1);
      strokeObjects(g, [target], HOVER_COLOR);
      state.hoverGraphics = g;
      state.hoverId = target.id;
      map.requestRender();
    }
    const tip = hoverTip();
    const name = ctx.escapeHtml(state.session.label?.(target) ?? map.objectName(target));
    tip.innerHTML = `<span class="gm-tip">${name}${total > 1 ? ` <span class="gm-kbd">${index + 1}/${total}</span> scroll to cycle` : ""}</span>`;
    tip.style.left = e.clientX + 14 + "px";
    tip.style.top = e.clientY + 14 + "px";
  }

  function strokeObjects(g, objects, color) {
    g.lineStyle(1, color, 1);
    for (const o of objects) {
      const tl = o.topLeftAbsolutePosition;
      const d = o.getDimensionsInTiles();
      g.strokeRect(tl.x * TILE_PX, tl.y * TILE_PX, d.width * TILE_PX, d.height * TILE_PX);
    }
  }
  // A session outlines objects (outlines) and can draw more on the map (draw).
  function redraw() {
    state.graphics?.destroy();
    state.graphics = null;
    const session = state.session;
    if (!session?.outlines && !session?.draw) return;
    const g = map.scene().add.graphics().setDepth(1e9);
    for (const [objects, color] of session.outlines?.() ?? []) strokeObjects(g, objects, color);
    session.draw?.(g);
    state.graphics = g;
    map.requestRender();
  }

  function setListening(on) {
    const toggle = on ? "addEventListener" : "removeEventListener";
    for (const t of POINTER_EVENTS) window[toggle](t, onPointer, true);
    window[toggle]("pointermove", onHover, true);
    window[toggle]("wheel", onWheel, { capture: true, passive: false });
    document[toggle]("keydown", onKey, true);
  }
  const notify = () => listeners.forEach((fn) => fn(state.session?.id ?? null));

  function start(session) {
    if (state.session) stop();
    state.session = session;
    setListening(true);
    redraw();
    notify();
  }
  function stop(id) {
    const session = state.session;
    if (!session || (id && session.id !== id)) return;
    state.session = null;
    setListening(false);
    cancelAnimationFrame(state.hoverFrame);
    Object.assign(state, { hoverFrame: 0, lastPointer: null, cycleKey: "", drag: null });
    clearHoverHighlight();
    session.hover?.(null);
    document.getElementById("gather-mods-marquee")?.remove();
    state.graphics?.destroy();
    state.graphics = null;
    session.onStop?.();
    map.requestRender();
    notify();
  }

  ctx.onCleanup(() => stop());
  ctx.style(`
    #gather-mods-marquee { position:fixed; z-index:2147482500; pointer-events:none; box-sizing:border-box;
      border:1px dashed var(--gm-accent); background:var(--gm-accent-soft); }
    #gather-mods-marquee.is-danger { border-color:var(--gm-danger); background:var(--gm-danger-soft); }
    #gather-mods-hover-tip { position:fixed; z-index:2147483001; pointer-events:none; white-space:nowrap; }
  `);

  return {
    start,
    stop,
    current: () => state.session?.id ?? null,
    redraw,
    refreshHover: () => state.lastPointer && updateHover(state.lastPointer),
    onChange: (fn) => listeners.add(fn),
  };
});
