// Map library: object helpers, snapshots and screen/world geometry shared by
// the build, desks and constructions modules.
window.__gatherMods.define("map", (ctx) => {
  const TILE_PX = 32;
  const { GD } = ctx;

  const scene = () => GD().PhaserManager.scene;
  const currentMapId = () => GD().Repos.gameSpace.currentMap.baseArea.mapId;
  const isLiveObject = (e) => e?.mapEntityType === "MapObject" && !e.isSoftDeleted;
  const liveObjects = (ids) => ids.map((id) => GD().Repos.MapObject.get(id)).filter(isLiveObject);
  const objectName = (o) => o.catalogItemVariant?.catalogItem?.type || "?";
  const mapObjects = () => {
    const mapId = currentMapId();
    return GD().Repos.MapObject.filter((m) => m.mapId === mapId && isLiveObject(m));
  };
  const toggleId = (ids, id) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const toggleIds = (ids, objects) => objects.reduce((acc, o) => toggleId(acc, o.id), ids);

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
  function requestRender() {
    try {
      scene().game.loop.tick();
    } catch {}
  }

  return {
    TILE_PX,
    scene,
    currentMapId,
    isLiveObject,
    liveObjects,
    cleanItem,
    objectName,
    mapObjects,
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
  };
});
