// Custom objects: images drawn on the map for everyone who has this module,
// stored on the community hub per floor (Gather V2 has no custom catalog
// objects). A free image has a position, size, layer, base line and optional
// collision; a skin replaces the look of a real object, which keeps its own
// collision and seats. Nothing is sent to Gather's server: collisions only
// stop the avatars of people who have this module.
window.__gatherMods.define("custom", (ctx) => {
  const { GD, MC, me, escapeHtml, onEnter, hubUrl } = ctx;
  const map = ctx.use("map");
  const pick = ctx.use("map-pick");
  const api = ctx.use("hub-api");
  const { TILE_PX } = map;
  const SYNC_MS = 60_000;
  const MAX_NAME = 40;
  const COLOR_SELECTED = 0x00e5ff;
  // Gather draws the floor around depth 4, and sorts avatars and objects at
  // 7 + (the y of their base, in pixels) / 9999.
  const FLOOR_DEPTH = 4.5;
  const ABOVE_DEPTH = 9;
  const sortedDepth = (basePx) => 7 + basePx / 9999;
  const SKIN_DEPTH_STEP = 1e-7;
  const COLLISION_ID = "gather-mods-custom-object";
  const DIRECTIONS = { Left: [-1, 0], Right: [1, 0], Up: [0, -1], Down: [0, 1] };
  const LAYERS = {
    floor: "Floor (under everyone)",
    sorted: "Sorted (like objects)",
    above: "Above everything",
  };
  const DEFAULT_FREE = { width: 2, height: 2, layer: "sorted", base: 2, collision: false };
  const showStatus = (text) => {
    shared.status = text;
    renderList();
  };

  const shared = { floorId: null, items: [], syncedAt: 0, status: "" };
  let draft = null;
  const objectsPath = (id = "") => `/objects/${shared.floorId}${id ? "/" + id : ""}`;
  const imageSrc = (url) => (url.startsWith("/images/") ? hubUrl() + url : url);

  // ===================
  // Textures: one per image URL, loaded once.
  // ===================
  const textures = new Map();
  const textureKey = (url) => "gather-mods-custom:" + url;
  function texture(url) {
    const scene = map.scene();
    const key = textureKey(url);
    if (scene.textures.exists(key)) return key;
    if (textures.has(url)) return null;
    textures.set(url, "loading");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!map.scene().textures.exists(key)) map.scene().textures.addImage(key, img);
      textures.set(url, "ready");
      renderAll();
      renderEditor();
    };
    img.onerror = () => {
      textures.set(url, "error");
      renderEditor();
      renderList();
    };
    img.src = imageSrc(url);
    return null;
  }
  ctx.onCleanup(() => {
    const scene = map.scene();
    for (const url of textures.keys())
      if (scene.textures.exists(textureKey(url))) scene.textures.remove(textureKey(url));
  });

  // ===================
  // Placement
  // ===================
  let zoneIndex = new Map();
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
  // Where an object is drawn: the rectangle and depth, and for a skin the
  // zone of the real object it covers.
  function placementOf(o) {
    if (o.mode === "skin") {
      if (!o.skin) return null;
      const target =
        o.objectId && GD().Repos.MapObject.get(o.objectId)
          ? GD().Repos.MapObject.get(o.objectId)
          : map.resolveRefs([o.skin.object])[0];
      const zone = target && map.isLiveObject(target) && zoneOf(target.id);
      if (!zone) return null;
      return { zone, depth: zone.depth + SKIN_DEPTH_STEP };
    }
    const f = o.free;
    if (!f || f.x === undefined) return null;
    const depth =
      f.layer === "floor"
        ? FLOOR_DEPTH
        : f.layer === "above"
          ? ABOVE_DEPTH
          : sortedDepth((f.y + f.base) * TILE_PX);
    return {
      x: f.x * TILE_PX,
      y: f.y * TILE_PX,
      width: f.width * TILE_PX,
      height: f.height * TILE_PX,
      depth,
    };
  }

  // The tiles under the base line of free objects with collision.
  function collisionTiles(objects) {
    const tiles = new Set();
    for (const o of objects) {
      const f = o.free;
      if (o.mode !== "free" || !f?.collision || f.x === undefined) continue;
      const bottom = Math.ceil(f.y + f.height) - 1;
      const top = f.base < f.height ? Math.floor(f.y + f.base) : bottom;
      for (let y = top; y <= bottom; y++)
        for (let x = Math.floor(f.x); x < Math.ceil(f.x + f.width); x++) tiles.add(`${x}/${y}`);
    }
    return tiles;
  }

  // ===================
  // Drawing
  // ===================
  const drawn = new Map();
  const shownObjects = () => [
    ...shared.items.filter((o) => o.id !== draft?.editId),
    ...(draft && draft.imageUrl && placementOf(draft) ? [{ ...draft, id: "draft" }] : []),
  ];
  function setChildrenVisible(zone, visible) {
    for (const child of zone.children ?? [])
      if (child.visible !== visible) child.setVisible(visible);
  }
  function undraw(id) {
    const entry = drawn.get(id);
    drawn.delete(id);
    if (!entry) return;
    entry.sprite.destroy();
    if (entry.zone?.scene && ![...drawn.values()].some((e) => e.zone === entry.zone))
      setChildrenVisible(entry.zone, true);
  }
  function draw(o) {
    const key = texture(o.imageUrl);
    const place = placementOf(o);
    if (!key || !place) return undraw(o.id);
    let entry = drawn.get(o.id);
    if (entry && (entry.key !== key || entry.zone !== place.zone)) {
      undraw(o.id);
      entry = null;
    }
    if (!entry) {
      entry = { key, zone: place.zone, sprite: map.scene().add.image(0, 0, key).setOrigin(0, 0) };
      drawn.set(o.id, entry);
    }
    entry.sprite.setAlpha(o.opacity).setDepth(place.depth);
    if (place.zone) placeOverZone(entry);
    else entry.sprite.setPosition(place.x, place.y).setDisplaySize(place.width, place.height);
  }
  // Skins follow their object (an animation can move it) and keep it hidden.
  function placeOverZone({ sprite, zone }) {
    if (!zone.scene) return;
    sprite.setPosition(zone.x, zone.y).setDisplaySize(zone.width, zone.height);
    setChildrenVisible(zone, false);
  }
  function followSkins() {
    for (const entry of drawn.values()) if (entry.zone) placeOverZone(entry);
  }
  map.scene().events.on("prerender", followSkins);

  // Collisions: pathfinding reads Gather's collision map; arrow keys are
  // stopped before the move is sent.
  let blocked = new Set();
  let collisions = null;
  function setCollisions(tiles) {
    const current = GD().Repos.gameSpace.currentMap?.collisions;
    if (collisions && collisions === current)
      for (const hash of blocked) {
        const at = collisions.collisionsMap[hash];
        at?.delete(COLLISION_ID);
        if (at && !at.size) delete collisions.collisionsMap[hash];
      }
    collisions = current;
    blocked = tiles;
    if (collisions)
      for (const hash of tiles) collisions.getCollisionsOrCreate(hash).add(COLLISION_ID);
  }
  const moveController = MC();
  const gameMove = Object.getPrototypeOf(moveController).gameMove;
  moveController.gameMove = function (direction) {
    const step = DIRECTIONS[direction?.value];
    const self = me();
    if (step && blocked.has(`${self.x + step[0]}/${self.y + step[1]}`)) return;
    return gameMove.call(this, direction);
  };

  function renderAll() {
    const objects = shownObjects();
    const ids = new Set(objects.map((o) => o.id));
    for (const id of [...drawn.keys()]) if (!ids.has(id)) undraw(id);
    for (const o of objects) draw(o);
    setCollisions(collisionTiles(objects));
    map.requestRender();
  }
  ctx.onCleanup(() => {
    map.scene().events.off("prerender", followSkins);
    for (const id of [...drawn.keys()]) undraw(id);
    setCollisions(new Set());
    delete moveController.gameMove;
    map.requestRender();
  });

  // ===================
  // Hub
  // ===================
  async function sync() {
    const floorId = map.currentFloorId();
    if (floorId !== shared.floorId) {
      Object.assign(shared, { floorId, items: [] });
      closeDraft();
    }
    shared.syncedAt = Date.now();
    try {
      const { items } = await api.request(objectsPath());
      if (floorId !== shared.floorId) return;
      shared.items = items;
      if (shared.status.startsWith("Hub")) shared.status = "";
    } catch (e) {
      shared.status = "Hub unreachable: " + e.message;
    }
    renderAll();
    renderList();
  }

  const isReady = () =>
    draft?.imageUrl && (draft.mode === "skin" ? !!draft.skin?.object : draft.free.x !== undefined);
  async function saveDraft() {
    if (!isReady()) return;
    const name = (root.querySelector("#gm-co-name").value.trim() || "Image").slice(0, MAX_NAME);
    const data = {
      name,
      imageUrl: draft.imageUrl,
      opacity: draft.opacity,
      mode: draft.mode,
      ...(draft.mode === "skin" ? { skin: draft.skin } : { free: draft.free }),
    };
    showStatus(`Saving "${name}"…`);
    try {
      const { object } = await api.request(objectsPath(draft.editId), {
        method: draft.editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft.editId ? { data } : { author: me().name, data }),
      });
      const others = shared.items.filter((o) => o.id !== object.id);
      shared.items = draft.editId
        ? shared.items.map((o) => (o.id === object.id ? object : o))
        : [...others, object];
      shared.status = "";
      closeDraft();
    } catch (e) {
      showStatus("Save failed: " + e.message);
    }
  }
  async function deleteObject(o) {
    if (draft?.editId === o.id) closeDraft();
    shared.items = shared.items.filter((x) => x.id !== o.id);
    renderAll();
    renderList();
    try {
      await api.request(objectsPath(o.id), { method: "DELETE" });
    } catch (e) {
      showStatus(`Could not delete "${o.name}": ${e.message}`);
      sync();
    }
  }
  async function uploadImage(file) {
    showStatus(`Uploading ${file.name}…`);
    try {
      const { url } = await api.request("/images", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      showStatus("");
      setImage(url);
    } catch (e) {
      showStatus("Upload failed: " + e.message);
    }
  }

  // ===================
  // Editor
  // ===================
  const placeSession = {
    id: "custom-place",
    hover(e) {
      if (!e || draft?.mode !== "free") return;
      const p = map.pointerWorldPoint(e);
      const snap = (v) => Math.round(v * 8) / 8;
      draft.free.x = snap(p.x / TILE_PX - draft.free.width / 2);
      draft.free.y = snap(p.y / TILE_PX - draft.free.height / 2);
      renderAll();
    },
    pointerDown(e) {
      placeSession.hover(e);
      pick.stop("custom-place");
    },
  };
  const skinSession = {
    id: "custom-skin",
    outlines: () => [[map.liveObjects(draft?.objectId ? [draft.objectId] : []), COLOR_SELECTED]],
    onPick(o) {
      draft.objectId = o.id;
      draft.skin = { object: map.objectRef(o) };
      pick.stop("custom-skin");
      renderAll();
    },
  };

  function startDraft(mode, from = null) {
    if (pick.current()?.startsWith("custom-")) pick.stop();
    const free = from?.free ?? { ...DEFAULT_FREE };
    draft = {
      editId: from?.id,
      mode,
      name: from?.name ?? "",
      imageUrl: from?.imageUrl ?? "",
      opacity: from?.opacity ?? 1,
      free: { ...free },
      skin: from?.skin,
      objectId: null,
    };
    fillEditor();
    renderEditor();
    renderList();
    if (!from) pick.start(mode === "skin" ? skinSession : placeSession);
  }
  function closeDraft() {
    draft = null;
    if (pick.current()?.startsWith("custom-")) pick.stop();
    renderAll();
    renderEditor();
    renderList();
  }
  function setImage(url) {
    draft.imageUrl = url;
    root.querySelector("#gm-co-url").value = url;
    renderAll();
    renderEditor();
  }

  let root = null;
  function fillEditor() {
    const $ = (sel) => root?.querySelector(sel);
    if (!$("#gm-co-editor")) return;
    $("#gm-co-url").value = draft.imageUrl;
    $("#gm-co-name").value = draft.name;
    $("#gm-co-opacity").value = draft.opacity;
    $("#gm-co-width").value = draft.free.width;
    $("#gm-co-height").value = draft.free.height;
    $("#gm-co-layer").value = draft.free.layer;
    $("#gm-co-base").value = draft.free.base;
    $("#gm-co-collision").checked = draft.free.collision;
  }
  function renderEditor() {
    if (!root?.isConnected) return;
    const $ = (sel) => root.querySelector(sel);
    const editing = draft?.editId;
    $("#gm-co-new").textContent =
      draft?.mode === "free" ? (editing ? "Cancel editing" : "Cancel new image") : "New image…";
    $("#gm-co-new").classList.toggle("active", draft?.mode === "free");
    $("#gm-co-skin").textContent =
      draft?.mode === "skin"
        ? editing
          ? "Cancel editing"
          : "Cancel restyle"
        : "Restyle an object…";
    $("#gm-co-skin").classList.toggle("active", draft?.mode === "skin");
    $("#gm-co-editor").style.display = draft ? "" : "none";
    if (!draft) return;
    const mode = pick.current();
    const loading = draft.imageUrl && textures.get(draft.imageUrl) === "loading";
    const broken = draft.imageUrl && textures.get(draft.imageUrl) === "error";
    $("#gm-co-status").textContent = broken
      ? "This image could not be loaded"
      : !draft.imageUrl
        ? "Paste an image URL or upload an image"
        : loading
          ? "Loading the image…"
          : mode === "custom-place"
            ? "Move the pointer, click to drop it (Esc to cancel)"
            : mode === "custom-skin"
              ? "Click the object to restyle"
              : !isReady()
                ? draft.mode === "skin"
                  ? "Pick the object to restyle"
                  : "Place it on the map"
                : "Preview shown: adjust, then save";
    root.querySelectorAll("[data-co-for]").forEach((el) => {
      el.style.display = el.dataset.coFor === draft.mode ? "" : "none";
    });
    $("#gm-co-base-row").style.display =
      draft.mode === "free" && draft.free.layer === "sorted" ? "" : "none";
    $("#gm-co-place").textContent =
      draft.free.x === undefined ? "Place on the map" : "Move on the map";
    $("#gm-co-place").classList.toggle("active", mode === "custom-place");
    $("#gm-co-pick").textContent = draft.skin ? "Pick another object" : "Pick the object";
    $("#gm-co-pick").classList.toggle("active", mode === "custom-skin");
    $("#gm-co-save").disabled = !isReady() || broken;
    $("#gm-co-save").textContent = editing ? "Save changes" : "Save";
  }
  // Everyone's objects are drawn, but only yours are listed: you can't act on the others.
  function renderList() {
    if (!root?.isConnected) return;
    const list = root.querySelector("#gm-co-list");
    const own = shared.items.filter((o) => o.mine);
    list.innerHTML = own.length
      ? own
          .map(
            (o) =>
              `<div class="gm-item${o.id === draft?.editId ? " gm-editing" : ""}" data-id="${escapeHtml(o.id)}"><span class="gm-name">${escapeHtml(o.name)}</span><span class="gm-actions"><span class="gm-co-mode">${o.mode === "skin" ? "Restyle" : LAYERS[o.free.layer].split(" (")[0]}</span><span class="gm-edit" data-edit="${escapeHtml(o.id)}" title="Edit this object">✎</span><span class="gm-del" data-del="${escapeHtml(o.id)}" title="Delete this object for everyone">✕</span></span></div>`,
          )
          .join("")
      : '<div class="gm-empty">You have no custom objects on this map</div>';
    root.querySelector("#gm-co-list-status").textContent = shared.status;
    const find = (id) => shared.items.find((o) => o.id === id);
    list.querySelectorAll(".gm-edit").forEach((el) => {
      el.onclick = () => {
        const o = find(el.dataset.edit);
        if (o) startDraft(o.mode, o);
      };
    });
    list.querySelectorAll(".gm-del").forEach((el) => {
      el.onclick = () => {
        const o = find(el.dataset.del);
        if (o) deleteObject(o);
      };
    });
  }

  function mount(el) {
    root = el;
    const $ = (sel) => el.querySelector(sel);
    $("#gm-co-new").onclick = () => (draft?.mode === "free" ? closeDraft() : startDraft("free"));
    $("#gm-co-skin").onclick = () => (draft?.mode === "skin" ? closeDraft() : startDraft("skin"));
    $("#gm-co-place").onclick = () =>
      pick.current() === "custom-place" ? pick.stop("custom-place") : pick.start(placeSession);
    $("#gm-co-pick").onclick = () =>
      pick.current() === "custom-skin" ? pick.stop("custom-skin") : pick.start(skinSession);
    $("#gm-co-url").addEventListener("change", (e) => setImage(e.target.value.trim()));
    $("#gm-co-upload").onclick = () => $("#gm-co-file").click();
    $("#gm-co-file").onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) uploadImage(file);
    };
    const numbers = { width: "#gm-co-width", height: "#gm-co-height", base: "#gm-co-base" };
    for (const [key, sel] of Object.entries(numbers))
      $(sel).addEventListener("input", (e) => {
        const value = Number(e.target.value);
        if (!draft || !Number.isFinite(value) || value < (key === "base" ? 0 : 0.25) || value > 30)
          return;
        draft.free[key] = value;
        if (draft.free.base > draft.free.height) {
          draft.free.base = draft.free.height;
          $("#gm-co-base").value = draft.free.base;
        }
        renderAll();
      });
    $("#gm-co-layer").onchange = (e) => {
      draft.free.layer = e.target.value;
      renderAll();
      renderEditor();
    };
    $("#gm-co-collision").onchange = (e) => {
      draft.free.collision = e.target.checked;
      renderAll();
    };
    $("#gm-co-opacity").addEventListener("input", (e) => {
      draft.opacity = Number(e.target.value);
      renderAll();
    });
    el.querySelectorAll("#gm-co-editor input, #gm-co-editor select").forEach((input) =>
      input.addEventListener("keydown", (e) => e.stopPropagation()),
    );
    onEnter($("#gm-co-name"), saveDraft);
    $("#gm-co-save").onclick = saveDraft;
    renderEditor();
    renderList();
  }
  pick.onChange(() => renderEditor());

  const layerOptions = Object.entries(LAYERS)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  ctx.section({
    title: "Custom objects",
    html: `
      <div class="gm-sublabel">Your images on the map, seen by everyone with this module</div>
      <div class="gm-row">
        <button class="gm-btn" id="gm-co-new" title="Draw an image anywhere: size, layer, base line and collision like a real object.">New image…</button>
        <button class="gm-btn" id="gm-co-skin" title="Replace the look of a real object with an image: it keeps its collision and seats.">Restyle an object…</button>
      </div>
      <div id="gm-co-editor" style="display:none">
        <div class="gm-status"><span id="gm-co-status"></span></div>
        <div class="gm-row">
          <input class="gm-input" id="gm-co-url" placeholder="Image URL (https)..." />
          <button class="gm-btn" id="gm-co-upload" title="png, jpeg, gif or webp, 512 KB max">Upload</button>
          <input type="file" id="gm-co-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden />
        </div>
        <div data-co-for="free">
          <button class="gm-btn" id="gm-co-place"></button>
          <label class="gm-co-param">Width (tiles)<input class="gm-input" id="gm-co-width" type="number" min="0.25" max="30" step="0.25" /></label>
          <label class="gm-co-param">Height (tiles)<input class="gm-input" id="gm-co-height" type="number" min="0.25" max="30" step="0.25" /></label>
          <label class="gm-co-param">Layer<select class="gm-input" id="gm-co-layer">${layerOptions}</select></label>
          <label class="gm-co-param" id="gm-co-base-row" title="Avatars standing above this line are drawn behind the image, below it in front.">Base line (tiles from the top)<input class="gm-input" id="gm-co-base" type="number" min="0" max="30" step="0.25" /></label>
          <label class="gm-co-param" title="The tiles from the base line down block avatars (for people who have this module).">Collision<input type="checkbox" id="gm-co-collision" /></label>
        </div>
        <div data-co-for="skin">
          <button class="gm-btn" id="gm-co-pick"></button>
        </div>
        <label class="gm-co-param">Opacity<input id="gm-co-opacity" type="range" min="0.1" max="1" step="0.05" /></label>
        <div class="gm-row">
          <input class="gm-input" id="gm-co-name" placeholder="Name this object..." />
          <button class="gm-btn" id="gm-co-save">Save</button>
        </div>
      </div>
      <div class="gm-list" id="gm-co-list"></div>
      <div class="gm-status"><span id="gm-co-list-status"></span></div>`,
    mount,
  });
  ctx.style(`
    #gather-mods-panel .gm-co-param { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; color:var(--gm-muted); }
    #gather-mods-panel .gm-co-param .gm-input { width:110px; flex:none; }
    #gather-mods-panel .gm-co-param input[type=range] { width:110px; }
    #gather-mods-panel .gm-co-mode { font-size:11px; color:var(--gm-muted); }
    #gather-mods-panel .gm-edit { color:var(--gm-muted); font-size:13px; flex-shrink:0; }
    #gather-mods-panel .gm-edit:hover { color:var(--gm-fg); }
    #gather-mods-panel .gm-item.gm-editing { box-shadow:inset 0 0 0 1px var(--theme-color-accent,#6c5ce7); }
  `);

  ctx.onTick(() => {
    const due = Date.now() - shared.syncedAt > SYNC_MS;
    if (map.currentFloorId() !== shared.floorId || (due && !document.hidden)) sync();
    else renderAll();
  });
  sync();
});
