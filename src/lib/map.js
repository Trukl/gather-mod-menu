// Map library: object helpers, snapshots, stable object references and
// screen/world geometry shared by the modules that work on the map.
window.__gatherMods.define("map", (ctx) => {
  const TILE_PX = 32;
  const { GD } = ctx;

  const scene = () => GD().PhaserManager.scene;
  const currentMapId = () => GD().Repos.gameSpace.currentMap.baseArea.mapId;
  const currentFloorId = () => GD().Repos.gameSpace.currentMap.floorId;
  // Virtual objects: drawn by a module (Custom objects), not by Gather. They
  // have ids "custom:<id>", the geometry of a map object (absolutePosition,
  // topLeftAbsolutePosition, getDimensionsInTiles, children) and their own
  // `ref`, `isOpaqueAt`, `drawY`, `displace`, `release` and `delete`.
  let virtualSource = null;
  function registerVirtualObjects(source) {
    virtualSource = source;
    return () => {
      if (virtualSource === source) virtualSource = null;
    };
  }
  const virtualObjects = () => virtualSource?.list() ?? [];
  const virtualObject = (id) => virtualSource?.get(id) ?? null;
  const isVirtualId = (id) => typeof id === "string" && id.startsWith("custom:");
  const isLiveObject = (e) =>
    e?.isVirtual
      ? virtualObject(e.id) !== null
      : e?.mapEntityType === "MapObject" && !e.isSoftDeleted;
  const liveObjects = (ids) =>
    ids
      .map((id) => (isVirtualId(id) ? virtualObject(id) : GD().Repos.MapObject.get(id)))
      .filter(isLiveObject);
  const objectName = (o) => (o.isVirtual ? o.name : o.catalogItemVariant?.catalogItem?.type || "?");
  const mapObjects = () => {
    const mapId = currentMapId();
    return GD().Repos.MapObject.filter((m) => m.mapId === mapId && isLiveObject(m));
  };
  const toggleId = (ids, id) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const toggleIds = (ids, objects) => objects.reduce((acc, o) => toggleId(acc, o.id), ids);

  // Publishing a new version of a map (Gather's map editor) recreates every
  // object with a new id but keeps its hashIdentifier, as long as it stays on
  // the same floor. A reference also keeps the type and position, to find an
  // object Gather recreated otherwise.
  const REF_POSITION_EPSILON = 0.05;
  const objectRef = (o) =>
    o.isVirtual
      ? o.ref
      : {
          hash: o.hashIdentifier,
          variant: o.catalogItemVariantId,
          x: o.absolutePosition.x,
          y: o.absolutePosition.y,
        };
  // Objects of the current map for each reference (null when not found).
  // Found objects are cached per map: callers resolve on every render.
  // A virtual object's reference ({ custom, x, y }) is found by its id.
  let refCache = { mapId: null, ids: new Map() };
  function resolveRefs(refs) {
    const mapId = currentMapId();
    if (refCache.mapId !== mapId) refCache = { mapId, ids: new Map() };
    const cached = (r) => {
      if (r.custom) return virtualObject("custom:" + r.custom);
      const o = GD().Repos.MapObject.get(refCache.ids.get(r.hash));
      return isLiveObject(o) ? o : null;
    };
    const found = refs.map(cached);
    if (found.every((o, i) => o || refs[i].custom)) return found;
    const objects = mapObjects();
    const byHash = new Map(objects.map((o) => [o.hashIdentifier, o]));
    const used = new Set(found.filter(Boolean).map((o) => o.id));
    const samePlace = (c, r) =>
      !used.has(c.id) &&
      c.catalogItemVariantId === r.variant &&
      Math.abs(c.absolutePosition.x - r.x) <= REF_POSITION_EPSILON &&
      Math.abs(c.absolutePosition.y - r.y) <= REF_POSITION_EPSILON;
    refs.forEach((r, i) => {
      if (found[i] || r.custom) return;
      found[i] = byHash.get(r.hash) ?? null;
      if (found[i]) used.add(found[i].id);
    });
    refs.forEach((r, i) => {
      if (r.custom) return;
      found[i] ??= objects.find((c) => samePlace(c, r)) ?? null;
      if (!found[i]) return;
      used.add(found[i].id);
      refCache.ids.set(r.hash, found[i].id);
    });
    return found;
  }
  // A new version of the map can shift every coordinate (Gather trims the map
  // to its content). What the mod places on the map keeps references to
  // objects spread over it; the map moved by what most of those still there
  // agree on, so a deleted or individually moved object doesn't count.
  const ANCHOR_SPOTS = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.5, 0.5],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  function mapAnchors() {
    const objects = mapObjects();
    const xs = objects.map((o) => o.absolutePosition.x);
    const ys = objects.map((o) => o.absolutePosition.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const picked = new Set();
    for (const [fx, fy] of ANCHOR_SPOTS) {
      const x = x0 + fx * (x1 - x0);
      const y = y0 + fy * (y1 - y0);
      let nearest = null;
      let best = Infinity;
      for (const o of objects) {
        const d = (o.absolutePosition.x - x) ** 2 + (o.absolutePosition.y - y) ** 2;
        if (d < best && !picked.has(o)) [nearest, best] = [o, d];
      }
      if (nearest) picked.add(nearest);
    }
    return [...picked].map(objectRef);
  }
  // In tiles, on the 1/8 grid images are placed on; null when none is found.
  function mapShift(anchors) {
    const votes = new Map();
    resolveRefs(anchors).forEach((o, i) => {
      if (!o) return;
      const x = Math.round((o.absolutePosition.x - anchors[i].x) * 8) / 8;
      const y = Math.round((o.absolutePosition.y - anchors[i].y) * 8) / 8;
      const key = `${x},${y}`;
      votes.set(key, { x, y, n: (votes.get(key)?.n ?? 0) + 1 });
    });
    let shift = null;
    for (const v of votes.values()) if (!shift || v.n > shift.n) shift = v;
    return shift && { x: shift.x, y: shift.y };
  }

  function topLevelObjects(objects) {
    const ids = new Set(objects.map((o) => o.id));
    return objects.filter((o) => {
      for (let p = o.parent; p; p = p.parent) if (ids.has(p.id)) return false;
      return true;
    });
  }

  function snapshotObject(o, x, y) {
    return {
      variant: o.catalogItemVariantId,
      name: objectName(o),
      x,
      y,
      children: o.children
        .filter(isLiveObject)
        .map((c) => snapshotObject(c, c.relativeX, c.relativeY)),
    };
  }

  // Validates an imported/hub layout item (variant + position + children).
  function cleanItem(i) {
    if (
      typeof i?.variant !== "string" ||
      !Number.isFinite(i.x) ||
      !Number.isFinite(i.y) ||
      !Array.isArray(i.children)
    )
      return null;
    const children = i.children.map(cleanItem);
    if (children.includes(null)) return null;
    return {
      variant: i.variant,
      name: typeof i.name === "string" ? i.name : "?",
      x: i.x,
      y: i.y,
      children,
    };
  }

  async function createObject(item, parent, createdIds = []) {
    const R = GD().Repos;
    const id = await R.MapObject.createNewMapObject({
      mapId: parent.mapId,
      parent: parent.asAnyMapEntityTypedId(),
      catalogItemVariantId: item.variant,
      relativeX: item.x,
      relativeY: item.y,
    });
    createdIds.push(id);
    const created = R.MapObject.get(id);
    for (const child of item.children) await createObject(child, created, createdIds);
    return created;
  }

  // Smallest area containing the point, like Gather does when dropping an object.
  function areaAt(x, y) {
    const base = GD().Repos.gameSpace.currentMap.baseArea;
    let best = base;
    let bestSize = Infinity;
    for (const a of GD().Repos.MapArea.filter((m) => m.mapId === base.mapId && !m.isSoftDeleted)) {
      const p = a.absolutePosition;
      const d = a.dimensionsInTiles;
      if (!d) continue;
      const size = d.width * d.height;
      if (size < bestSize && x >= p.x && y >= p.y && x < p.x + d.width && y < p.y + d.height) {
        best = a;
        bestSize = size;
      }
    }
    return best;
  }

  function pointerWorldPoint(e) {
    const canvas = scene().game.canvas;
    const r = canvas.getBoundingClientRect();
    return scene().cameras.main.getWorldPoint(
      ((e.clientX - r.left) * canvas.width) / r.width,
      ((e.clientY - r.top) * canvas.height) / r.height,
    );
  }
  function tileToScreen(tileX, tileY) {
    const canvas = scene().game.canvas;
    const r = canvas.getBoundingClientRect();
    const cam = scene().cameras.main;
    const scale = (cam.zoom * r.width) / canvas.width;
    return {
      x: r.left + (tileX * TILE_PX - cam.worldView.x) * scale,
      y: r.top + (tileY * TILE_PX - cam.worldView.y) * scale,
      scale,
    };
  }
  const isOnMap = (e) => scene().game.canvas.parentElement.contains(e.target);
  // Gather only renders when the scene changes; draw one frame after updating
  // overlays from outside the map (panel buttons, list hover).
  let forcedFrame = false;
  function requestRender() {
    forcedFrame = true;
    try {
      scene().game.loop.tick();
    } catch {}
    forcedFrame = false;
  }
  // Animations share one loop. While objects move, Gather draws on its own (30
  // fps, 7 without the focus): animations update right after its frames, so
  // nothing is drawn twice. Otherwise a timer draws them at the same rates, and
  // not at all while hidden or minimized. A timer, unlike
  // requestAnimationFrame, doesn't make Chrome redraw the whole page each time.
  const animations = new Set();
  let animationTimer = 0;
  let lastAnimationFrame = 0;
  let afterGatherFrame = 0;
  let gatherDrew = false;
  function runAnimations() {
    let changed = false;
    for (const step of animations) changed = step() || changed;
    return changed;
  }
  function onGatherFrame() {
    if (forcedFrame || !animations.size) return;
    gatherDrew = true;
    afterGatherFrame ||= setTimeout(() => {
      afterGatherFrame = 0;
      runAnimations();
    });
  }
  function scheduleAnimationFrame() {
    if (animationTimer || document.hidden || !animations.size) return;
    const frameMs = document.hasFocus() ? 1000 / 30 : 1000 / 7;
    animationTimer = setTimeout(animationFrame, lastAnimationFrame + frameMs - performance.now());
  }
  function animationFrame() {
    animationTimer = 0;
    if (document.hidden) return;
    lastAnimationFrame = performance.now();
    scheduleAnimationFrame();
    if (gatherDrew) gatherDrew = false;
    else if (runAnimations()) requestRender();
  }
  // step() runs on every frame and returns whether it changed the map; the
  // returned function stops it.
  function animate(step) {
    animations.add(step);
    scheduleAnimationFrame();
    return () => animations.delete(step);
  }
  scene().game.events.on("postrender", onGatherFrame);
  document.addEventListener("visibilitychange", scheduleAnimationFrame);
  ctx.onCleanup(() => {
    clearTimeout(animationTimer);
    clearTimeout(afterGatherFrame);
    scene().game.events.off("postrender", onGatherFrame);
    document.removeEventListener("visibilitychange", scheduleAnimationFrame);
  });

  return {
    TILE_PX,
    scene,
    currentMapId,
    currentFloorId,
    objectRef,
    resolveRefs,
    mapAnchors,
    mapShift,
    isLiveObject,
    liveObjects,
    cleanItem,
    objectName,
    mapObjects,
    registerVirtualObjects,
    virtualObjects,
    toggleId,
    toggleIds,
    topLevelObjects,
    snapshotObject,
    createObject,
    areaAt,
    pointerWorldPoint,
    tileToScreen,
    isOnMap,
    requestRender,
    animate,
  };
});
