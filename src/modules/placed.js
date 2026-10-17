// Placed objects: everything the mod placed on this map (constructions, desk
// presets, Place on…), to delete the last placement, any of them, or all.
window.__gatherMods.define("placed", (ctx) => {
  const { escapeHtml } = ctx;
  const map = ctx.use("map");
  const placements = ctx.use("placements");
  const jobs = ctx.use("jobs");
  const { TILE_PX } = map;
  const HIGHLIGHT_COLOR = 0xff3b30;
  const state = { status: "", confirmAll: false };
  let highlight = null;

  const describe = (e) => {
    const count = placements.liveIds(e).length;
    const time = e.at
      ? new Date(e.at).toLocaleString([], {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const kind = e.source.charAt(0).toUpperCase() + e.source.slice(1);
    return `${kind} · ${count} object${count > 1 ? "s" : ""}${time ? " · " + time : ""}`;
  };

  function drawHighlight(entries) {
    highlight?.destroy();
    highlight = null;
    if (entries.length) {
      const g = map.scene().add.graphics().setDepth(1e9);
      g.lineStyle(1, HIGHLIGHT_COLOR, 1);
      for (const o of map.liveObjects(entries.flatMap(placements.liveIds))) {
        const tl = o.topLeftAbsolutePosition;
        const d = o.getDimensionsInTiles();
        g.strokeRect(tl.x * TILE_PX, tl.y * TILE_PX, d.width * TILE_PX, d.height * TILE_PX);
      }
      highlight = g;
    }
    map.requestRender();
  }
  // The outline always reflects what is hovered ("last" button or a list entry);
  // re-rendering the list never fires mouseleave, so render() refreshes it too.
  // While "Delete all" waits for confirmation, everything stays outlined.
  let hovered = null;
  const keyOf = (e) => `${e.at}|${e.refs[0]?.hash}`;
  function refreshHighlight(entries = placements.list()) {
    const shown =
      hovered === "last" ? entries.slice(0, 1) : entries.filter((e) => keyOf(e) === hovered);
    if (!shown.length) hovered = null;
    drawHighlight(shown.length ? shown : state.confirmAll ? entries : []);
  }
  const hover = (key) => {
    hovered = key;
    refreshHighlight();
  };
  ctx.onCleanup(() => {
    state.confirmAll = false;
    hovered = null;
    drawHighlight([]);
  });

  // Targets are resolved when the job runs, so "delete last" follows the jobs queued before it.
  function remove(targetsOf, labelOf) {
    state.confirmAll = false;
    hovered = null;
    drawHighlight([]);
    jobs.run("placed", async () => {
      const targets = targetsOf();
      if (!targets.length) return;
      const name = labelOf(targets);
      state.status = `Deleting ${name}…`;
      render();
      try {
        const n = await placements.deleteEntries(targets);
        state.status = `Deleted ${name} (${n} object${n > 1 ? "s" : ""})`;
      } catch (e) {
        console.error("[GatherMods] delete placed objects failed", e);
        state.status = "Delete failed: " + (e?.message || e);
      }
    });
  }

  let root = null;
  function render() {
    if (!root?.isConnected) return;
    const entries = placements.list();
    const last = root.querySelector("#gm-placed-last");
    last.style.display = entries.length ? "" : "none";
    if (entries.length)
      last.innerHTML = `<i class="gm-i" data-i="undo-2"></i><span>Remove last: ${escapeHtml(entries[0].name)}</span>`;
    root.querySelector("#gm-placed-status").textContent =
      state.status + (jobs.busy("placed") ? jobs.queuedSuffix("placed") : "");
    root.querySelector("#gm-placed-head").style.display = entries.length ? "" : "none";
    root.querySelector("#gm-placed-all").style.display =
      entries.length > 1 && !state.confirmAll ? "" : "none";
    const confirmBox = root.querySelector("#gm-placed-confirm");
    if (state.confirmAll && !entries.length) state.confirmAll = false;
    confirmBox.style.display = state.confirmAll ? "" : "none";
    if (state.confirmAll) {
      const count = entries.reduce((n, e) => n + placements.liveIds(e).length, 0);
      confirmBox.querySelector(".gm-confirm-text").textContent =
        `Delete the ${count} objects outlined in red (${entries.length} placements, listed below)?`;
      confirmBox.querySelector("#gm-placed-confirm-yes").textContent = `Delete ${count}`;
    }
    const list = root.querySelector("#gm-placed-list");
    list.innerHTML = entries.length
      ? entries
          .map(
            (e, i) =>
              `<div class="gm-item" data-idx="${i}" title="Hover to see the objects on the map"><div class="gm-item-text"><span class="gm-item-title">${escapeHtml(e.name)}</span><span class="gm-item-meta">${escapeHtml(describe(e))}</span></div><div class="gm-actions"><button class="gm-iconbtn gm-danger" data-del="${i}" title="Delete these objects"><i class="gm-i" data-i="trash-2"></i></button></div></div>`,
          )
          .join("")
      : '<div class="gm-empty">Nothing placed with the mod on this map</div>';
    list.querySelectorAll(".gm-item").forEach((row) => {
      const entry = entries[+row.dataset.idx];
      row.addEventListener("mouseenter", () => hover(keyOf(entry)));
      row.addEventListener("mouseleave", () => hover(null));
    });
    list.querySelectorAll("[data-del]").forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        const entry = entries[+d.dataset.del];
        remove(
          () => [entry],
          () => `"${entry.name}"`,
        );
      };
    });
    refreshHighlight(entries);
  }
  placements.onChange(render);
  jobs.onChange(render);

  ctx.section({
    title: "Placed objects",
    html: `
      <button class="gm-btn gm-block" id="gm-placed-last" title="Delete the objects of the last placement made with the mod on this map"></button>
      <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span id="gm-placed-status"></span></div>
      <div class="gm-card gm-confirm" id="gm-placed-confirm"><span class="gm-confirm-text"></span>
        <div class="gm-btn-row"><button class="gm-btn gm-sm" id="gm-placed-confirm-no">Cancel</button><button class="gm-btn gm-sm gm-danger gm-solid" id="gm-placed-confirm-yes"></button></div>
      </div>
      <div class="gm-sub" id="gm-placed-head">On this map<span class="gm-spacer"></span><span class="gm-link gm-danger" id="gm-placed-all" title="Outline everything that would be deleted, then confirm">Delete all…</span></div>
      <div class="gm-list" id="gm-placed-list"></div>`,
    mount(el) {
      root = el;
      const lastBtn = el.querySelector("#gm-placed-last");
      lastBtn.onclick = () =>
        remove(
          () => placements.list().slice(0, 1),
          ([last]) => `"${last.name}"`,
        );
      lastBtn.addEventListener("mouseenter", () => hover("last"));
      lastBtn.addEventListener("mouseleave", () => hover(null));
      el.querySelector("#gm-placed-all").onclick = () => {
        state.confirmAll = true;
        state.status = "";
        render();
      };
      el.querySelector("#gm-placed-confirm-no").onclick = () => {
        state.confirmAll = false;
        render();
      };
      el.querySelector("#gm-placed-confirm-yes").onclick = () => {
        const all = placements.list();
        remove(
          () => all,
          () => "everything",
        );
      };
      render();
    },
  });
});
