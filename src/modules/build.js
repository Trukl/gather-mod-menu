// Build: free placement in the build tool, "Place on…" and bulk delete.
window.__gatherMods.define("build", (ctx) => {
  const { GD } = ctx;
  const map = ctx.use("map");
  const pick = ctx.use("map-pick");
  const placements = ctx.use("placements");
  const jobs = ctx.use("jobs");
  const FREE_PLACEMENT_KEY = "gathermodv2:freePlacement";
  const COLOR_SELECTED = 0x00e5ff;
  const COLOR_SUPPORT = 0x2ecc71;
  const COLOR_DELETE = 0xff3b30;
  let freePlacement =
    !ctx.isPartHidden?.("free") && localStorage.getItem(FREE_PLACEMENT_KEY) === "true";

  // The build tool snaps objects with collisions/seats to tiles; when free
  // placement is ON nothing snaps unless the native snap key (Cmd) is held.
  // Moves are sent with dontValidatePosition, so the server keeps the position.
  const snapOwner = (() => {
    for (let p = GD().Repos.MapObject.Model.prototype; p; p = Object.getPrototypeOf(p))
      if (Object.getOwnPropertyDescriptor(p, "isSnappedToGrid")?.get) return p;
    return null;
  })();
  if (snapOwner) {
    const desc = Object.getOwnPropertyDescriptor(snapOwner, "isSnappedToGrid");
    Object.defineProperty(snapOwner, "isSnappedToGrid", {
      ...desc,
      get() {
        return freePlacement ? false : desc.get.call(this);
      },
    });
    ctx.onCleanup(() => Object.defineProperty(snapOwner, "isSnappedToGrid", desc));
  }

  // Place on — recreate objects as children of any object (Gather's UI only
  // allows tables/shelves; the server accepts any parent on creation).
  // Children render right after their parent, i.e. in front of it.
  const place = { step: "objects", selected: [], supportId: null, status: "" };
  const bulk = { selected: [], status: "" };

  const placeSession = {
    id: "place",
    marquee: () => place.step === "objects",
    candidates: (list) =>
      place.step === "support" ? list.filter((o) => !place.selected.includes(o.id)) : list,
    outlines: () => [
      [map.liveObjects(place.selected), COLOR_SELECTED],
      [map.liveObjects(place.supportId ? [place.supportId] : []), COLOR_SUPPORT],
    ],
    onPick(target) {
      if (place.step === "support") place.supportId = target.id;
      else place.selected = map.toggleId(place.selected, target.id);
      render();
    },
    onBox(objects) {
      place.selected = map.toggleIds(place.selected, objects);
      render();
    },
    onKey(e) {
      if (e.key !== "Enter") return false;
      advancePlaceOn();
      return true;
    },
    onStop() {
      Object.assign(place, { step: "objects", selected: [], supportId: null });
    },
  };

  function advancePlaceOn() {
    if (place.step === "objects") {
      if (!place.selected.length) return;
      place.step = "support";
      place.status = "";
      pick.redraw();
      render();
      return;
    }
    const support = place.supportId && GD().Repos.MapObject.get(place.supportId);
    if (map.isLiveObject(support)) placeSelectedOn(support);
  }

  function placeSelectedOn(support) {
    const objects = map
      .topLevelObjects(map.liveObjects(place.selected))
      .filter((o) => o.id !== support.id && !support.isChildOf(o));
    pick.stop("place");
    jobs.run("place-on", async () => {
      let placed = 0;
      const createdIds = [];
      try {
        for (const o of objects) {
          if (!map.isLiveObject(o)) continue;
          const item = map.snapshotObject(
            o,
            o.absolutePosition.x - support.absolutePosition.x,
            o.absolutePosition.y - support.absolutePosition.y,
          );
          const created = await map.createObject(item, support, createdIds);
          ctx.use("desks")?.replaceTrackedObject(o, created);
          await o.delete();
          placed++;
        }
        place.status = `Placed ${placed} on ${map.objectName(support)}`;
      } catch (e) {
        console.error("[GatherMods] place on failed", e);
        place.status = `Failed after ${placed}: ${e?.message || e}`;
      } finally {
        placements.record({
          source: "place on",
          name: `${placed} on ${map.objectName(support)}`,
          ids: createdIds,
        });
      }
    });
  }

  // Linked objects — what sits on what (Place on…, Gather's tables and
  // shelves): supports in green, objects on them in cyan, each joined to its
  // support. Clicking an object shows only its group; clicking it again, all.
  const links = { focusId: null };
  const supportOf = (o) => (map.isLiveObject(o.parent) ? o.parent : null);
  function rootOf(o) {
    let root = o;
    while (supportOf(root)) root = supportOf(root);
    return root;
  }
  function objectsOn(support) {
    const out = [];
    const walk = (o) =>
      o.children.filter(map.isLiveObject).forEach((c) => {
        out.push(c);
        walk(c);
      });
    walk(support);
    return out;
  }
  function linkedObjects() {
    const focus = links.focusId && GD().Repos.MapObject.get(links.focusId);
    return map.isLiveObject(focus)
      ? objectsOn(rootOf(focus))
      : map.mapObjects().filter((o) => supportOf(o));
  }
  const supportsOf = (objects) => [...new Set(objects.map(supportOf))];
  function centerOf(o) {
    const tl = o.topLeftAbsolutePosition;
    const d = o.getDimensionsInTiles();
    return { x: (tl.x + d.width / 2) * map.TILE_PX, y: (tl.y + d.height / 2) * map.TILE_PX };
  }
  const linksSession = {
    id: "links",
    marquee: () => false,
    outlines() {
      const objects = linkedObjects();
      return [
        [supportsOf(objects), COLOR_SUPPORT],
        [objects, COLOR_SELECTED],
      ];
    },
    draw(g) {
      g.lineStyle(2, COLOR_SUPPORT, 1);
      for (const o of linkedObjects()) {
        const a = centerOf(o);
        const b = centerOf(supportOf(o));
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
    },
    label(o) {
      const support = supportOf(o);
      const count = o.children.filter(map.isLiveObject).length;
      return [
        map.objectName(o),
        support && `on ${map.objectName(support)}`,
        count && `${count} on it`,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    onPick(o) {
      links.focusId = links.focusId === o.id ? null : o.id;
      render();
    },
    onStop() {
      links.focusId = null;
    },
  };
  function linksStatus() {
    const objects = linkedObjects();
    const focus = links.focusId && GD().Repos.MapObject.get(links.focusId);
    if (map.isLiveObject(focus)) {
      const root = rootOf(focus);
      return objects.length
        ? `${map.objectName(root)}: ${objects.length} object${objects.length > 1 ? "s" : ""} on it, click it again to see all`
        : `Nothing sits on ${map.objectName(root)}, click it again to see all`;
    }
    if (!objects.length) return "Nothing sits on another object on this map";
    const supports = supportsOf(objects).length;
    return `${objects.length} object${objects.length > 1 ? "s" : ""} on ${supports} support${supports > 1 ? "s" : ""}: click one to see only its group`;
  }

  // Bulk delete — deleting an object also deletes what sits on it. Custom
  // objects are picked and deleted too.
  const bulkSession = {
    id: "bulk-delete",
    danger: true,
    virtual: true,
    outlines: () => [[map.liveObjects(bulk.selected), COLOR_DELETE]],
    onPick(target) {
      bulk.selected = map.toggleId(bulk.selected, target.id);
      render();
    },
    onBox(objects) {
      bulk.selected = map.toggleIds(bulk.selected, objects);
      render();
    },
    onStop() {
      bulk.selected = [];
    },
  };

  function deleteBulkSelection() {
    const selected = map.liveObjects(bulk.selected);
    if (!selected.length) return;
    pick.stop("bulk-delete");
    jobs.run("bulk-delete", async () => {
      let deleted = 0;
      try {
        for (const o of map.topLevelObjects(selected)) {
          if (map.isLiveObject(o)) await o.delete();
          deleted++;
        }
        bulk.status = `Deleted ${selected.length} objects`;
      } catch (e) {
        console.error("[GatherMods] bulk delete failed", e);
        bulk.status = `Failed after ${deleted}: ${e?.message || e}`;
      }
    });
  }

  let root = null;
  function render() {
    if (!root?.isConnected) return;
    const $ = (sel) => root.querySelector(sel);
    // A note shows while it has text or a visible link.
    const showNote = (sel, text, links) => {
      const status = $(sel);
      status.textContent = text;
      for (const [link, shown] of links) link.style.display = shown ? "" : "none";
      status.closest(".gm-note").style.display =
        text || links.some(([, shown]) => shown) ? "" : "none";
    };
    $("#gm-free-placement").checked = freePlacement;

    const placing = pick.current() === "place";
    $("#gm-place-on").classList.toggle("is-on", placing);
    const action = $("#gm-place-action");
    const support = place.supportId && GD().Repos.MapObject.get(place.supportId);
    let placeText;
    if (placing && place.step === "objects") {
      placeText = `${place.selected.length} selected, click or drag on the map`;
      action.textContent = "Next: pick support";
    } else if (placing) {
      placeText = support
        ? `Support: ${map.objectName(support)}`
        : "Click the object to put them on";
      action.textContent = "Place here";
    } else {
      placeText = jobs.busy("place-on") ? "Placing…" + jobs.queuedSuffix("place-on") : place.status;
    }
    showNote("#gm-place-status", placeText, [
      [action, placing && (place.step === "objects" ? place.selected.length : support)],
      [$("#gm-place-cancel"), placing],
    ]);

    const showingLinks = pick.current() === "links";
    $("#gm-links").classList.toggle("is-on", showingLinks);
    showNote("#gm-links-status", showingLinks ? linksStatus() : "", [
      [$("#gm-links-cancel"), showingLinks],
    ]);

    const deleting = pick.current() === "bulk-delete";
    const count = deleting ? map.liveObjects(bulk.selected).length : 0;
    $("#gm-bulk-delete").classList.toggle("is-on", deleting);
    $("#gm-bulk-action").textContent = `Delete ${count}`;
    showNote(
      "#gm-bulk-status",
      deleting
        ? `${count} selected, click or drag on the map${jobs.queuedSuffix("bulk-delete")}`
        : jobs.busy("bulk-delete")
          ? "Deleting…" + jobs.queuedSuffix("bulk-delete")
          : bulk.status,
      [
        [$("#gm-bulk-action"), deleting && count],
        [$("#gm-bulk-cancel"), deleting],
      ],
    );
  }
  pick.onChange(render);
  jobs.onChange(render);

  const TOOL_STATUS = { place: "Place on", links: "Links", "bulk-delete": "Bulk delete" };
  ctx.section({
    title: "Build",
    parts: [
      { id: "free", label: "Free placement" },
      { id: "place-on", label: "Place on…" },
      { id: "bulk-delete", label: "Bulk delete" },
    ],
    status: () => TOOL_STATUS[pick.current()] ?? (freePlacement ? "On" : null),
    html: `
      <label class="gm-toggle" data-part="free" title="Build tool: objects no longer snap to tiles. Hold Cmd to snap.">
        <span class="gm-toggle-text"><span class="gm-toggle-title">Free placement</span><span class="gm-hint">Nothing snaps to tiles · hold ⌘ to snap</span></span>
        <input type="checkbox" class="gm-switch" id="gm-free-placement" />
      </label>
      <div data-part="place-on">
        <button class="gm-btn gm-block" id="gm-place-on" title="Select objects (click, or drag a box), then the object to put them on (works on any object). Esc to cancel."><i class="gm-i" data-i="layers"></i>Place on…</button>
        <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span class="gm-build-msg"><span id="gm-place-status"></span><span class="gm-link" id="gm-place-action"></span><span class="gm-link" id="gm-place-cancel">Cancel</span></span></div>
        <button class="gm-btn gm-block" id="gm-links" title="Outline what sits on what (Place on…, tables, shelves): supports in green, objects on them in cyan. Click an object to see only its group. Esc to close."><i class="gm-i" data-i="link-2"></i>Show linked objects</button>
        <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span class="gm-build-msg"><span id="gm-links-status"></span><span class="gm-link" id="gm-links-cancel">Hide</span></span></div>
      </div>
      <div data-part="bulk-delete">
        <button class="gm-btn gm-block" id="gm-bulk-delete" title="Select objects (click, or drag a box), then delete them all. Esc to cancel."><i class="gm-i" data-i="trash-2"></i>Bulk delete…</button>
        <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span class="gm-build-msg"><span id="gm-bulk-status"></span><span class="gm-link gm-danger" id="gm-bulk-action"></span><span class="gm-link" id="gm-bulk-cancel">Cancel</span></span></div>
      </div>`,
    mount(el) {
      root = el;
      el.querySelector("#gm-free-placement").onchange = (e) => {
        freePlacement = e.target.checked;
        localStorage.setItem(FREE_PLACEMENT_KEY, freePlacement);
        render();
      };
      el.querySelector("#gm-place-on").onclick = () =>
        pick.current() === "place" ? pick.stop("place") : pick.start(placeSession);
      el.querySelector("#gm-place-action").onclick = advancePlaceOn;
      el.querySelector("#gm-place-cancel").onclick = () => pick.stop("place");
      el.querySelector("#gm-links").onclick = () =>
        pick.current() === "links" ? pick.stop("links") : pick.start(linksSession);
      el.querySelector("#gm-links-cancel").onclick = () => pick.stop("links");
      el.querySelector("#gm-bulk-delete").onclick = () =>
        pick.current() === "bulk-delete" ? pick.stop("bulk-delete") : pick.start(bulkSession);
      el.querySelector("#gm-bulk-action").onclick = deleteBulkSelection;
      el.querySelector("#gm-bulk-cancel").onclick = () => pick.stop("bulk-delete");
      render();
    },
  });
  ctx.style(`
    #gather-mods-panel .gm-build-msg { display:flex; flex-wrap:wrap; column-gap:6px; }
    #gather-mods-panel .gm-build-msg > :empty { display:none; }
  `);

  return { freePlacement: () => freePlacement };
});
