// Teleport: teleport mode, TP to desk, TP to players and saved locations.
window.__gatherMods.define("teleport", (ctx) => {
  const { MC, me, allUsers, tpTo, escapeHtml, readJson, writeJson, onEnter, flash } = ctx;
  const map = ctx.use("map");
  const LOCATIONS_KEY = "gathermodv2:locations";
  let tpMode = !ctx.isPartHidden?.("mode");

  // Teleport mode overrides the native "teleport vs walk" decision, so every
  // setPathMoveTo navigation (double-click, all "Go to" buttons) teleports.
  const mc = MC();
  const originalShouldTeleport = mc.shouldTeleport;
  mc.shouldTeleport = function (...args) {
    return tpMode ? true : originalShouldTeleport.apply(this, args);
  };
  ctx.onCleanup(() => {
    mc.shouldTeleport = originalShouldTeleport;
  });

  // moveSpaceUserToDesk() fills MoveController.moveRoute with the path to the
  // seat; teleport to its last tile instead of walking.
  function tpToDesk() {
    try {
      mc.moveSpaceUserToDesk();
      const route = mc.moveRoute;
      if (route?.length) {
        const dest = route[route.length - 1];
        tpTo(dest.x, dest.y);
        return true;
      }
    } catch {}
    return false;
  }

  const getLocations = () => readJson(LOCATIONS_KEY, []);

  function renderPlayers(root) {
    const list = root.querySelector("#gm-players");
    const search = root.querySelector("#gm-player-search").value.toLowerCase();
    const myId = me().id;
    const players = allUsers().filter(
      (p) =>
        p.id !== myId && p.connected && !p.isBot && (p.name || "").toLowerCase().includes(search),
    );
    const html = players.length
      ? players
          .map(
            (p) =>
              `<div class="gm-item" data-pid="${escapeHtml(p.id)}"><span class="gm-name">${escapeHtml((p.name || "?").slice(0, 24))}</span></div>`,
          )
          .join("")
      : '<div class="gm-empty">No players</div>';
    if (list.__html === html) return;
    list.__html = html;
    list.innerHTML = html;
    list.querySelectorAll(".gm-item").forEach((row) => {
      row.onclick = () => {
        const p = allUsers().find((u) => u.id === row.dataset.pid);
        if (p) tpTo(p.x, p.y, p.floorId);
      };
    });
  }

  function renderLocations(root) {
    const list = root.querySelector("#gm-locations");
    const locations = getLocations();
    list.innerHTML = locations.length
      ? locations
          .map(
            (loc, i) =>
              `<div class="gm-item" data-idx="${i}" title="(${loc.x}, ${loc.y})"><span class="gm-name">${escapeHtml(loc.name)}</span><span class="gm-del" data-del="${i}">✕</span></div>`,
          )
          .join("")
      : '<div class="gm-empty">No saved locations</div>';
    list.querySelectorAll(".gm-item").forEach((row) => {
      row.onclick = () => {
        const loc = getLocations()[+row.dataset.idx];
        if (!loc) return;
        const { x, y, floorId } = locationTarget(loc);
        tpTo(x, y, floorId);
      };
    });
    list.querySelectorAll(".gm-del").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        const l = getLocations();
        l.splice(+d.dataset.del, 1);
        writeJson(LOCATIONS_KEY, l);
        renderLocations(root);
      };
    });
  }

  // Publishing a new version of the map can shift every coordinate (Gather
  // trims the map to its content): a location keeps the nearest object as an
  // anchor and follows it. Locations saved before anchors existed don't move.
  function nearestRef(x, y) {
    let nearest = null;
    let best = Infinity;
    for (const o of map.mapObjects()) {
      const d = (o.absolutePosition.x - x) ** 2 + (o.absolutePosition.y - y) ** 2;
      if (d < best) [nearest, best] = [o, d];
    }
    return nearest && map.objectRef(nearest);
  }
  function locationTarget(loc) {
    if (!loc.anchor || loc.floorId !== map.currentFloorId()) return loc;
    const [anchor] = map.resolveRefs([loc.anchor]);
    if (!anchor) return loc;
    return {
      ...loc,
      x: Math.round(loc.x + anchor.absolutePosition.x - loc.anchor.x),
      y: Math.round(loc.y + anchor.absolutePosition.y - loc.anchor.y),
    };
  }

  let root = null;
  ctx.section({
    title: "Teleport",
    parts: [
      { id: "mode", label: "Teleport mode" },
      { id: "desk", label: "TP to my desk" },
      { id: "players", label: "Players" },
      { id: "locations", label: "Saved locations" },
    ],
    html: `
      <button class="gm-btn" id="gm-tp-mode" data-part="mode">Teleport mode: OFF</button>
      <button class="gm-btn" id="gm-tp-desk" data-part="desk">TP to my desk</button>
      <div data-part="players">
        <div class="gm-sublabel">Players</div>
        <input class="gm-input" id="gm-player-search" placeholder="Search player..." />
        <div class="gm-list" id="gm-players"></div>
      </div>
      <div data-part="locations">
        <div class="gm-sublabel">Saved locations</div>
        <div class="gm-row">
          <input class="gm-input" id="gm-loc-name" placeholder="Name this spot..." />
          <button class="gm-btn" id="gm-loc-save">Save</button>
        </div>
        <div class="gm-list" id="gm-locations"></div>
      </div>`,
    mount(el) {
      root = el;
      const tpBtn = el.querySelector("#gm-tp-mode");
      const syncTpBtn = () => {
        tpBtn.textContent = "Teleport mode: " + (tpMode ? "ON" : "OFF");
        tpBtn.classList.toggle("active", tpMode);
      };
      tpBtn.onclick = () => {
        tpMode = !tpMode;
        syncTpBtn();
      };
      syncTpBtn();
      const deskBtn = el.querySelector("#gm-tp-desk");
      deskBtn.onclick = () => {
        if (!tpToDesk()) flash(deskBtn, "No desk assigned");
      };
      const search = el.querySelector("#gm-player-search");
      search.addEventListener("keydown", (e) => e.stopPropagation());
      search.addEventListener("input", () => renderPlayers(el));
      const nameInput = el.querySelector("#gm-loc-name");
      const save = () => {
        const name = nameInput.value.trim();
        if (!name) return;
        const u = me();
        writeJson(LOCATIONS_KEY, [
          ...getLocations(),
          { name, x: u.x, y: u.y, floorId: u.floorId, anchor: nearestRef(u.x, u.y) },
        ]);
        nameInput.value = "";
        renderLocations(el);
      };
      onEnter(nameInput, save);
      el.querySelector("#gm-loc-save").onclick = save;
      renderPlayers(el);
      renderLocations(el);
    },
  });
  ctx.onTick(() => root?.isConnected && renderPlayers(root));
});
