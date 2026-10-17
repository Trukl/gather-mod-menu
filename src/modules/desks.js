// Desks: save and swap your desk decoration (only differing objects change),
// pick which objects belong to your desk, automatic "Previous desk" backup.
window.__gatherMods.define("desks", (ctx) => {
  const { GD, me, escapeHtml, readJson, writeJson, onEnter, flash } = ctx;
  const map = ctx.use("map");
  const pick = ctx.use("map-pick");
  const previews = ctx.use("previews");
  const placements = ctx.use("placements");
  const jobs = ctx.use("jobs");
  const PRESETS_KEY = "gathermodv2:deskPresets";
  const BACKUP_KEY = "gathermodv2:deskBackup";
  const COLOR_DESK = 0xff00ff;
  const POSITION_EPSILON = 1e-6;
  const DEFAULT_AREA = { width: 3, height: 2 };
  const desk = { status: "", keepBackup: false };

  const deskArea = () => GD().Repos.MapEntityIdentifier.get(me().deskId)?.activeMapEntity;
  const trackedKey = () => "gathermodv2:deskObjects:" + me().deskId;
  const getPresets = () => readJson(PRESETS_KEY, []);
  const savePresets = (l) => writeJson(PRESETS_KEY, l);

  // Desk objects default to the area's children; once picked by hand, the
  // tracked references are the source of truth (objects can sit outside the area).
  // Ids tracked before references existed are converted while their map
  // version is the current one, and dropped once it has been replaced.
  function trackedRefs() {
    const tracked = readJson(trackedKey(), null);
    if (!tracked?.some((t) => typeof t === "string")) return tracked;
    const live = map.liveObjects(tracked);
    if (!live.length) {
      localStorage.removeItem(trackedKey());
      return null;
    }
    const refs = live.map(map.objectRef);
    writeJson(trackedKey(), refs);
    return refs;
  }
  function getDeskObjects() {
    const area = deskArea();
    if (!area) return [];
    const refs = trackedRefs();
    return refs ? map.resolveRefs(refs).filter(Boolean) : area.children.filter(map.isLiveObject);
  }
  const setDeskObjects = (objects) => writeJson(trackedKey(), objects.map(map.objectRef));
  function replaceTrackedObject(oldObject, newObject) {
    const refs = trackedRefs();
    if (!refs?.some((r) => r.hash === oldObject.hashIdentifier)) return;
    writeJson(
      trackedKey(),
      refs.map((r) => (r.hash === oldObject.hashIdentifier ? map.objectRef(newObject) : r)),
    );
  }
  const topLevelDeskObjects = () => map.topLevelObjects(getDeskObjects());

  const snapshotOnDesk = (o, area) =>
    map.snapshotObject(
      o,
      o.absolutePosition.x - area.absolutePosition.x,
      o.absolutePosition.y - area.absolutePosition.y,
    );
  function snapshotDesk(name) {
    const area = deskArea();
    return {
      name,
      items: topLevelDeskObjects().map((o) => snapshotOnDesk(o, area)),
      area: { width: area.dimensionsInTiles.width, height: area.dimensionsInTiles.height },
    };
  }

  function sameItem(a, b) {
    if (
      a.variant !== b.variant ||
      Math.abs(a.x - b.x) > POSITION_EPSILON ||
      Math.abs(a.y - b.y) > POSITION_EPSILON ||
      a.children.length !== b.children.length
    )
      return false;
    const unmatched = [...b.children];
    return a.children.every((child) => {
      const i = unmatched.findIndex((c) => sameItem(child, c));
      if (i === -1) return false;
      unmatched.splice(i, 1);
      return true;
    });
  }

  // Picking another desk stops the one being applied. The backup is only
  // taken before the first one, so "Previous desk" never holds a half-applied desk.
  function applyPreset(preset) {
    desk.status = `Applying "${preset.name}"…`;
    renderStatus();
    jobs.run("desks", (signal) => applyPresetNow(preset, signal), { replace: true });
  }

  async function applyPresetNow(preset, signal) {
    const area = deskArea();
    if (!area) return;
    const createdIds = [];
    const kept = [];
    const extra = [];
    const created = [];
    try {
      if (!desk.keepBackup) writeJson(BACKUP_KEY, snapshotDesk("Previous desk"));
      desk.keepBackup = false;
      const missing = [...preset.items];
      for (const o of topLevelDeskObjects()) {
        const i = missing.findIndex((item) => sameItem(item, snapshotOnDesk(o, area)));
        if (i === -1) extra.push(o);
        else {
          kept.push(o);
          missing.splice(i, 1);
        }
      }
      for (const o of extra) {
        if (signal.aborted) break;
        await o.delete();
      }
      for (const item of missing) {
        if (signal.aborted) break;
        created.push(await map.createObject(item, area, createdIds));
      }
      if (signal.aborted) {
        desk.keepBackup = true;
        return;
      }
      const summary = `Kept ${kept.length}, removed ${extra.length}, added ${missing.length}`;
      desk.status = summary;
      setTimeout(() => {
        if (desk.status !== summary) return;
        desk.status = "";
        renderStatus();
      }, 4000);
    } catch (e) {
      console.error("[GatherMods] desk preset apply failed", e);
      desk.status = "Failed: " + (e?.message || e);
    } finally {
      setDeskObjects(
        map.liveObjects([...kept, ...extra, ...created.filter(Boolean)].map((o) => o.id)),
      );
      placements.record({ source: "desk preset", name: preset.name, ids: createdIds });
      renderStatus();
      renderList();
      pick.redraw();
    }
  }

  function cleanDesk(p) {
    if (typeof p?.name !== "string" || !Array.isArray(p.items)) return null;
    const items = p.items.map(map.cleanItem);
    if (items.includes(null)) return null;
    const valid = (n) => Number.isFinite(n) && n > 0 && n <= 50;
    return valid(p.area?.width) && valid(p.area?.height)
      ? { name: p.name, items, area: { width: p.area.width, height: p.area.height } }
      : { name: p.name, items };
  }
  const deskPreview = (p) => previews.layoutPreviewHtml(p.items, p.area ?? DEFAULT_AREA);

  const deskSession = {
    id: "desk",
    outlines: () => [[getDeskObjects(), COLOR_DESK]],
    onPick(o) {
      const objects = getDeskObjects();
      setDeskObjects(
        objects.some((x) => x.id === o.id) ? objects.filter((x) => x.id !== o.id) : [...objects, o],
      );
      renderStatus();
    },
    onBox(objects) {
      setDeskObjects(
        map.liveObjects(
          map.toggleIds(
            getDeskObjects().map((o) => o.id),
            objects,
          ),
        ),
      );
      renderStatus();
    },
  };

  let root = null;
  function renderStatus() {
    if (!root?.isConnected) return;
    const note = root.querySelector("#gm-desk-status");
    note.textContent = desk.status;
    note.parentElement.classList.toggle("gm-err", desk.status.startsWith("Failed"));
    const count = root.querySelector("#gm-desk-count");
    if (!deskArea()) count.textContent = "No desk";
    else {
      const objects = getDeskObjects();
      count.textContent = objects.length + " objects on your desk";
      count.title = objects.map(map.objectName).join(", ");
    }
  }
  function renderPickButton() {
    if (!root?.isConnected) return;
    root.querySelector("#gm-desk-pick").checked = pick.current() === "desk";
  }
  function renderList() {
    if (!root?.isConnected) return;
    const list = root.querySelector("#gm-desks");
    const hub = ctx.use("hub");
    const backup = readJson(BACKUP_KEY, null);
    const summary = (p) => escapeHtml(p.items.map((i) => i.name).join(", "));
    const backupRow = backup
      ? `<div class="gm-item" data-backup="1" title="${summary(backup)}"><i class="gm-i" data-i="undo-2"></i><div class="gm-item-text"><span class="gm-item-title">Previous desk</span></div><span class="gm-tail">Backup</span></div>`
      : "";
    const savedRows = getPresets().map(
      (p, i) =>
        `<div class="gm-item" data-idx="${i}" title="${summary(p)}"><i class="gm-i" data-i="lamp-desk"></i><div class="gm-item-text"><span class="gm-item-title">${escapeHtml(p.name)}</span></div><div class="gm-actions">${hub ? `<button class="gm-iconbtn gm-pub" data-pub="${i}" title="Publish to the community hub"><i class="gm-i" data-i="upload"></i></button>` : ""}<button class="gm-iconbtn gm-danger gm-desk-del" data-del="${i}" title="Delete"><i class="gm-i" data-i="trash-2"></i></button></div></div>`,
    );
    previews.hidePopover();
    list.innerHTML = backupRow + savedRows.join("") || '<div class="gm-empty">No saved desks</div>';
    const presetOf = (row) =>
      row.dataset.backup ? readJson(BACKUP_KEY, null) : getPresets()[+row.dataset.idx];
    list.querySelectorAll(".gm-item").forEach((row) => {
      previews.attachPopover(
        row,
        () => {
          const preset = presetOf(row);
          return preset ? deskPreview(preset) : "";
        },
        true,
      );
      row.onclick = () => {
        const preset = presetOf(row);
        if (preset) applyPreset(preset);
      };
    });
    list.querySelectorAll(".gm-desk-del").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        const l = getPresets();
        l.splice(+d.dataset.del, 1);
        savePresets(l);
        renderList();
      };
    });
    list.querySelectorAll(".gm-pub").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        hub?.publish("desk", getPresets()[+b.dataset.pub]);
      };
    });
  }

  ctx.registerPresetType({
    type: "desk",
    key: "desks",
    label: "Desks",
    list: getPresets,
    save: savePresets,
    clean: cleanDesk,
    preview: deskPreview,
    needsCatalog: true,
    onChange: renderList,
  });

  pick.onChange(renderPickButton);
  ctx.onTick(renderStatus);
  ctx.section({
    title: "Desks",
    status: () => (pick.current() === "desk" ? "Picking" : null),
    html: `
      <label class="gm-toggle" title="Click objects, or drag a box around them, to add or remove them from your desk. Esc to stop.">
        <span class="gm-toggle-text"><span class="gm-toggle-title">Pick desk objects</span><span class="gm-hint"><span id="gm-desk-count"></span> · <span class="gm-link" id="gm-desk-reset" title="Track the objects inside the desk area again">Reset</span></span></span>
        <input type="checkbox" class="gm-switch" id="gm-desk-pick" />
      </label>
      <div class="gm-field">
        <input class="gm-input" id="gm-desk-name" placeholder="Name this desk" />
        <button class="gm-btn gm-primary gm-sm" id="gm-desk-save">Save</button>
      </div>
      <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span id="gm-desk-status"></span></div>
      <div class="gm-list" id="gm-desks"></div>`,
    mount(el) {
      root = el;
      el.querySelector("#gm-desk-pick").onchange = (e) =>
        e.target.checked ? pick.start(deskSession) : pick.stop("desk");
      el.querySelector("#gm-desk-reset").onclick = (e) => {
        e.preventDefault();
        localStorage.removeItem(trackedKey());
        pick.redraw();
        renderStatus();
      };
      const input = el.querySelector("#gm-desk-name");
      const saveBtn = el.querySelector("#gm-desk-save");
      const save = () => {
        const name = input.value.trim();
        if (!name) return;
        if (!deskArea()) return flash(saveBtn, "No desk");
        savePresets([...getPresets(), snapshotDesk(name)]);
        input.value = "";
        renderList();
      };
      onEnter(input, save);
      saveBtn.onclick = save;
      renderPickButton();
      renderStatus();
      renderList();
    },
  });

  return { replaceTrackedObject };
});
