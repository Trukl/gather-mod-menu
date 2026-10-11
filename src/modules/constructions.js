// Constructions: a saved group of objects (with whatever sits on them), placed
// anywhere in one click. Placements go to the shared placements journal. Item
// positions are relative to the tile-aligned top-left of the group, so
// grid-aligned objects stay aligned.
window.__gatherMods.define("constructions", (ctx) => {
  const { escapeHtml, readJson, writeJson, onEnter, flash } = ctx;
  const map = ctx.use("map");
  const pick = ctx.use("map-pick");
  const previews = ctx.use("previews");
  const placements = ctx.use("placements");
  const jobs = ctx.use("jobs");
  const { TILE_PX } = map;
  const CONSTRUCTIONS_KEY = "gathermodv2:constructions";
  const COLOR_SELECTED = 0x00e5ff;
  const state = { selected: [], stampIndex: null, status: "" };

  const getConstructions = () => readJson(CONSTRUCTIONS_KEY, []);
  const saveConstructions = (l) => writeJson(CONSTRUCTIONS_KEY, l);
  const stamped = () => (state.stampIndex === null ? null : getConstructions()[state.stampIndex]);

  function snapshotConstruction(name, objects) {
    const top = map.topLevelObjects(objects);
    const originX = Math.floor(Math.min(...top.map((o) => o.absolutePosition.x)));
    const originY = Math.floor(Math.min(...top.map((o) => o.absolutePosition.y)));
    return {
      name,
      items: top.map((o) =>
        map.snapshotObject(o, o.absolutePosition.x - originX, o.absolutePosition.y - originY),
      ),
    };
  }

  const selectSession = {
    id: "construct",
    outlines: () => [[map.liveObjects(state.selected), COLOR_SELECTED]],
    onPick(o) {
      state.selected = map.toggleId(state.selected, o.id);
      render();
    },
    onBox(objects) {
      state.selected = map.toggleIds(state.selected, objects);
      render();
    },
    onStop() {
      state.selected = [];
    },
  };

  // The ghost follows the pointer, centered on the construction; it snaps to
  // tiles unless free placement (build module) is ON and Cmd is not held.
  function stampOrigin(e, sprites) {
    const p = map.pointerWorldPoint(e);
    let x = p.x / TILE_PX - 0.5;
    let y = p.y / TILE_PX - 0.5;
    if (sprites.length) {
      const left = Math.min(...sprites.map((s) => s.left));
      const right = Math.max(...sprites.map((s) => s.left + s.width));
      const top = Math.min(...sprites.map((s) => s.top));
      const bottom = Math.max(...sprites.map((s) => s.top + s.height));
      x = (p.x - (left + right) / 2) / TILE_PX;
      y = (p.y - (top + bottom) / 2) / TILE_PX;
    }
    const free = ctx.use("build")?.freePlacement() ?? false;
    return !free || e.metaKey ? { x: Math.round(x), y: Math.round(y) } : { x, y };
  }
  function renderGhost(e) {
    const construction = stamped();
    let ghost = document.getElementById("gather-mods-ghost");
    if (!construction || !e) {
      ghost?.remove();
      return;
    }
    const sprites = previews.collectSprites(construction.items);
    const key = `${state.stampIndex}:${sprites.length}`;
    if (ghost?.dataset.key !== key) {
      ghost?.remove();
      ghost = document.createElement("div");
      ghost.id = "gather-mods-ghost";
      ghost.dataset.key = key;
      ghost.innerHTML = sprites
        .map(
          (s) =>
            `<img alt="" src="${escapeHtml(s.url)}" style="left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px">`,
        )
        .join("");
      document.body.appendChild(ghost);
    }
    const origin = stampOrigin(e, sprites);
    const screen = map.tileToScreen(origin.x, origin.y);
    ghost.style.transform = `translate(${screen.x}px, ${screen.y}px) scale(${screen.scale})`;
  }
  const stampSession = {
    id: "stamp",
    pointerDown: (e) => stampConstruction(e),
    hover: renderGhost,
    onStop() {
      state.stampIndex = null;
      document.getElementById("gather-mods-ghost")?.remove();
    },
  };

  function startStamp(i) {
    if (pick.current() === "stamp" && state.stampIndex === i) return pick.stop("stamp");
    pick.start(stampSession);
    state.stampIndex = i;
    if (!jobs.busy("constructions")) state.status = "";
    render();
    previews.ensureCatalog().then(() => pick.current() === "stamp" && pick.refreshHover());
  }

  function stampConstruction(e) {
    const construction = stamped();
    if (!construction) return;
    const origin = stampOrigin(e, previews.collectSprites(construction.items));
    pick.stop("stamp");
    jobs.run("constructions", async () => {
      state.status = `Placing "${construction.name}"…`;
      render();
      const createdIds = [];
      try {
        for (const item of construction.items) {
          const x = origin.x + item.x;
          const y = origin.y + item.y;
          const parent = map.areaAt(x, y);
          await map.createObject(
            { ...item, x: x - parent.absolutePosition.x, y: y - parent.absolutePosition.y },
            parent,
            createdIds,
          );
        }
        state.status = `Placed "${construction.name}"`;
      } catch (err) {
        console.error("[GatherMods] construction placement failed", err);
        state.status = `Failed after ${createdIds.length} objects: ${err?.message || err}`;
      } finally {
        placements.record({ source: "construction", name: construction.name, ids: createdIds });
      }
    });
  }

  // The last placement is looked up when the job runs, after the ones queued before it.
  function deleteLastPlacement() {
    jobs.run("constructions", async () => {
      const [last] = placements.list("construction");
      if (!last) return;
      state.status = `Removing "${last.name}"…`;
      render();
      try {
        await placements.deleteEntries([last]);
        state.status = `Removed "${last.name}"`;
      } catch (err) {
        console.error("[GatherMods] delete placement failed", err);
        state.status = "Delete failed: " + (err?.message || err);
      }
    });
  }

  function cleanItems(p) {
    if (typeof p?.name !== "string" || !Array.isArray(p.items)) return null;
    const items = p.items.map(map.cleanItem);
    return items.includes(null) ? null : { name: p.name, items };
  }

  let root = null;
  function render() {
    if (!root?.isConnected) return;
    const $ = (sel) => root.querySelector(sel);
    const selecting = pick.current() === "construct";
    $("#gm-construct-new").textContent = selecting ? "Cancel new construction" : "New construction";
    $("#gm-construct-new").classList.toggle("active", selecting);
    $("#gm-construct-save-row").style.display = selecting ? "" : "none";
    const current = pick.current() === "stamp" && stamped();
    $("#gm-construct-status").textContent = selecting
      ? `${state.selected.length} selected, click or drag on the map`
      : current
        ? `Click on the map to place "${current.name}" (Esc to cancel)${jobs.queuedSuffix("constructions")}`
        : jobs.busy("constructions")
          ? state.status + jobs.queuedSuffix("constructions")
          : state.status;
    root.querySelectorAll("#gm-constructions .gm-item").forEach((row) => {
      row.classList.toggle(
        "active",
        pick.current() === "stamp" && +row.dataset.idx === state.stampIndex,
      );
    });
    const undo = $("#gm-construct-undo");
    const [last] = placements.list("construction");
    undo.style.display = last ? "" : "none";
    if (last) {
      undo.textContent = `↶ Delete last: "${last.name}"`;
      undo.title = "Delete the objects of the last construction you placed on this map";
    }
  }

  function renderList() {
    if (!root?.isConnected) return;
    const list = root.querySelector("#gm-constructions");
    const hub = ctx.use("hub");
    const summary = (p) => escapeHtml(p.items.map((i) => i.name).join(", "));
    previews.hidePopover();
    list.innerHTML =
      getConstructions()
        .map(
          (p, i) =>
            `<div class="gm-item" data-idx="${i}" title="${summary(p)}"><span class="gm-name">${escapeHtml(p.name)}</span><span class="gm-actions">${hub ? `<span class="gm-pub" data-pub="${i}" title="Publish to the community hub">⇪</span>` : ""}<span class="gm-del" data-del="${i}">✕</span></span></div>`,
        )
        .join("") || '<div class="gm-empty">No saved constructions</div>';
    list.querySelectorAll(".gm-item").forEach((row) => {
      previews.attachPopover(
        row,
        () => {
          const preset = getConstructions()[+row.dataset.idx];
          return preset ? previews.layoutPreviewHtml(preset.items, null) : "";
        },
        true,
      );
      row.onclick = () => startStamp(+row.dataset.idx);
    });
    list.querySelectorAll(".gm-del").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        pick.stop("stamp");
        const l = getConstructions();
        l.splice(+d.dataset.del, 1);
        saveConstructions(l);
        renderList();
      };
    });
    list.querySelectorAll(".gm-pub").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        hub?.publish("construction", getConstructions()[+b.dataset.pub]);
      };
    });
    render();
  }

  ctx.registerPresetType({
    type: "construction",
    key: "constructions",
    label: "Constructions",
    list: getConstructions,
    save: saveConstructions,
    clean: cleanItems,
    preview: (p) => previews.layoutPreviewHtml(p.items, null),
    needsCatalog: true,
    onChange: renderList,
  });

  pick.onChange(render);
  jobs.onChange(render);
  placements.onChange(render);
  ctx.section({
    title: "Constructions",
    html: `
      <button class="gm-btn" id="gm-construct-new" title="Click objects, or drag a box around them, to select them (objects on them come along), then name and save. Esc to cancel.">New construction</button>
      <div class="gm-row" id="gm-construct-save-row">
        <input class="gm-input" id="gm-construct-name" placeholder="Name this construction..." />
        <button class="gm-btn" id="gm-construct-save">Save</button>
      </div>
      <div class="gm-status"><span id="gm-construct-status"></span></div>
      <button class="gm-btn" id="gm-construct-undo"></button>
      <div class="gm-list" id="gm-constructions"></div>`,
    mount(el) {
      root = el;
      el.querySelector("#gm-construct-new").onclick = () =>
        pick.current() === "construct" ? pick.stop("construct") : pick.start(selectSession);
      el.querySelector("#gm-construct-undo").onclick = deleteLastPlacement;
      const input = el.querySelector("#gm-construct-name");
      const saveBtn = el.querySelector("#gm-construct-save");
      const save = () => {
        const name = input.value.trim();
        if (!name) return;
        const objects = map.liveObjects(state.selected);
        if (!objects.length) return flash(saveBtn, "No objects");
        saveConstructions([...getConstructions(), snapshotConstruction(name, objects)]);
        state.status = `Saved "${name}"`;
        input.value = "";
        pick.stop("construct");
        renderList();
      };
      onEnter(input, save);
      saveBtn.onclick = save;
      renderList();
    },
  });
  ctx.style(`
    #gather-mods-ghost { position:fixed; left:0; top:0; z-index:2147482000; pointer-events:none; transform-origin:0 0; opacity:.6; }
    #gather-mods-ghost img { position:absolute; image-rendering:pixelated; }
  `);
});
