// Fun: gimmicks. Flee mode keeps you away from a chosen player. Animations
// move objects on the screens of everyone who has this module: they are
// stored on the community hub, their sprites are displaced locally (nothing
// is sent to Gather's server) and the map is redrawn at 30 fps at most.
window.__gatherMods.define("fun", (ctx) => {
  const { MC, me, allUsers, tpTo, escapeHtml, readJson, writeJson, onEnter, applyTheme } = ctx;
  const map = ctx.use("map");
  const motion = ctx.use("motion");
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

  const initials = (name) =>
    (name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => [...w][0])
      .join("")
      .toUpperCase() || "?";
  const avatarColor = (id) => {
    let hue = 0;
    for (const c of String(id)) hue = (hue * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${hue} 55% 55%)`;
  };
  function playerRow(p) {
    const on = fleeTargetId === p.id;
    const name = (p.name || "?").slice(0, 24);
    const button = `<button class="gm-iconbtn${on ? " on" : ""}" title="${on ? "Stop fleeing" : "Flee from them"}"><i class="gm-i" data-i="footprints"></i></button>`;
    return `<div class="gm-item${on ? " is-on" : ""}" data-pid="${escapeHtml(p.id)}" title="${on ? "Stop fleeing" : "Flee from this player"}"><span class="gm-avatar" style="background:${avatarColor(p.id)}">${escapeHtml(initials(name))}</span><div class="gm-item-text"><span class="gm-item-title">${escapeHtml(name)}</span></div>${on ? `<span class="gm-tail gm-fun-fleeing">Fleeing</span>${button}` : `<div class="gm-actions">${button}</div>`}</div>`;
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
      ? players.map(playerRow).join("")
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
  const STUDIO_POSITION_KEY = "gathermodv2:animationStudio";
  // Others' animations hidden on this screen, by id.
  const HIDDEN_ANIMATIONS_KEY = "gathermodv2:hiddenAnimations";
  const SYNC_MS = 60_000;
  // A sync started before a change can still return the old list.
  const LOCAL_EDIT_MS = 90_000;
  const FRAME_MS = 1000 / 30;
  const DEPTH_PER_PX = 1 / 9999;
  const COLOR_SELECTED = 0x00e5ff;
  const COLOR_PATH = 0x00e5ff;
  const COLOR_HANDLE = 0x6c5ce7;
  const COLOR_HANDLE_SELECTED = 0xffd400;
  // Under map-pick's outlines (1e9).
  const OVERLAY_DEPTH = 1e9 - 10;
  const HANDLE_RADIUS_PX = 9;
  const MAX_NAME = 40;
  const MAX_STEPS = 20;
  const LEGACY_LABELS = { orbit: "Orbit", line: "Back and forth", wave: "Wave" };
  const SHAPE_LABELS = { line: "Line", wave: "Wave", arc: "Arc", orbit: "Orbit", custom: "Custom" };
  // What a step saves besides shape, easing, duration, pause and rotate.
  const SHAPE_FIELDS = {
    line: ["to"],
    wave: ["to", "amplitude", "waves", "invert"],
    arc: ["to", "bend"],
    orbit: ["center", "turns", "direction"],
    custom: ["to", "x", "y"],
  };
  const ORDERS = {
    selection: "In selection order",
    "left-right": "Left to right",
    "top-bottom": "Top to bottom",
    random: "Random",
  };

  // Shared animations of the current floor, as last fetched from the hub, with
  // this user's recent changes applied on top until the hub reflects them.
  const shared = { floorId: null, fetched: [], items: [], clockOffset: 0, syncedAt: 0, status: "" };
  const localEdits = new Map();
  const hiddenIds = new Set(readJson(HIDDEN_ANIMATIONS_KEY, []));
  // The animation open in the studio, always as a path: its objects (ids),
  // movement, selected step and preview clock (paused at `time`, or running
  // since `startedAt`).
  let draft = null;
  const animationsPath = (id = "") => `/animations/${shared.floorId}${id ? "/" + id : ""}`;
  // Where each saved animation is on the current map version: its objects,
  // found through their stable references, and for the first animation types
  // their point, moved by as much as they moved (a new map version can shift
  // everything). Paths are offsets from the objects: they follow them.
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
        point: a.point && { x: a.point.x + shift.x * TILE_PX, y: a.point.y + shift.y * TILE_PX },
      });
    }
  }
  const placementOf = (a) => (a === draft ? { ids: draft.ids } : resolved.get(a.id));

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

  const builtPaths = new WeakMap();
  function builtOf(a) {
    if (a === draft) return (draft.built ??= motion.build(draft));
    if (!builtPaths.has(a)) builtPaths.set(a, motion.build(a));
    return builtPaths.get(a);
  }
  // In a path, every selected object moves and turns with what sits on it.
  function groupsOf(roots) {
    return roots.map((o) => {
      const members = withDescendants([o.id]);
      return { members, pivot: anchorOf(o), anchors: members.map(anchorOf) };
    });
  }
  // Every object an animation moves, with its offset (and turn) at time t.
  function framesOf(a, roots, t) {
    if (a.type !== "path") {
      const center = groupCenter(roots);
      const { point } = placementOf(a);
      return withDescendants(roots.map((o) => o.id)).map((o) => [
        o,
        displacement(a, point, anchorOf(o), center, t),
      ]);
    }
    const groups = groupsOf(roots);
    const frames = motion.framesAt(a, builtOf(a), groups, t);
    return groups.flatMap((g, i) => g.members.map((o, j) => [o, frames[i][j]]));
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
  // Virtual objects (Custom objects) move themselves. Gather draws an object
  // with sprites anchored on its position: turning them turns it in place.
  function displace(o, d) {
    const angle = d.angle ?? 0;
    if (o.isVirtual) {
      o.displace(d.x, d.y, angle);
      displaced.set(o.id, { virtual: o });
      return;
    }
    let entry = displaced.get(o.id);
    if (!entry) {
      const zone = zoneOf(o.id);
      if (!zone) return;
      const rest = restingPosition(o);
      entry = {
        zone,
        dx: zone.x - rest.x,
        dy: zone.y - rest.y,
        depth: zone.depth,
        angles: new Map((zone.children ?? []).map((c) => [c, c.angle])),
      };
      displaced.set(o.id, entry);
    }
    const rest = restingPosition(o);
    entry.zone.setPosition(rest.x + entry.dx + d.x, rest.y + entry.dy + d.y);
    entry.zone.setDepth(entry.depth + d.y * DEPTH_PER_PX);
    for (const [sprite, base] of entry.angles) sprite.setAngle(base + angle);
  }
  function release(id) {
    const entry = displaced.get(id);
    displaced.delete(id);
    if (entry?.virtual) return entry.virtual.release();
    const o = ctx.GD().Repos.MapObject.get(id);
    if (!entry?.zone.scene || !map.isLiveObject(o)) return;
    const rest = restingPosition(o);
    entry.zone.setPosition(rest.x + entry.dx, rest.y + entry.dy);
    entry.zone.setDepth(entry.depth);
    for (const [sprite, base] of entry.angles) sprite.setAngle(base);
  }

  const isPreviewing = () =>
    draft?.ids.length && draft.steps.length && pick.current() !== "anim-select";
  // The animation being edited stops while its draft previews the changes.
  const activeAnimations = () => [
    ...shared.items.filter((a) => a.running && a.id !== draft?.editId && !hiddenIds.has(a.id)),
    ...(isPreviewing() ? [draft] : []),
  ];
  const elapsedSeconds = (a) =>
    a !== draft
      ? (Date.now() + shared.clockOffset - a.startedAt) / 1000
      : draft.paused
        ? draft.time
        : (Date.now() - draft.startedAt) / 1000;

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
      const roots = map.liveObjects(placementOf(a)?.ids ?? []);
      if (!roots.length) continue;
      for (const [o, d] of framesOf(a, roots, elapsedSeconds(a))) {
        if (moved.has(o.id)) continue;
        moved.add(o.id);
        displace(o, d);
      }
    }
    for (const id of [...displaced.keys()]) if (!moved.has(id)) release(id);
    if (studio) updateStudioFrame();
    map.requestRender();
  }
  const refreshAnimations = () => {
    if (!frame) frame = requestAnimationFrame(animate);
  };
  ctx.onCleanup(() => {
    cancelAnimationFrame(frame);
    releaseAll();
    closeStudio();
  });

  const selectSession = {
    id: "anim-select",
    virtual: true,
    outlines: () => [[map.liveObjects(draft?.ids ?? []), COLOR_SELECTED]],
    onPick(o) {
      draft.ids = map.toggleId(draft.ids, o.id);
      changed();
    },
    onBox(objects) {
      draft.ids = map.toggleIds(draft.ids, objects);
      changed();
    },
  };
  // Where the path starts: the center of the selected objects at rest.
  function draftOrigin() {
    const roots = map.liveObjects(draft.ids);
    return roots.length ? groupCenter(roots) : null;
  }
  // Every click adds a step to the clicked point, until Esc.
  const pointSession = {
    id: "anim-point",
    pointerDown(e) {
      const origin = draftOrigin();
      if (origin && draft.steps.length < MAX_STEPS) {
        const p = map.pointerWorldPoint(e);
        draft.steps.push(newStep({ x: p.x - origin.x, y: p.y - origin.y }));
        selectStep(draft.steps.length - 1);
        changed();
      }
      if (!origin || draft.steps.length >= MAX_STEPS) pick.stop("anim-point");
    },
    hover() {},
  };

  const newStep = (to) => ({
    shape: "line",
    easing: "ease-in-out",
    easingExpr: "t^2",
    duration: 1,
    pause: 0,
    rotate: 0,
    to,
    center: null,
    turns: 1,
    direction: 1,
    amplitude: 1,
    waves: 2,
    invert: false,
    bend: 2,
    x: "0",
    y: "-sin(pi*t)",
  });
  function stepData(s) {
    const data = {
      shape: s.shape,
      easing: s.easing,
      duration: s.duration,
      pause: s.pause,
      rotate: s.rotate,
    };
    if (s.easing === "custom") data.easingExpr = s.easingExpr;
    for (const key of SHAPE_FIELDS[s.shape]) data[key] = s[key];
    return data;
  }
  const isValidStep = (s) =>
    (s.easing !== "custom" || !!motion.compile(s.easingExpr)) &&
    (s.shape !== "custom" || (!!motion.compile(s.x) && !!motion.compile(s.y)));
  const canSave = () =>
    draft.ids.length > 0 && draft.steps.length > 0 && draft.steps.every(isValidStep);

  function openDraft(fields) {
    if (pick.current()?.startsWith("anim-")) pick.stop();
    draft = {
      type: "path",
      name: "",
      ids: [],
      mode: "block",
      stagger: { delay: 0.2, order: "left-right" },
      end: "loop",
      steps: [],
      ...fields,
      selected: 0,
      startedAt: Date.now(),
      paused: false,
      time: 0,
      built: null,
      status: "",
    };
    openStudio();
    renderAnimations();
    changed();
  }
  function startDraft() {
    openDraft({});
    pick.start(selectSession);
  }
  // Starts from where the animation is on the current map version. The first
  // animation types open as the path they follow, and are saved as one.
  function startEdit(a) {
    const placed = resolved.get(a.id);
    const ids = placed?.ids ?? [];
    const roots = map.liveObjects(ids);
    const point = placed?.point ?? a.point;
    const path =
      a.type === "path"
        ? a
        : motion.fromLegacy({ ...a, point }, roots.length ? groupCenter(roots) : point);
    openDraft({
      editId: a.id,
      name: a.name,
      ids,
      mode: path.mode,
      stagger: { ...path.stagger },
      end: path.end,
      steps: path.steps.map((s) => ({ ...newStep(s.to ?? null), ...s })),
    });
  }
  // Stopping a session redraws the studio, which needs the draft.
  function closeDraft() {
    if (pick.current()?.startsWith("anim-")) pick.stop();
    draft = null;
    closeStudio();
    renderAnimations();
    refreshAnimations();
  }
  // After any change to the draft: rebuild its path, redraw, keep previewing.
  function changed() {
    draft.built = null;
    draft.status = "";
    renderStudio();
    drawOverlay();
    refreshAnimations();
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

  async function saveDraft() {
    if (!draft || !canSave()) return;
    const saving = draft;
    const data = {
      name: (saving.name.trim() || "Animation").slice(0, MAX_NAME),
      type: "path",
      objects: map.liveObjects(saving.ids).map(map.objectRef),
      mode: saving.mode,
      stagger: { ...saving.stagger },
      end: saving.end,
      steps: saving.steps.map(stepData),
    };
    saving.status = `Saving "${data.name}"…`;
    renderStudio();
    try {
      const { animation } = await api.request(animationsPath(saving.editId), {
        method: saving.editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saving.editId ? { data } : { author: me().name, data }),
      });
      if (draft === saving) closeDraft();
      editLocally(animation.id, animation);
    } catch (e) {
      saving.status = "Save failed: " + e.message;
      if (draft === saving) renderStudio();
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

  // ===================
  // Studio: a floating window to edit the draft, and its path on the map
  // (dashed, with numbered points to drag and the selection's center).
  // ===================
  let studio = null;
  const option = (value, label) => `<option value="${value}">${label}</option>`;
  const options = (entries) => entries.map(([v, l]) => option(v, l)).join("");
  const prop = (label, control, attrs = "") =>
    `<div class="gm-prop"${attrs}><span>${label}</span>${control}</div>`;
  const unitField = (input, unit, title) =>
    `<label class="gm-field"${title ? ` title="${title}"` : ""}>${input}${unit ? `<span class="gm-unit">${unit}</span>` : ""}</label>`;
  const number = (key, min, max, step) =>
    `<input class="gm-input" type="number" data-f="${key}" min="${min}" max="${max}" step="${step}" />`;
  const formula = (key, placeholder) =>
    `<input class="gm-input" data-f="${key}" data-expr placeholder="${placeholder}" />`;
  const note = (text, attrs) =>
    `<div class="gm-note"${attrs}><i class="gm-i sm" data-i="info"></i><span>${text}</span></div>`;
  const STUDIO_HTML = `
    <div class="gm-window-head" data-k="head"><i class="gm-i" data-i="wand-sparkles"></i><span class="gm-window-title">Animation studio</span><button class="gm-iconbtn" data-k="close" title="Close without saving"><i class="gm-i" data-i="x"></i></button></div>
    <div class="gm-window-body">
      <input class="gm-input" data-k="name" maxlength="${MAX_NAME}" placeholder="Name this animation" />
      ${prop("Objects", '<span class="gm-st-objects"><span data-k="count"></span><button class="gm-btn gm-sm" data-k="select"></button></span>')}
      ${prop("Move", '<div class="gm-seg" data-k="mode"><button data-v="block" title="The selection moves and turns as one piece, around its center">As one block</button><button data-v="each" title="Every object follows the path from its own place and turns on itself">Each</button></div>')}
      <div class="gm-st-contents" data-k="stagger">
        ${prop("Stagger", unitField('<input class="gm-input" type="number" data-k="delay" min="0" max="60" step="0.05" />', "s", "Seconds between two objects"))}
        ${prop("Order", `<select class="gm-select" data-k="order">${options(Object.entries(ORDERS))}</select>`)}
      </div>
      ${prop("At the end", '<div class="gm-seg" data-k="end"><button data-v="loop" title="Start again from the beginning">Loop</button><button data-v="pingpong" title="Go back along the path, then again">Ping-pong</button><button data-v="once" title="Stay at the last point">Once</button></div>')}
      <div class="gm-sub">Steps<span class="gm-spacer"></span><button class="gm-btn gm-ghost gm-sm" data-k="add"></button></div>
      <div class="gm-list gm-st-steps" data-k="steps"></div>
      <div class="gm-card gm-st-card" data-k="step">
        <div class="gm-st-cols">
          <select class="gm-select" data-f="shape" title="Shape">${options(Object.entries(motion.SHAPES))}</select>
          <select class="gm-select" data-f="easing" title="Easing">${options(Object.entries(motion.EASINGS).map(([v, e]) => [v, e.label]))}</select>
        </div>
        ${prop("Easing f(t)", unitField(formula("easingExpr", "t^2")), ' data-k="easing-expr"')}
        <div class="gm-st-cols">
          ${unitField(number("duration", 0.05, 600, 0.1), "s", "Duration in seconds")}
          ${unitField(number("pause", 0, 600, 0.1), "pause", "Pause after the step, in seconds")}
          ${unitField(number("rotate", -36000, 36000, 15), "°", "Degrees turned during the step: the block around its center, or each object on itself")}
        </div>
        <div class="gm-st-contents" data-shape="wave">
          ${prop("Height", unitField(number("amplitude", 0, 50, 0.25), "tiles"))}
          ${prop("Waves", unitField(number("waves", 0.5, 50, 0.5)))}
          ${prop("Other side", '<input type="checkbox" class="gm-switch" data-f="invert" />')}
        </div>
        <div class="gm-st-contents" data-shape="arc">${prop("Bend", unitField(number("bend", -50, 50, 0.5), "tiles", "Negative for the other side"))}</div>
        <div class="gm-st-contents" data-shape="orbit">
          ${prop("Turns", unitField(number("turns", 0.05, 100, 0.25)))}
          ${prop("Direction", `<select class="gm-select" data-f="direction">${option(1, "Clockwise")}${option(-1, "Counter-clockwise")}</select>`)}
        </div>
        <div class="gm-st-contents" data-shape="custom">
          ${prop("x(t)", unitField(formula("x", "0"), "tiles"))}
          ${prop("y(t)", unitField(formula("y", "-sin(pi*t)"), "tiles"))}
        </div>
        ${note("Its numbered point on the map is the center: drag it.", ' data-shape="orbit"')}
        ${note("Added to the straight line to the point.", ' data-shape="custom"')}
        ${note("Formulas of t, from 0 to 1: numbers, t, pi, + - * / ^, parentheses, sin cos tan abs sqrt exp floor round sign min max.", ' data-k="syntax"')}
      </div>
      <div class="gm-st-player"><button class="gm-iconbtn gm-st-play" data-k="play"></button><input class="gm-st-scrub" type="range" data-k="scrub" min="0" step="0.01" /><span class="gm-st-clock" data-k="clock"></span></div>
    </div>
    <div class="gm-window-foot"><div class="gm-note"><i class="gm-i sm" data-i="info"></i><span data-k="status"></span></div><button class="gm-btn gm-primary" data-k="save"></button></div>`;

  function openStudio() {
    if (!studio) {
      const win = document.createElement("div");
      win.id = "gm-anim-studio";
      win.className = "gm-window";
      win.innerHTML = STUDIO_HTML;
      document.body.appendChild(win);
      studio = { win, $: (k) => win.querySelector(`[data-k="${k}"]`) };
      wireStudio(win);
      const { left, top } = readJson(STUDIO_POSITION_KEY, { left: 330, top: 80 });
      placeStudio(win, left, top);
      setOverlayListening(true);
    }
    applyTheme(studio.win);
    fillStudio();
  }
  function closeStudio() {
    if (!studio) return;
    studio.win.remove();
    studio = null;
    setOverlayListening(false);
    clearOverlay();
  }
  function placeStudio(win, left, top) {
    const x = Math.min(Math.max(left, 0), innerWidth - win.offsetWidth);
    const y = Math.min(Math.max(top, 0), innerHeight - 48);
    win.style.left = Math.round(x) + "px";
    win.style.top = Math.round(y) + "px";
  }
  function dragStudio(e) {
    if (e.button !== 0 || e.target.closest('[data-k="close"]')) return;
    const win = studio.win;
    const start = { x: e.clientX, y: e.clientY, left: win.offsetLeft, top: win.offsetTop };
    const move = (m) =>
      placeStudio(win, start.left + m.clientX - start.x, start.top + m.clientY - start.y);
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      writeJson(STUDIO_POSITION_KEY, { left: win.offsetLeft, top: win.offsetTop });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }
  function wireStudio(win) {
    const $ = (k) => win.querySelector(`[data-k="${k}"]`);
    for (const type of ["keydown", "keyup", "keypress"])
      win.addEventListener(type, (e) => e.stopPropagation());
    $("head").onpointerdown = dragStudio;
    $("close").onclick = closeDraft;
    $("select").onclick = () => {
      if (pick.current() !== "anim-select") return pick.start(selectSession);
      pick.stop("anim-select");
      if (draft.ids.length && !draft.steps.length) pick.start(pointSession);
    };
    $("add").onclick = () =>
      pick.current() === "anim-point" ? pick.stop("anim-point") : pick.start(pointSession);
    for (const k of ["mode", "end"])
      $(k).onclick = (e) => {
        const value = e.target.closest("button")?.dataset.v;
        if (!value) return;
        draft[k] = value;
        changed();
      };
    $("steps").onclick = (e) => {
      const row = e.target.closest("[data-step]");
      if (!row) return;
      const i = Number(row.dataset.step);
      const action = e.target.closest("[data-act]")?.dataset.act;
      if (action === "del") deleteStep(i);
      else if (action === "up" || action === "down") moveStep(i, action === "up" ? -1 : 1);
      else if (action === "copy") duplicateStep(i);
      else selectStep(i);
      changed();
    };
    $("play").onclick = togglePlay;
    $("scrub").oninput = (e) => {
      draft.paused = true;
      draft.time = Number(e.target.value);
      renderStudio();
      refreshAnimations();
    };
    onEnter($("name"), saveDraft);
    $("save").onclick = saveDraft;
    win.addEventListener("input", onStudioInput);
  }
  function onStudioInput(e) {
    const el = e.target;
    const key = el.dataset.k;
    if (key === "name") draft.name = el.value;
    else if (key === "order") draft.stagger.order = el.value;
    else if (key === "delay") {
      const value = Number(el.value);
      if (el.value === "" || !Number.isFinite(value)) return;
      draft.stagger.delay = Math.min(Math.max(value, 0), 60);
    }
    if (key === "order" || key === "delay" || (el.dataset.f && setStepField(el))) changed();
  }
  function setStepField(el) {
    const step = draft.steps[draft.selected];
    const key = el.dataset.f;
    if (!step) return false;
    if (key === "shape") setShape(step, el.value);
    else if (el.type === "checkbox") step[key] = el.checked;
    else if ("expr" in el.dataset) {
      step[key] = el.value;
      el.classList.toggle("gm-st-bad", !motion.compile(el.value));
    } else if (el.type === "number") {
      const value = Number(el.value);
      if (el.value === "" || !Number.isFinite(value)) return false;
      step[key] = Math.min(Math.max(value, Number(el.min)), Number(el.max));
    } else step[key] = key === "direction" ? Number(el.value) : el.value;
    return true;
  }
  // An orbit starts with its center halfway to the point; leaving an orbit
  // keeps where it ended.
  function setShape(step, shape) {
    const b = builtOf(draft).steps[draft.selected];
    if (shape === "orbit" && step.shape !== "orbit")
      step.center =
        Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y) > TILE_PX
          ? { x: (b.from.x + b.to.x) / 2, y: (b.from.y + b.to.y) / 2 }
          : { x: b.from.x, y: b.from.y - 2 * TILE_PX };
    if (shape !== "orbit" && step.shape === "orbit") step.to = b.to;
    step.shape = shape;
  }
  function selectStep(i) {
    draft.selected = i;
    fillStep();
  }
  function fillStudio() {
    studio.$("name").value = draft.name;
    studio.$("delay").value = draft.stagger.delay;
    studio.$("order").value = draft.stagger.order;
    fillStep();
  }
  function fillStep() {
    const step = draft.steps[draft.selected];
    if (!studio || !step) return;
    for (const el of studio.win.querySelectorAll("[data-f]")) {
      const value = step[el.dataset.f];
      if (el.type === "checkbox") el.checked = value;
      else el.value = value;
      if ("expr" in el.dataset) el.classList.toggle("gm-st-bad", !motion.compile(value));
    }
  }
  function deleteStep(i) {
    draft.steps.splice(i, 1);
    const kept = draft.selected > i ? draft.selected - 1 : draft.selected;
    selectStep(Math.max(0, Math.min(kept, draft.steps.length - 1)));
  }
  // Steps are points on the map: moving one changes the order they are reached in.
  function moveStep(i, by) {
    const j = i + by;
    if (j < 0 || j >= draft.steps.length) return;
    [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
    selectStep(j);
  }
  // The copy makes the same move again from where the step ends.
  function duplicateStep(i) {
    if (draft.steps.length >= MAX_STEPS) return;
    const b = builtOf(draft).steps[i];
    const shift = (p) => p && { x: p.x + b.to.x - b.from.x, y: p.y + b.to.y - b.from.y };
    draft.steps.splice(i + 1, 0, {
      ...draft.steps[i],
      to: shift(b.to),
      center: shift(draft.steps[i].center),
    });
    selectStep(i + 1);
  }
  const seconds = (n) => `${+n.toFixed(2)} s`;
  const stepAction = (action, title, icon) =>
    `<button class="gm-iconbtn${action === "del" ? " gm-danger" : ""}" data-act="${action}" title="${title}">${icon}</button>`;
  const stepRow = (s, i, steps) =>
    `<div class="gm-item${i === draft.selected ? " is-on show-actions" : ""}" data-step="${i}"><span class="gm-avatar gm-st-num">${i + 1}</span><div class="gm-item-text"><span class="gm-item-title">${SHAPE_LABELS[s.shape]} · ${seconds(s.duration)}${s.pause ? ` + ${seconds(s.pause)} pause` : ""}${s.rotate ? ` · ${+s.rotate.toFixed(1)}°` : ""}</span></div><div class="gm-actions">${i > 0 ? stepAction("up", "Move up: reached earlier", '<i class="gm-i sm" data-i="arrow-up"></i>') : ""}${i < steps.length - 1 ? stepAction("down", "Move down: reached later", '<i class="gm-i sm" data-i="arrow-down"></i>') : ""}${steps.length < MAX_STEPS ? stepAction("copy", "Duplicate: the same move again from where this step ends", '<i class="gm-i sm" data-i="copy"></i>') : ""}${stepAction("del", "Delete this step", '<i class="gm-i sm" data-i="trash-2"></i>')}</div></div>`;
  function studioStatus(session) {
    if (draft.status) return draft.status;
    if (session === "anim-select")
      return "Click objects on the map or drag a box around them, then Done.";
    if (session === "anim-point")
      return `Click the map to add point ${draft.steps.length + 1}. Esc or Done to stop.`;
    if (!draft.ids.length) return "Select the objects to animate.";
    if (!draft.steps.length) return "Add points on the map: the objects go from one to the next.";
    const bad = draft.steps.findIndex((s) => !isValidStep(s));
    if (bad >= 0) return `Step ${bad + 1}: a formula is not valid.`;
    return "Drag the numbered points on the map to change the path.";
  }
  function renderStudio() {
    if (!studio || !draft) return;
    const $ = studio.$;
    const session = pick.current();
    const { steps } = draft;
    const step = steps[draft.selected];
    $("count").textContent = `${draft.ids.length} selected`;
    $("select").textContent =
      session === "anim-select" ? "Done" : draft.ids.length ? "Change" : "Select";
    $("select").classList.toggle("gm-primary", session === "anim-select");
    for (const k of ["mode", "end"])
      for (const b of $(k).children) b.classList.toggle("on", b.dataset.v === draft[k]);
    $("stagger").style.display = draft.mode === "each" ? "" : "none";
    $("steps").innerHTML = steps.length
      ? steps.map(stepRow).join("")
      : '<div class="gm-empty">No steps yet</div>';
    const adding = session === "anim-point";
    $("add").innerHTML = adding
      ? '<i class="gm-i sm" data-i="check"></i>Done'
      : '<i class="gm-i sm" data-i="plus"></i>Add points';
    $("add").title = adding ? "Stop adding points" : "Click the map to add points";
    $("add").classList.toggle("gm-primary", adding);
    $("add").classList.toggle("gm-ghost", !adding);
    $("add").disabled = !adding && (!draft.ids.length || steps.length >= MAX_STEPS);
    $("step").style.display = step ? "" : "none";
    if (step) {
      for (const el of studio.win.querySelectorAll("[data-shape]"))
        el.style.display = el.dataset.shape === step.shape ? "" : "none";
      $("easing-expr").style.display = step.easing === "custom" ? "" : "none";
      $("syntax").style.display = step.easing === "custom" || step.shape === "custom" ? "" : "none";
    }
    $("play").disabled = $("scrub").disabled = !steps.length;
    const status = studioStatus(session);
    $("status").textContent = status;
    $("status").parentElement.classList.toggle("gm-err", /^(Save failed|Step \d+:)/.test(status));
    $("save").disabled = !canSave();
    $("save").textContent = draft.editId ? "Save changes" : "Save";
    updateClock();
  }

  // One pass of the preview: there and back for ping-pong, until the last
  // object arrives for "once".
  function timelineSpan() {
    const { total } = builtOf(draft);
    if (draft.end === "pingpong") return 2 * total;
    const objects = draft.mode === "each" && draft.end === "once" ? draft.ids.length : 1;
    return total + draft.stagger.delay * Math.max(objects - 1, 0);
  }
  function clockTime(span) {
    const t = elapsedSeconds(draft);
    if (draft.end === "once") return Math.min(t, span);
    return span ? t % span : 0;
  }
  function updateClock() {
    const span = timelineSpan();
    const t = clockTime(span);
    const ended = draft.end === "once" && span > 0 && t >= span;
    studio.$("scrub").max = span;
    studio.$("scrub").value = t;
    studio.$("clock").textContent = `${t.toFixed(1)} / ${span.toFixed(1)} s`;
    const play = studio.$("play");
    const icon = `<i class="gm-i sm" data-i="${ended ? "rotate-ccw" : draft.paused ? "play" : "pause"}"></i>`;
    if (play.innerHTML !== icon) play.innerHTML = icon;
    play.title = ended ? "Play again" : draft.paused ? "Play" : "Pause";
  }
  function togglePlay() {
    const span = timelineSpan();
    const t = clockTime(span);
    const ended = draft.end === "once" && t >= span;
    draft.paused = !draft.paused && !ended;
    draft.time = t;
    draft.startedAt = Date.now() - (ended ? 0 : t) * 1000;
    renderStudio();
    refreshAnimations();
  }
  function updateStudioFrame() {
    updateClock();
    if (overlay && overlay.zoom !== map.scene().cameras.main.zoom) drawOverlay();
    else drawMarker();
  }

  let overlay = null;
  let hoveredHandle = -1;
  let gesture = null;
  function clearOverlay() {
    if (!overlay) return;
    overlay.graphics.destroy();
    overlay.marker.destroy();
    overlay.labels.forEach((l) => l.destroy());
    overlay = null;
    map.requestRender();
  }
  // Orbits are dragged by their center, other steps by where they arrive.
  const handleOf = (b) => (b.step.shape === "orbit" ? b.step.center : b.to);
  function drawOverlay() {
    const origin = studio && draftOrigin();
    if (overlay && !overlay.graphics.scene) overlay = null;
    if (!origin) return clearOverlay();
    const scene = map.scene();
    overlay ??= {
      graphics: scene.add.graphics().setDepth(OVERLAY_DEPTH),
      marker: scene.add.graphics().setDepth(OVERLAY_DEPTH + 2),
      labels: [],
    };
    overlay.zoom = scene.cameras.main.zoom;
    const px = 1 / overlay.zoom;
    const g = overlay.graphics.clear();
    const built = builtOf(draft);
    const at = (p, from = origin) => ({ x: from.x + p.x, y: from.y + p.y });
    if (draft.mode === "each" && built.steps.length) {
      const path = motion.samplePath(built, 16);
      g.lineStyle(1.5 * px, COLOR_PATH, 0.4);
      for (const o of map.liveObjects(draft.ids))
        g.strokePoints(path.map((p) => at(p, anchorOf(o))));
    }
    dashed(
      g,
      motion.samplePath(built).map((p) => at(p)),
      px,
    );
    const r = 7 * px;
    for (const [width, color] of [
      [4 * px, 0x000000],
      [2 * px, 0xffffff],
    ]) {
      g.lineStyle(width, color, 1);
      g.lineBetween(origin.x - r, origin.y, origin.x + r, origin.y);
      g.lineBetween(origin.x, origin.y - r, origin.x, origin.y + r);
    }
    built.steps.forEach((b, i) => {
      const h = at(handleOf(b));
      const selected = i === draft.selected;
      const radius = (i === hoveredHandle ? 1.25 : 1) * HANDLE_RADIUS_PX * px;
      if (b.step.shape === "orbit") {
        const end = at(b.to);
        g.fillStyle(COLOR_PATH, 1).fillCircle(end.x, end.y, 3 * px);
      }
      g.fillStyle(selected ? COLOR_HANDLE_SELECTED : COLOR_HANDLE, 1).fillCircle(h.x, h.y, radius);
      g.lineStyle(2 * px, 0xffffff, 1).strokeCircle(h.x, h.y, radius);
      handleLabel(i, h, selected);
    });
    overlay.labels.slice(built.steps.length).forEach((l) => l.setVisible(false));
    drawMarker();
    map.requestRender();
  }
  // Dashes keep the same length on screen at any zoom (px: one screen pixel).
  function dashed(g, points, px) {
    g.lineStyle(4.5 * px, 0x000000, 0.35).strokePoints(points);
    g.lineStyle(2.5 * px, COLOR_PATH, 1);
    let on = true;
    let left = 7 * px;
    for (let k = 1; k < points.length; k++) {
      let a = points[k - 1];
      const b = points[k];
      let length = Math.hypot(b.x - a.x, b.y - a.y);
      while (length > 1e-6) {
        const step = Math.min(left, length);
        const m = {
          x: a.x + ((b.x - a.x) * step) / length,
          y: a.y + ((b.y - a.y) * step) / length,
        };
        if (on) g.lineBetween(a.x, a.y, m.x, m.y);
        a = m;
        length -= step;
        left -= step;
        if (left <= 1e-6) {
          on = !on;
          left = (on ? 7 : 5) * px;
        }
      }
    }
  }
  function handleLabel(i, p, selected) {
    let text = overlay.labels[i];
    if (!text) {
      text = map
        .scene()
        .add.text(0, 0, "", {
          fontFamily: "Arial",
          fontSize: "22px",
          fontStyle: "bold",
          color: "#ffffff",
        })
        .setOrigin(0.5)
        .setDepth(OVERLAY_DEPTH + 1);
      overlay.labels[i] = text;
    }
    text
      .setText(String(i + 1))
      .setColor(selected ? "#1f1f23" : "#ffffff")
      .setPosition(p.x, p.y)
      .setScale(0.5 / overlay.zoom)
      .setVisible(true);
  }
  // Where the path is at the preview's time.
  function drawMarker() {
    const marker = overlay?.marker.clear();
    if (!marker || !isPreviewing()) return;
    const origin = draftOrigin();
    const s = motion.stateAt(builtOf(draft), elapsedSeconds(draft));
    marker
      .lineStyle(2 / overlay.zoom, 0xffffff, 1)
      .strokeCircle(origin.x + s.x, origin.y + s.y, 5 / overlay.zoom);
  }
  function handleAt(e) {
    const origin = draftOrigin();
    if (!origin) return -1;
    const steps = builtOf(draft).steps;
    for (let i = steps.length - 1; i >= 0; i--) {
      const h = handleOf(steps[i]);
      const s = map.tileToScreen((origin.x + h.x) / TILE_PX, (origin.y + h.y) / TILE_PX);
      if (Math.hypot(s.x - e.clientX, s.y - e.clientY) <= HANDLE_RADIUS_PX + 3) return i;
    }
    return -1;
  }
  function moveHandle(i, e) {
    const origin = draftOrigin();
    const p = map.pointerWorldPoint(e);
    const step = draft.steps[i];
    step[step.shape === "orbit" ? "center" : "to"] = { x: p.x - origin.x, y: p.y - origin.y };
    changed();
  }
  const GESTURE_EVENTS = [
    "pointerdown",
    "pointermove",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
  ];
  // Dragging a point takes the whole gesture from Gather (and from adding points).
  function onOverlayPointer(e) {
    if (e.type === "pointerdown") gesture = null;
    if (!gesture) {
      if (!draft || pick.current() === "anim-select" || !map.isOnMap(e)) return;
      if (e.type === "pointermove") {
        const i = handleAt(e);
        if (i !== hoveredHandle) {
          hoveredHandle = i;
          drawOverlay();
        }
        return;
      }
      if (e.type !== "pointerdown" || e.button !== 0) return;
      const index = handleAt(e);
      if (index < 0) return;
      gesture = { index, dragging: true };
      selectStep(index);
      renderStudio();
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type === "pointermove" && gesture.dragging) moveHandle(gesture.index, e);
    if (e.type === "pointerup") {
      gesture.dragging = false;
      setTimeout(() => (gesture = null));
    }
  }
  function setOverlayListening(on) {
    for (const type of GESTURE_EVENTS)
      window[on ? "addEventListener" : "removeEventListener"](type, onOverlayPointer, true);
    gesture = null;
    hoveredHandle = -1;
  }

  let root = null;
  const typeLabel = (a) =>
    a.type === "path"
      ? `${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`
      : (LEGACY_LABELS[a.type] ?? a.type);
  function toggleHidden(id) {
    if (!hiddenIds.delete(id)) hiddenIds.add(id);
    writeJson(HIDDEN_ANIMATIONS_KEY, [...hiddenIds]);
    renderAnimations();
    refreshAnimations();
  }
  // Everyone's animations play; yours can be started, stopped and edited, the
  // others' only hidden on your screen.
  function renderAnimations() {
    if (!root?.isConnected) return;
    const button = root.querySelector("#gm-anim-new");
    button.innerHTML = draft
      ? '<i class="gm-i sm" data-i="x"></i>Cancel'
      : '<i class="gm-i sm" data-i="plus"></i>New';
    button.title = !draft
      ? "Opens the animation studio: select objects, add points on the map, adjust each step, save."
      : draft.editId
        ? "Cancel editing"
        : "Cancel the new animation";
    button.classList.toggle("gm-primary", !draft);
    const list = root.querySelector("#gm-anims");
    const own = shared.items.filter((a) => a.mine);
    list.innerHTML = own.length
      ? own
          .map((a) => {
            const editing = a.id === draft?.editId;
            return `<div class="gm-item${a.running ? " is-on" : ""}${editing ? " gm-fun-editing" : ""}" data-id="${escapeHtml(a.id)}" title="${a.running ? "Click to stop it for everyone" : "Click to start it for everyone"}"><i class="gm-i" data-i="${a.running ? "pause" : "play"}"></i><div class="gm-item-text"><span class="gm-item-title">${escapeHtml(a.name)}</span></div><span class="gm-tail hide-on-hover">${editing ? "Editing" : escapeHtml(typeLabel(a))}</span><div class="gm-actions"><button class="gm-iconbtn" data-edit="${escapeHtml(a.id)}" title="Edit in the studio"><i class="gm-i" data-i="pencil"></i></button><button class="gm-iconbtn gm-danger" data-del="${escapeHtml(a.id)}" title="Delete for everyone"><i class="gm-i" data-i="trash-2"></i></button></div></div>`;
          })
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
    list.querySelectorAll("[data-edit]").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        const a = find(d.dataset.edit);
        if (a) startEdit(a);
      };
    });
    list.querySelectorAll("[data-del]").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        const a = find(d.dataset.del);
        if (!a) return;
        if (draft?.editId === a.id) closeDraft();
        deleteAnimation(a);
      };
    });
    const others = shared.items.filter((a) => !a.mine);
    const othersList = root.querySelector("#gm-anims-others");
    othersList.innerHTML = others.length
      ? others
          .map((a) => {
            const hidden = hiddenIds.has(a.id);
            return `<div class="gm-item${hidden ? " is-muted" : ""}"><i class="gm-i" data-i="sparkles"></i><div class="gm-item-text"><span class="gm-item-title">${escapeHtml(a.name)}</span><span class="gm-item-meta">${escapeHtml(a.author || "?")} · ${hidden ? "hidden for you" : escapeHtml(typeLabel(a)) + (a.running ? "" : " · stopped")}</span></div><button class="gm-iconbtn" data-hide="${escapeHtml(a.id)}" title="${hidden ? "Show again on your screen" : "Hide on your screen only"}"><i class="gm-i" data-i="${hidden ? "eye-off" : "eye"}"></i></button></div>`;
          })
          .join("")
      : '<div class="gm-empty">No one else has animations on this map</div>';
    othersList.querySelectorAll("[data-hide]").forEach((d) => {
      d.onclick = () => toggleHidden(d.dataset.hide);
    });
  }
  pick.onChange(() => {
    renderStudio();
    drawOverlay();
    refreshAnimations();
  });

  ctx.section({
    title: "Fun",
    parts: [
      { id: "flee", label: "Flee mode" },
      { id: "animations", label: "Animations" },
    ],
    status: () => {
      if (fleeTargetId) return "Fleeing";
      const playing = shared.items.filter((a) => a.mine && a.running).length;
      return playing ? `${playing} playing` : null;
    },
    html: `
      <div data-part="flee">
        <div class="gm-sub">Flee mode</div>
        <div class="gm-field"><i class="gm-i" data-i="search"></i><input class="gm-input" id="gm-flee-search" placeholder="Search players" /></div>
        <div class="gm-list" id="gm-flee-players"></div>
      </div>
      <div data-part="animations">
        <div class="gm-sub">Your animations<span class="gm-spacer"></span><button class="gm-btn gm-primary gm-sm" id="gm-anim-new"></button></div>
        <div class="gm-list" id="gm-anims"></div>
        <div class="gm-note gm-err"><i class="gm-i sm" data-i="circle-alert"></i><span id="gm-anims-status"></span></div>
        <div class="gm-sub">On this map</div>
        <div class="gm-list" id="gm-anims-others"></div>
      </div>`,
    mount(el) {
      root = el;
      const search = el.querySelector("#gm-flee-search");
      search.addEventListener("keydown", (e) => e.stopPropagation());
      search.addEventListener("input", () => renderPlayers(el));
      renderPlayers(el);
      el.querySelector("#gm-anim-new").onclick = () => (draft ? closeDraft() : startDraft());
      renderAnimations();
    },
  });
  ctx.style(`
    #gather-mods-panel .gm-fun-fleeing { color:var(--gm-accent-text); }
    #gather-mods-panel .gm-item.gm-fun-editing { box-shadow:inset 0 0 0 1.5px var(--gm-accent); }
    #gm-anim-studio { position:fixed; z-index:2147482400; width:296px; max-height:calc(100vh - 24px); }
    #gm-anim-studio .gm-window-head { height:44px; padding:0 8px 0 14px; cursor:move; user-select:none; }
    #gm-anim-studio .gm-window-head > .gm-i { color:var(--gm-text-2); }
    #gm-anim-studio .gm-window-body { flex:1; min-height:0; overflow-y:auto; gap:8px; padding:12px 12px 10px; }
    #gm-anim-studio .gm-window-foot { justify-content:space-between; padding:10px 12px; }
    #gm-anim-studio .gm-window-foot > .gm-note { flex:1; min-width:0; padding:0; }
    #gm-anim-studio .gm-st-contents { display:contents; }
    #gm-anim-studio .gm-prop > :is(.gm-field, .gm-select, .gm-seg) { width:180px; }
    #gm-anim-studio .gm-st-objects { display:flex; align-items:center; gap:6px; }
    #gm-anim-studio .gm-st-steps { max-height:150px; overflow-y:auto; }
    #gm-anim-studio .gm-st-steps .gm-item { min-height:30px; }
    #gm-anim-studio .gm-st-steps .gm-item-title { font-size:12.5px; }
    #gm-anim-studio .gm-st-num { width:18px; height:18px; background:#6c5ce7; }
    #gm-anim-studio .gm-item.is-on .gm-st-num { background:#ffd400; color:#1f1f23; }
    #gm-anim-studio .gm-st-card { gap:6px; padding:8px; }
    #gm-anim-studio .gm-st-cols { display:flex; gap:6px; }
    #gm-anim-studio .gm-st-cols > * { flex:1; min-width:0; }
    #gm-anim-studio .gm-st-cols > .gm-field:has(> .gm-unit) { flex:1 1 auto; padding-right:8px; }
    #gm-anim-studio .gm-st-cols > .gm-field:has(> .gm-unit) > .gm-input { width:0; padding-left:8px; padding-right:3px; }
    #gm-anim-studio :is(.gm-input.gm-st-bad, .gm-field:has(> .gm-st-bad)) { border-color:var(--gm-danger); }
    #gm-anim-studio .gm-st-player { display:flex; align-items:center; gap:8px; margin-top:2px; }
    #gm-anim-studio .gm-st-play { width:30px; height:30px; border-radius:50%; background:var(--gm-accent); color:var(--gm-on-accent); }
    #gm-anim-studio .gm-st-play:hover { background:var(--gm-accent); color:var(--gm-on-accent); filter:brightness(1.08); }
    #gm-anim-studio .gm-st-scrub { flex:1; min-width:0; margin:0; accent-color:var(--gm-accent); }
    #gm-anim-studio .gm-st-clock { flex:none; min-width:58px; text-align:right; font-size:11.5px; color:var(--gm-text-3); font-variant-numeric:tabular-nums; }
  `);
  ctx.onTick(() => {
    if (showFlee && root?.isConnected) renderPlayers(root);
    if (studio) applyTheme(studio.win);
    if (overlay && overlay.zoom !== map.scene().cameras.main.zoom) drawOverlay();
    if (!showAnimations) return;
    const due = Date.now() - shared.syncedAt > SYNC_MS;
    if (map.currentFloorId() !== shared.floorId || (due && !document.hidden)) sync();
    else resolveAll();
  });
  if (showAnimations) sync();
});
