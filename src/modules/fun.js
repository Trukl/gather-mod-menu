// Fun: gimmicks. Flee mode keeps you away from a chosen player. Animations
// move objects on the screens of everyone who has this module: they are
// stored on the community hub, their sprites are displaced locally (nothing
// is sent to Gather's server) and the map is redrawn at 30 fps at most.
window.__gatherMods.define("fun", (ctx) => {
  const { MC, me, allUsers, tpTo, escapeHtml, readJson, writeJson, onEnter } = ctx;
  const map = ctx.use("map");
  const pick = ctx.use("map-pick");
  const api = ctx.use("hub-api");
  const { TILE_PX } = map;
  const FLEE_TRIGGER_TILES = 2;
  const FLEE_HOP_TILES = 2;
  const FLEE_POLL_MS = 300;
  let fleeTargetId = null;
  // A core older than 1.2.0 (update not installed yet) has no hideable parts.
  const showFlee = !ctx.isPartHidden?.("flee");
  const showAnimations = !ctx.isPartHidden?.("animations");

  function fleeStep() {
    if (!fleeTargetId) return;
    const self = me();
    const target = allUsers().find((u) => u.id === fleeTargetId);
    if (!target || !target.connected || target.floorId !== self.floorId) return;
    let dx = self.x - target.x;
    let dy = self.y - target.y;
    if (Math.hypot(dx, dy) > FLEE_TRIGGER_TILES) return;
    if (dx === 0 && dy === 0) {
      dx = self.x % 2 ? 1 : -1;
      dy = self.y % 2 ? 1 : -1;
    }
    const len = Math.hypot(dx, dy);
    let x = Math.round(self.x + (dx / len) * FLEE_HOP_TILES);
    let y = Math.round(self.y + (dy / len) * FLEE_HOP_TILES);
    try {
      const Position = self.originalPosition.constructor;
      const free = MC().getNearestFreeTile(new Position(x, y, self.floorId));
      if (typeof free?.x === "number") ({ x, y } = free);
    } catch {}
    tpTo(x, y, self.floorId);
  }
  if (showFlee) {
    const fleeTimer = setInterval(() => {
      try {
        fleeStep();
      } catch {}
    }, FLEE_POLL_MS);
    ctx.onCleanup(() => clearInterval(fleeTimer));
  }

  function renderPlayers(root) {
    const list = root.querySelector("#gm-flee-players");
    const search = root.querySelector("#gm-flee-search").value.toLowerCase();
    const myId = me().id;
    const players = allUsers().filter(
      (p) =>
        p.id !== myId && p.connected && !p.isBot && (p.name || "").toLowerCase().includes(search),
    );
    const html = players.length
      ? players
          .map(
            (p) =>
              `<div class="gm-item${fleeTargetId === p.id ? " active" : ""}" data-pid="${escapeHtml(p.id)}" title="Flee from this player"><span class="gm-name">${escapeHtml((p.name || "?").slice(0, 24))}</span><span>🏃</span></div>`,
          )
          .join("")
      : '<div class="gm-empty">No players</div>';
    if (list.__html === html) return;
    list.__html = html;
    list.innerHTML = html;
    list.querySelectorAll(".gm-item").forEach((row) => {
      row.onclick = () => {
        fleeTargetId = fleeTargetId === row.dataset.pid ? null : row.dataset.pid;
        renderPlayers(root);
      };
    });
  }

  // ===================
  // Animations
  // ===================
  const LEGACY_TOKENS_KEY = "gathermodv2:animationTokens";
  const SYNC_MS = 60_000;
  // The hub's storage can serve a stale list for about a minute after a change.
  const LOCAL_EDIT_MS = 90_000;
  const FRAME_MS = 1000 / 30;
  const DEPTH_PER_PX = 1 / 9999;
  const COLOR_SELECTED = 0x00e5ff;
  const MAX_NAME = 40;
  const TYPES = {
    orbit: { label: "Orbit", point: "center" },
    line: { label: "Back and forth", point: "end point" },
    wave: { label: "Wave", point: "end point" },
  };
  const DEFAULT_PARAMS = { period: 4, direction: 1, amplitude: 1, waves: 2 };

  // Shared animations of the current floor, as last fetched from the hub, with
  // this user's recent changes applied on top until the hub reflects them.
  const shared = { floorId: null, fetched: [], items: [], clockOffset: 0, syncedAt: 0, status: "" };
  const localEdits = new Map();
  let draft = null;
  const animationsPath = (id = "") => `/animations/${shared.floorId}${id ? "/" + id : ""}`;
  // Where each saved animation is on the current map version: its objects,
  // found through their stable references, and its point moved by as much as
  // they moved (a new map version can shift everything).
  const resolved = new Map();
  function resolveAll() {
    resolved.clear();
    for (const a of shared.items) {
      const found = map.resolveRefs(a.objects);
      const pairs = a.objects.map((r, i) => [r, found[i]]).filter(([, o]) => o);
      const shift = pairs.reduce(
        (s, [r, o]) => ({
          x: s.x + (o.absolutePosition.x - r.x) / pairs.length,
          y: s.y + (o.absolutePosition.y - r.y) / pairs.length,
        }),
        { x: 0, y: 0 },
      );
      resolved.set(a.id, {
        ids: pairs.map(([, o]) => o.id),
        point: { x: a.point.x + shift.x * TILE_PX, y: a.point.y + shift.y * TILE_PX },
      });
    }
  }
  const placementOf = (a) =>
    a === draft ? { ids: draft.ids, point: draft.point } : resolved.get(a.id);

  const anchorOf = (o) => ({
    x: o.absolutePosition.x * TILE_PX,
    y: o.absolutePosition.y * TILE_PX,
  });
  function withDescendants(ids) {
    const out = new Map();
    const walk = (o) => {
      if (!map.isLiveObject(o) || out.has(o.id)) return;
      out.set(o.id, o);
      o.children.forEach(walk);
    };
    map.liveObjects(ids).forEach(walk);
    return [...out.values()];
  }
  function groupCenter(objects) {
    const anchors = objects.map(anchorOf);
    return {
      x: anchors.reduce((s, p) => s + p.x, 0) / anchors.length,
      y: anchors.reduce((s, p) => s + p.y, 0) / anchors.length,
    };
  }

  // Line and wave go to the end point and back with an eased speed.
  function displacement(a, point, anchor, center, t) {
    const phase = t / a.params.period;
    if (a.type === "orbit") {
      const angle = a.params.direction * phase * 2 * Math.PI;
      const rx = anchor.x - point.x;
      const ry = anchor.y - point.y;
      return {
        x: rx * Math.cos(angle) - ry * Math.sin(angle) - rx,
        y: rx * Math.sin(angle) + ry * Math.cos(angle) - ry,
      };
    }
    const s = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
    const dx = a.point.x - center.x;
    const dy = a.point.y - center.y;
    if (a.type === "line") return { x: dx * s, y: dy * s };
    const len = Math.hypot(dx, dy) || 1;
    const wave = a.params.amplitude * TILE_PX * Math.sin(2 * Math.PI * a.params.waves * s);
    return { x: dx * s - (dy / len) * wave, y: dy * s + (dx / len) * wave };
  }

  // Gather draws each map object as a zone named after its id; we offset it
  // from where Gather put it and put it back when the animation stops.
  let zoneIndex = new Map();
  const displaced = new Map();
  function zoneOf(id) {
    let z = zoneIndex.get(id);
    if (z?.scene) return z;
    zoneIndex = new Map(
      map
        .scene()
        .children.list.filter((c) => c.type === "Zone" && c.name)
        .map((c) => [c.name, c]),
    );
    z = zoneIndex.get(id);
    return z?.scene ? z : null;
  }
  const restingPosition = (o) => ({
    x: o.absolutePosition.x * TILE_PX - o.catalogItemVariant.originX,
    y: o.absolutePosition.y * TILE_PX - o.catalogItemVariant.originY,
  });
  function displace(o, d) {
    let entry = displaced.get(o.id);
    if (!entry) {
      const zone = zoneOf(o.id);
      if (!zone) return;
      const rest = restingPosition(o);
      entry = { zone, dx: zone.x - rest.x, dy: zone.y - rest.y, depth: zone.depth };
      displaced.set(o.id, entry);
    }
    const rest = restingPosition(o);
    entry.zone.setPosition(rest.x + entry.dx + d.x, rest.y + entry.dy + d.y);
    entry.zone.setDepth(entry.depth + d.y * DEPTH_PER_PX);
  }
  function release(id) {
    const entry = displaced.get(id);
    displaced.delete(id);
    const o = ctx.GD().Repos.MapObject.get(id);
    if (!entry?.zone.scene || !map.isLiveObject(o)) return;
    const rest = restingPosition(o);
    entry.zone.setPosition(rest.x + entry.dx, rest.y + entry.dy);
    entry.zone.setDepth(entry.depth);
  }

  const isPreviewing = () => draft?.ids.length && draft.point && pick.current() !== "anim-select";
  const activeAnimations = () => [
    ...shared.items.filter((a) => a.running),
    ...(isPreviewing() ? [draft] : []),
  ];
  const elapsedSeconds = (a) =>
    (Date.now() + (a === draft ? 0 : shared.clockOffset) - a.startedAt) / 1000;

  function releaseAll() {
    if (!displaced.size) return;
    [...displaced.keys()].forEach(release);
    map.requestRender();
  }

  let frame = 0;
  let lastFrame = 0;
  function animate(now) {
    frame = 0;
    if (now - lastFrame < FRAME_MS - 1) {
      frame = requestAnimationFrame(animate);
      return;
    }
    lastFrame = now;
    const animations = activeAnimations();
    if (!animations.length) return releaseAll();
    frame = requestAnimationFrame(animate);
    const moved = new Set();
    for (const a of animations) {
      const t = elapsedSeconds(a);
      const { ids, point } = placementOf(a) ?? { ids: [] };
      const objects = withDescendants(ids);
      if (!objects.length) continue;
      const center = groupCenter(map.liveObjects(ids));
      for (const o of objects) {
        if (moved.has(o.id)) continue;
        moved.add(o.id);
        displace(o, displacement(a, point, anchorOf(o), center, t));
      }
    }
    for (const id of [...displaced.keys()]) if (!moved.has(id)) release(id);
    map.requestRender();
  }
  const refreshAnimations = () => {
    if (!frame) frame = requestAnimationFrame(animate);
  };
  ctx.onCleanup(() => {
    cancelAnimationFrame(frame);
    releaseAll();
  });

  const selectSession = {
    id: "anim-select",
    outlines: () => [[map.liveObjects(draft?.ids ?? []), COLOR_SELECTED]],
    onPick(o) {
      draft.ids = map.toggleId(draft.ids, o.id);
      renderEditor();
    },
    onBox(objects) {
      draft.ids = map.toggleIds(draft.ids, objects);
      renderEditor();
    },
  };
  const pointSession = {
    id: "anim-point",
    pointerDown(e) {
      const p = map.pointerWorldPoint(e);
      draft.point = { x: p.x, y: p.y };
      draft.startedAt = Date.now();
      pick.stop("anim-point");
    },
    hover() {},
  };

  function startDraft() {
    draft = { ids: [], type: "orbit", point: null, params: { ...DEFAULT_PARAMS }, startedAt: 0 };
    pick.start(selectSession);
    renderEditor();
  }
  function closeDraft() {
    draft = null;
    if (pick.current()?.startsWith("anim-")) pick.stop();
    renderEditor();
  }

  function merge() {
    const now = Date.now();
    const items = new Map(shared.fetched.map((a) => [a.id, a]));
    for (const [id, edit] of localEdits) {
      if (now - edit.at > LOCAL_EDIT_MS) localEdits.delete(id);
      else if (edit.item) items.set(id, edit.item);
      else items.delete(id);
    }
    shared.items = [...items.values()];
    resolveAll();
    renderAnimations();
    refreshAnimations();
  }
  const editLocally = (id, item) => {
    localEdits.set(id, { item, at: Date.now() });
    merge();
  };
  function setStatus(text) {
    shared.status = text;
    renderAnimations();
  }
  // Animations created before sign-in are handed to the Gather account when
  // their floor is visited, since their tokens were stored without it.
  async function claimLegacyAnimations(floorId, items) {
    const tokens = readJson(LEGACY_TOKENS_KEY, {});
    const claims = items
      .filter((a) => !a.mine && tokens[a.id])
      .map((a) => ({ floorId, id: a.id, token: tokens[a.id] }));
    if (!claims.length) return items;
    const { claimed } = await api.claim({ animations: claims });
    claims.forEach((c) => delete tokens[c.id]);
    if (Object.keys(tokens).length) writeJson(LEGACY_TOKENS_KEY, tokens);
    else localStorage.removeItem(LEGACY_TOKENS_KEY);
    return items.map((a) => (claimed.includes(a.id) ? { ...a, mine: true } : a));
  }
  // Animations saved per map version with object ids are moved to the floor,
  // with stable references, while that version is the current one.
  async function migrateLegacyAnimations(mapId, legacy) {
    const items = legacy.map((a) => ({
      id: a.id,
      objects: map.liveObjects(a.ids).map(map.objectRef),
    }));
    return api.request(animationsPath("migrate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapId, items: items.filter((i) => i.objects.length) }),
    });
  }
  async function sync() {
    const floorId = map.currentFloorId();
    const mapId = map.currentMapId();
    if (floorId !== shared.floorId) {
      Object.assign(shared, { floorId, fetched: [] });
      localEdits.clear();
      merge();
    }
    shared.syncedAt = Date.now();
    try {
      const sentAt = Date.now();
      const listed = await api.request(`${animationsPath()}?map=${mapId}`);
      if (floorId !== shared.floorId) return;
      shared.clockOffset = listed.now - (sentAt + Date.now()) / 2;
      const { items } = listed.legacy
        ? await migrateLegacyAnimations(mapId, listed.legacy)
        : listed;
      shared.fetched = await claimLegacyAnimations(floorId, items);
      if (shared.status.startsWith("Hub")) shared.status = "";
    } catch (e) {
      shared.status = "Hub unreachable: " + e.message;
    }
    merge();
  }

  async function saveDraft(name) {
    if (!draft?.ids.length || !draft.point) return false;
    const data = {
      name: (name || TYPES[draft.type].label).slice(0, MAX_NAME),
      type: draft.type,
      objects: map.liveObjects(draft.ids).map(map.objectRef),
      point: draft.point,
      params: { ...draft.params },
    };
    setStatus(`Saving "${data.name}"…`);
    try {
      const { animation } = await api.request(animationsPath(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: me().name, data }),
      });
      closeDraft();
      shared.status = "";
      editLocally(animation.id, animation);
      return true;
    } catch (e) {
      setStatus("Save failed: " + e.message);
      return false;
    }
  }
  async function setRunning(a, running) {
    const startedAt = running ? Date.now() + shared.clockOffset : a.startedAt;
    editLocally(a.id, { ...a, running, startedAt });
    try {
      const { animation } = await api.request(animationsPath(a.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ running }),
      });
      editLocally(a.id, animation);
    } catch (e) {
      localEdits.delete(a.id);
      setStatus(`Could not ${running ? "start" : "stop"} "${a.name}": ${e.message}`);
      merge();
    }
  }
  async function deleteAnimation(a) {
    editLocally(a.id, null);
    try {
      await api.request(animationsPath(a.id), { method: "DELETE" });
    } catch (e) {
      localEdits.delete(a.id);
      setStatus(`Could not delete "${a.name}": ${e.message}`);
      merge();
    }
  }

  let root = null;
  function renderEditor() {
    if (!root?.isConnected) return;
    const $ = (sel) => root.querySelector(sel);
    $("#gm-anim-new").textContent = draft ? "Cancel new animation" : "New animation…";
    $("#gm-anim-new").classList.toggle("active", !!draft);
    $("#gm-anim-editor").style.display = draft ? "" : "none";
    if (draft) {
      const mode = pick.current();
      const point = TYPES[draft.type].point;
      $("#gm-anim-status").textContent =
        mode === "anim-select"
          ? `${draft.ids.length} selected, click or drag on the map`
          : mode === "anim-point"
            ? `Click the ${point} on the map (Esc to cancel)`
            : !draft.ids.length
              ? "No object selected"
              : !draft.point
                ? `Pick the ${point} on the map`
                : "Preview running: adjust, then save";
      $("#gm-anim-select").textContent =
        mode === "anim-select" ? "Done" : `Edit selection (${draft.ids.length})`;
      $("#gm-anim-point").textContent =
        `${draft.point ? "Change" : "Pick"} the ${point} on the map`;
      $("#gm-anim-point").classList.toggle("active", mode === "anim-point");
      root.querySelectorAll("[data-anim-for]").forEach((el) => {
        el.style.display = el.dataset.animFor === draft.type ? "" : "none";
      });
      $("#gm-anim-save").disabled = !draft.ids.length || !draft.point;
    }
    refreshAnimations();
  }
  // Everyone's animations play, but only yours are listed: you can't act on the others.
  function renderAnimations() {
    if (!root?.isConnected) return;
    const list = root.querySelector("#gm-anims");
    const own = shared.items.filter((a) => a.mine);
    list.innerHTML = own.length
      ? own
          .map(
            (a) =>
              `<div class="gm-item${a.running ? " active" : ""}" data-id="${escapeHtml(a.id)}" title="${a.running ? "Click to stop it for everyone" : "Click to start it for everyone"}"><span class="gm-name">${a.running ? "⏸" : "▶"} ${escapeHtml(a.name)}</span><span class="gm-actions"><span class="gm-anim-type">${escapeHtml(TYPES[a.type]?.label ?? a.type)}</span><span class="gm-del" data-del="${escapeHtml(a.id)}" title="Delete this animation for everyone">✕</span></span></div>`,
          )
          .join("")
      : '<div class="gm-empty">You have no animations on this map</div>';
    root.querySelector("#gm-anims-status").textContent = shared.status;
    const find = (id) => shared.items.find((a) => a.id === id);
    list.querySelectorAll(".gm-item").forEach((el) => {
      el.onclick = () => {
        const a = find(el.dataset.id);
        if (a) setRunning(a, !a.running);
      };
    });
    list.querySelectorAll(".gm-del").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        const a = find(d.dataset.del);
        if (a) deleteAnimation(a);
      };
    });
  }

  function mountAnimations(el) {
    const $ = (sel) => el.querySelector(sel);
    $("#gm-anim-new").onclick = () => (draft ? closeDraft() : startDraft());
    $("#gm-anim-select").onclick = () =>
      pick.current() === "anim-select" ? pick.stop("anim-select") : pick.start(selectSession);
    $("#gm-anim-point").onclick = () =>
      pick.current() === "anim-point" ? pick.stop("anim-point") : pick.start(pointSession);
    $("#gm-anim-type").onchange = (e) => {
      draft.type = e.target.value;
      draft.point = null;
      renderEditor();
    };
    const numbers = {
      period: "#gm-anim-period",
      amplitude: "#gm-anim-amplitude",
      waves: "#gm-anim-waves",
    };
    for (const [key, sel] of Object.entries(numbers))
      $(sel).addEventListener("input", (e) => {
        const value = Number(e.target.value);
        if (draft && Number.isFinite(value) && value > 0) draft.params[key] = value;
      });
    $("#gm-anim-direction").onchange = (e) => (draft.params.direction = Number(e.target.value));
    el.querySelectorAll("#gm-anim-editor input, #gm-anim-editor select").forEach((input) =>
      input.addEventListener("keydown", (e) => e.stopPropagation()),
    );
    const name = $("#gm-anim-name");
    const save = async () => {
      if (await saveDraft(name.value.trim())) name.value = "";
    };
    onEnter(name, save);
    $("#gm-anim-save").onclick = save;
    renderEditor();
    renderAnimations();
  }
  pick.onChange(() => renderEditor());

  ctx.section({
    title: "Fun",
    parts: [
      { id: "flee", label: "Flee mode" },
      { id: "animations", label: "Animations" },
    ],
    html: `
      <div data-part="flee">
        <div class="gm-sublabel">Flee mode: click a player to keep your distance (click again to stop)</div>
        <input class="gm-input" id="gm-flee-search" placeholder="Search player..." />
        <div class="gm-list" id="gm-flee-players"></div>
      </div>
      <div data-part="animations">
      <div class="gm-sublabel">Your animations, seen by everyone with this module: click one to start or stop it</div>
      <button class="gm-btn" id="gm-anim-new" title="Select objects (click, or drag a box), choose the movement, pick a point on the map, then save. Esc to stop picking.">New animation…</button>
      <div id="gm-anim-editor" style="display:none">
        <div class="gm-status"><span id="gm-anim-status"></span><span class="gm-link" id="gm-anim-select"></span></div>
        <select class="gm-input" id="gm-anim-type">
          <option value="orbit">Orbit around a point</option>
          <option value="line">Back and forth in a straight line</option>
          <option value="wave">Back and forth along a wave</option>
        </select>
        <button class="gm-btn" id="gm-anim-point"></button>
        <label class="gm-anim-param">Seconds per loop<input class="gm-input" id="gm-anim-period" type="number" min="0.5" step="0.5" value="${DEFAULT_PARAMS.period}" /></label>
        <label class="gm-anim-param" data-anim-for="orbit">Direction<select class="gm-input" id="gm-anim-direction"><option value="1">Clockwise</option><option value="-1">Counter-clockwise</option></select></label>
        <label class="gm-anim-param" data-anim-for="wave">Wave height (tiles)<input class="gm-input" id="gm-anim-amplitude" type="number" min="0.25" step="0.25" value="${DEFAULT_PARAMS.amplitude}" /></label>
        <label class="gm-anim-param" data-anim-for="wave">Waves<input class="gm-input" id="gm-anim-waves" type="number" min="0.5" step="0.5" value="${DEFAULT_PARAMS.waves}" /></label>
        <div class="gm-row">
          <input class="gm-input" id="gm-anim-name" placeholder="Name this animation..." />
          <button class="gm-btn" id="gm-anim-save">Save</button>
        </div>
      </div>
      <div class="gm-list" id="gm-anims"></div>
      <div class="gm-status"><span id="gm-anims-status"></span></div>
      </div>`,
    mount(el) {
      root = el;
      const search = el.querySelector("#gm-flee-search");
      search.addEventListener("keydown", (e) => e.stopPropagation());
      search.addEventListener("input", () => renderPlayers(el));
      renderPlayers(el);
      mountAnimations(el);
    },
  });
  ctx.style(`
    #gather-mods-panel .gm-anim-param { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; color:var(--gm-muted); }
    #gather-mods-panel .gm-anim-param .gm-input { width:110px; flex:none; }
    #gather-mods-panel .gm-anim-type { font-size:11px; color:var(--gm-muted); }
    #gather-mods-panel .gm-item.active .gm-anim-type { color:inherit; }
  `);
  ctx.onTick(() => {
    if (showFlee && root?.isConnected) renderPlayers(root);
    if (!showAnimations) return;
    const due = Date.now() - shared.syncedAt > SYNC_MS;
    if (map.currentFloorId() !== shared.floorId || (due && !document.hidden)) sync();
    else resolveAll();
  });
  if (showAnimations) sync();
});
