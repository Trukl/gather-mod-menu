// Placements library: journal of the objects created by the mod (constructions,
// desk presets, Place on…), per floor, so they can be deleted later. Objects
// are kept as stable references, so a new version of the map keeps them.
window.__gatherMods.define("placements", (ctx) => {
  const { GD, readJson, writeJson } = ctx;
  const map = ctx.use("map");
  const STORAGE_KEY = "gathermodv2:placementHistory";
  const MAX_ENTRIES = 200;
  const MAX_OBJECTS = 5000;
  const listeners = new Set();

  // Entries from the constructions-only history have no source.
  const getAll = () => readJson(STORAGE_KEY, []).map((e) => ({ source: "construction", ...e }));
  const objectCount = (e) => (e.refs ?? e.ids).length;
  function saveAll(entries) {
    let kept = entries.slice(-MAX_ENTRIES);
    let total = kept.reduce((n, e) => n + objectCount(e), 0);
    while (kept.length > 1 && total > MAX_OBJECTS) {
      total -= objectCount(kept[0]);
      kept = kept.slice(1);
    }
    writeJson(STORAGE_KEY, kept);
    listeners.forEach((fn) => fn());
  }

  // Entries recorded before references existed hold the object ids of one map
  // version; they are converted while that version is the current one.
  function migrateLegacyEntries(all) {
    const mapId = map.currentMapId();
    let changed = false;
    const entries = all.map((e) => {
      if (e.refs || e.mapId !== mapId) return e;
      changed = true;
      const { mapId: _, ids, ...rest } = e;
      return {
        ...rest,
        floorId: map.currentFloorId(),
        refs: map.liveObjects(ids).map(map.objectRef),
      };
    });
    if (changed) saveAll(entries);
    return entries;
  }

  // Ids of the entry's objects still on the map, in creation order.
  const liveIds = (entry) =>
    map
      .resolveRefs(entry.refs)
      .filter(Boolean)
      .map((o) => o.id);

  function record({ source, name, ids }) {
    if (!ids.length) return;
    saveAll([
      ...getAll(),
      {
        source,
        name,
        floorId: map.currentFloorId(),
        at: new Date().toISOString(),
        refs: map.liveObjects(ids).map(map.objectRef),
      },
    ]);
  }

  // Entries of the current floor, newest first; entries whose objects are all gone are dropped.
  function list(source) {
    const floorId = map.currentFloorId();
    const all = migrateLegacyEntries(getAll());
    const here = (e) => e.refs && e.floorId === floorId;
    const gone = all.filter((e) => here(e) && !liveIds(e).length);
    if (gone.length) saveAll(all.filter((e) => !gone.includes(e)));
    return all
      .filter((e) => here(e) && !gone.includes(e) && (!source || e.source === source))
      .reverse();
  }

  // Children first, so deleting a parent never hits an already-deleted child.
  // Entries are dropped by list() once none of their objects is left.
  async function deleteEntries(entries) {
    let deleted = 0;
    try {
      for (const entry of entries)
        for (const id of liveIds(entry).reverse()) {
          const o = GD().Repos.MapObject.get(id);
          if (!map.isLiveObject(o)) continue;
          await o.delete();
          deleted++;
        }
    } finally {
      listeners.forEach((fn) => fn());
    }
    return deleted;
  }

  return {
    record,
    list,
    liveIds,
    deleteEntries,
    onChange: (fn) => listeners.add(fn),
  };
});
