// Placements library: journal of the objects created by the mod (constructions,
// desk presets, Place on…), per map, so they can be deleted later.
window.__gatherMods.define("placements", (ctx) => {
  const { GD, readJson, writeJson } = ctx;
  const map = ctx.use("map");
  const STORAGE_KEY = "gathermodv2:placementHistory";
  const MAX_ENTRIES = 200;
  const MAX_IDS = 5000;
  const listeners = new Set();

  // Entries from the constructions-only history have no source.
  const getAll = () => readJson(STORAGE_KEY, []).map((e) => ({ source: "construction", ...e }));
  function saveAll(entries) {
    let kept = entries.slice(-MAX_ENTRIES);
    let total = kept.reduce((n, e) => n + e.ids.length, 0);
    while (kept.length > 1 && total > MAX_IDS) {
      total -= kept[0].ids.length;
      kept = kept.slice(1);
    }
    writeJson(STORAGE_KEY, kept);
    listeners.forEach((fn) => fn());
  }

  const liveIds = (entry) =>
    entry.ids.filter((id) => map.isLiveObject(GD().Repos.MapObject.get(id)));

  function record({ source, name, ids }) {
    if (!ids.length) return;
    saveAll([
      ...getAll(),
      { source, name, mapId: map.currentMapId(), at: new Date().toISOString(), ids },
    ]);
  }

  // Entries of the current map, newest first; entries whose objects are all gone are dropped.
  function list(source) {
    const all = getAll();
    const gone = all.filter((e) => e.mapId === map.currentMapId() && !liveIds(e).length);
    if (gone.length) saveAll(all.filter((e) => !gone.includes(e)));
    return getAll()
      .filter((e) => e.mapId === map.currentMapId() && (!source || e.source === source))
      .reverse();
  }

  // Children first, so deleting a parent never hits an already-deleted child.
  // Entries are dropped by list() once none of their objects is left.
  async function deleteEntries(entries) {
    let deleted = 0;
    try {
      for (const entry of entries)
        for (const id of [...entry.ids].reverse()) {
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
