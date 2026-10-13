// Gather Mods core: module registry, sidebar panel, settings and launcher bridge.
// Libraries and modules are evaluated right after this file and register with
// window.__gatherMods.define(id, setup); setup(ctx) runs once Gather is ready.
(() => {
  "use strict";

  try {
    window.__gatherMods?.teardown();
  } catch (e) {
    console.error("[GatherMods] previous teardown failed", e);
  }
  try {
    window.__gatherModV2Cleanup?.();
  } catch {}
  delete window.__gatherModV2Cleanup;
  clearTimeout(window.__gatherModV2Wait);
  document.getElementById("gather-mod-menu-v2")?.remove();

  const STORAGE_PREFIX = "gathermodv2:";
  const SECTIONS_KEY = STORAGE_PREFIX + "sections";
  const PANEL_COLLAPSED_KEY = STORAGE_PREFIX + "collapsed";
  const DISABLED_MODULES_KEY = STORAGE_PREFIX + "disabledModules";
  const SEEN_MODULES_KEY = STORAGE_PREFIX + "seenModules";
  const KNOWN_VERSIONS_KEY = STORAGE_PREFIX + "knownVersions";
  const PREVIOUS_VERSIONS_KEY = STORAGE_PREFIX + "previousVersions";
  const HIDDEN_PARTS_KEY = STORAGE_PREFIX + "hiddenParts";
  const HUB_URL_KEY = STORAGE_PREFIX + "hubUrl";
  const INSTALL_ID_KEY = STORAGE_PREFIX + "installId";
  const REPORTED_INSTALL_KEY = STORAGE_PREFIX + "reportedInstall";
  const DEFAULT_HUB_URL = "https://gather-mods-hub.minnecorentin.workers.dev";
  const REPORT_RETRY_MS = 10 * 60_000;
  const REOPEN_SETTINGS_KEY = "gathermods:reopenSettings";
  const STYLE_ID = "gather-mods-style";
  const TICK_MS = 2000;

  const defs = [];
  let installed = null;
  let waitTimer = setTimeout(start, 0);

  const registry = {
    bundleCatalog: null,
    define(id, setup) {
      defs.push({ id, setup });
    },
    teardown,
    reload() {
      teardown();
      waitTimer = setTimeout(start, 0);
    },
  };
  window.__gatherMods = registry;

  // ===================
  // Engine helpers
  // ===================
  const GD = () => window.gatherDev;
  const MC = () => GD().MoveController;
  const PM = () => GD().PlayerManager;
  const me = () => GD().Repos.gameSpace.currentSpaceUser;
  const allUsers = () =>
    Object.values(PM().users)
      .map((u) => u.spaceUser)
      .filter(Boolean);
  function tpTo(x, y, floorId) {
    const Position = me().originalPosition.constructor;
    MC().setPathMoveTo(new Position(x, y, floorId || me().floorId), { forceTeleport: true });
  }
  function gameReady() {
    try {
      return !!GD()?.Repos?.gameSpace?.currentSpaceUser?.originalPosition;
    } catch {
      return false;
    }
  }

  const escapeHtml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const changeClass = (change) => (/^Removed:/i.test(change) ? "gm-change-removed" : "");
  const readJson = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  function onEnter(input, fn) {
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") fn();
    });
  }
  function flash(button, text, ms = 1500) {
    const previous = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = previous), ms);
  }
  const formatTime = (iso) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const formatDate = (iso) =>
    iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—";
  const shortCommit = (sha) => (sha ? sha.slice(0, 7) : "—");
  function isNewerVersion(candidate, current) {
    const a = candidate.split(".").map(Number);
    const b = current.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return false;
  }

  // ===================
  // Theme — follow Gather (light/dark) via the sidebar's text luminance and
  // reuse its accent color; surfaces are translucent so both themes match.
  // ===================
  function findSidebar() {
    const search = document.querySelector('input[data-testid="gather-chat-search-input"]');
    for (let el = search; el; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.height > 600 && r.width < 360) return el;
    }
    return null;
  }
  function isDarkTheme() {
    if (window.__gmForceTheme === "light") return false;
    if (window.__gmForceTheme === "dark") return true;
    const m = (getComputedStyle(findSidebar() || document.body).color || "").match(/\d+(\.\d+)?/g);
    if (!m) return true;
    const [r, g, b] = m.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
  }
  function applyTheme(el) {
    const dark = isDarkTheme();
    const s = el.style;
    s.setProperty("--gm-fg", dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.85)");
    s.setProperty("--gm-muted", dark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.5)");
    s.setProperty("--gm-surface", dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)");
    s.setProperty("--gm-surface-hover", dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.09)");
    s.setProperty("--gm-input", dark ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.05)");
    s.setProperty("--gm-border", dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)");
    s.setProperty("--gm-bg", dark ? "#1f1f23" : "#ffffff");
    s.setProperty("--gm-green", dark ? "#3ddc84" : "#1e8e4e");
    s.setProperty("--gm-red", dark ? "#ff6b6b" : "#d93636");
  }

  // ===================
  // Modal
  // ===================
  function onModalKey(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    closeModal();
  }
  function closeModal() {
    document.removeEventListener("keydown", onModalKey, true);
    document.getElementById("gather-mods-modal")?.remove();
  }
  function openModal(title, bodyHtml, modalClass = "") {
    closeModal();
    const modal = document.createElement("div");
    modal.id = "gather-mods-modal";
    modal.innerHTML = `
      <div class="gm-modal ${modalClass}" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="gm-modal-head"><h3>${escapeHtml(title)}</h3><span class="gm-close" id="gm-modal-close">✕</span></div>
        ${bodyHtml}
      </div>`;
    applyTheme(modal);
    document.body.appendChild(modal);
    document.addEventListener("keydown", onModalKey, true);
    for (const type of ["keydown", "keyup", "keypress"])
      modal.addEventListener(type, (e) => e.stopPropagation());
    modal.addEventListener("mousedown", (e) => {
      if (e.target === modal) closeModal();
    });
    modal.querySelector("#gm-modal-close").onclick = closeModal;
    return modal;
  }

  // ===================
  // Launcher bridge — the desktop launcher exposes window.gatherModsLauncher
  // (CDP binding) and pushes its state in window.__gatherModsLauncherState.
  // ===================
  const launcherState = () => window.__gatherModsLauncherState ?? null;
  const hasLauncher = () => !!launcherState() && typeof window.gatherModsLauncher === "function";
  const sendToLauncher = (message) =>
    hasLauncher() && window.gatherModsLauncher(JSON.stringify(message));
  const LAUNCHER_PING_MS = 3000;
  let launcherLost = false;
  let launcherPing = null;
  let showChangelogHistory = false;
  let pendingInstall = null;
  const expandedChangelogs = new Set();
  // Launchers before protocol 2 ignore get-state: never ping them.
  function pingLauncher() {
    if (!hasLauncher() || !(launcherState().protocol >= 2)) return;
    clearTimeout(launcherPing);
    launcherPing = setTimeout(() => {
      launcherLost = true;
      renderSettings();
    }, LAUNCHER_PING_MS);
    sendToLauncher({ type: "get-state" });
  }

  const catalog = () => launcherState()?.catalog ?? registry.bundleCatalog;
  const catalogModules = () => catalog()?.modules ?? [];
  const userModules = () => catalogModules().filter((m) => m.kind === "module");
  const installedVersion = (id) =>
    hasLauncher()
      ? launcherState().installed?.[id]?.version
      : id === "core" || installed?.apis.has(id)
        ? catalogModules().find((m) => m.id === id)?.version
        : undefined;
  const pendingUpdates = () => (hasLauncher() ? (launcherState().pending ?? []) : []);
  function selectedModules() {
    if (hasLauncher()) return launcherState().selected ?? [];
    const disabled = readJson(DISABLED_MODULES_KEY, []);
    return userModules()
      .map((m) => m.id)
      .filter((id) => !disabled.includes(id));
  }
  function seenModules() {
    const seen = readJson(SEEN_MODULES_KEY, null);
    if (seen || !userModules().length) return seen ?? [];
    const all = userModules().map((m) => m.id);
    writeJson(SEEN_MODULES_KEY, all);
    return all;
  }
  const unseenModules = () => {
    const seen = seenModules();
    return userModules().filter((m) => !seen.includes(m.id));
  };
  function trackInstalledVersions() {
    const known = readJson(KNOWN_VERSIONS_KEY, {});
    const previous = readJson(PREVIOUS_VERSIONS_KEY, {});
    for (const m of catalogModules()) {
      const version = installedVersion(m.id);
      if (!version) continue;
      if (known[m.id] && isNewerVersion(version, known[m.id])) previous[m.id] = known[m.id];
      known[m.id] = version;
    }
    writeJson(KNOWN_VERSIONS_KEY, known);
    writeJson(PREVIOUS_VERSIONS_KEY, previous);
    reportInstall();
  }

  // ===================
  // Community hub access, shared by the core (install reports) and hub-api
  // ===================
  const hubUrl = () => localStorage.getItem(HUB_URL_KEY) || DEFAULT_HUB_URL;
  // Firebase keeps the signed-in user, with an ID token it refreshes, in IndexedDB.
  async function gatherIdToken() {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("firebaseLocalStorageDb");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const rows = await new Promise((resolve, reject) => {
        const read = db
          .transaction("firebaseLocalStorage")
          .objectStore("firebaseLocalStorage")
          .getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      const user = rows.find((r) => String(r.fbase_key).startsWith("firebase:authUser:"))?.value;
      return user?.stsTokenManager?.accessToken ?? null;
    } finally {
      db.close();
    }
  }

  // Tells the hub which versions this install runs, on first install and after
  // each update, so the author knows how many installs run which version.
  let reportRetryAt = 0;
  async function reportInstall() {
    const versions = Object.fromEntries(
      catalogModules()
        .map((m) => [m.id, installedVersion(m.id)])
        .filter(([, version]) => version),
    );
    const report = JSON.stringify({ versions, launcher: hasLauncher() });
    if (!versions.core || localStorage.getItem(REPORTED_INSTALL_KEY) === report) return;
    if (Date.now() < reportRetryAt) return;
    reportRetryAt = Date.now() + REPORT_RETRY_MS;
    try {
      const gatherToken = await gatherIdToken();
      if (!gatherToken) return;
      if (!localStorage.getItem(INSTALL_ID_KEY))
        localStorage.setItem(INSTALL_ID_KEY, crypto.randomUUID());
      const r = await fetch(hubUrl() + "/installs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gatherToken,
          installId: localStorage.getItem(INSTALL_ID_KEY),
          ...JSON.parse(report),
        }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      localStorage.setItem(REPORTED_INSTALL_KEY, report);
    } catch (e) {
      console.warn("[GatherMods] install report failed", e);
    }
  }

  function requiredClosure(ids) {
    const byId = new Map(catalogModules().map((m) => [m.id, m]));
    const needed = new Set(["core"]);
    const visit = (id) => {
      if (needed.has(id)) return;
      needed.add(id);
      for (const dep of Object.keys(byId.get(id)?.requires ?? {})) visit(dep);
    };
    ids.forEach(visit);
    return needed;
  }
  function setModuleSelected(id, on) {
    const selected = new Set(selectedModules());
    if (on) selected.add(id);
    else selected.delete(id);
    sessionStorage.setItem(REOPEN_SETTINGS_KEY, "1");
    if (hasLauncher()) {
      sendToLauncher({ type: "set-modules", modules: [...selected] });
      return;
    }
    writeJson(
      DISABLED_MODULES_KEY,
      userModules()
        .map((m) => m.id)
        .filter((m) => !selected.has(m)),
    );
    registry.reload();
  }

  // A hidden part of a module is hidden in the panel and turned off by the
  // module (it reads isPartHidden on start), hence the reload.
  const hiddenParts = (moduleId) => readJson(HIDDEN_PARTS_KEY, {})[moduleId] ?? [];
  function setPartHidden(moduleId, part, hide) {
    const all = readJson(HIDDEN_PARTS_KEY, {});
    const rest = (all[moduleId] ?? []).filter((p) => p !== part);
    all[moduleId] = hide ? [...rest, part] : rest;
    writeJson(HIDDEN_PARTS_KEY, all);
    sessionStorage.setItem(REOPEN_SETTINGS_KEY, "1");
    registry.reload();
  }

  // ===================
  // Install / teardown
  // ===================
  function start() {
    if (!gameReady()) {
      waitTimer = setTimeout(start, 1000);
      return;
    }
    install();
  }

  function install() {
    const state = {
      apis: new Map(),
      sections: [],
      styles: [],
      tickers: [],
      cleanups: [],
      presetTypes: [],
      tick: null,
    };
    installed = state;
    const enabled =
      hasLauncher() || !registry.bundleCatalog ? null : requiredClosure(selectedModules());
    for (const def of defs) {
      if (def.id === "core" || (enabled && !enabled.has(def.id))) continue;
      try {
        state.apis.set(def.id, def.setup(makeContext(def.id, state)) ?? {});
      } catch (e) {
        console.error(`[GatherMods] module "${def.id}" failed to start`, e);
      }
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [CORE_CSS, ...state.styles].join("\n");
    document.head.appendChild(style);
    ensurePanel();
    trackInstalledVersions();
    window.addEventListener("gathermods:launcher-state", onLauncherState);
    window.addEventListener("gathermods:launcher-diff", renderReviewDiff);
    state.tick = setInterval(() => {
      ensurePanel();
      const panel = document.getElementById("gather-mods-panel");
      if (panel) applyTheme(panel);
      for (const fn of state.tickers) runSafely(fn);
    }, TICK_MS);
    if (sessionStorage.getItem(REOPEN_SETTINGS_KEY)) {
      sessionStorage.removeItem(REOPEN_SETTINGS_KEY);
      openSettingsModal();
    }
    console.log(`[GatherMods] installed: ${[...state.apis.keys()].join(", ") || "core only"}`);
  }

  function teardown() {
    clearTimeout(waitTimer);
    const state = installed;
    installed = null;
    if (!state) return;
    clearInterval(state.tick);
    clearTimeout(launcherPing);
    for (const fn of [...state.cleanups].reverse()) runSafely(fn);
    window.removeEventListener("gathermods:launcher-state", onLauncherState);
    window.removeEventListener("gathermods:launcher-diff", renderReviewDiff);
    document.getElementById("gather-mods-panel")?.remove();
    document.getElementById(STYLE_ID)?.remove();
    closeModal();
  }

  function runSafely(fn) {
    try {
      fn();
    } catch (e) {
      console.error("[GatherMods]", e);
    }
  }

  function makeContext(id, state) {
    return {
      id,
      GD,
      MC,
      PM,
      me,
      allUsers,
      tpTo,
      escapeHtml,
      readJson,
      writeJson,
      onEnter,
      flash,
      applyTheme,
      openModal,
      closeModal,
      hubUrl,
      gatherIdToken,
      panel: () => document.getElementById("gather-mods-panel"),
      use: (dep) => state.apis.get(dep),
      has: (dep) => state.apis.has(dep),
      style: (css) => state.styles.push(css),
      section: (spec) => state.sections.push({ id, ...spec }),
      isPartHidden: (part) => hiddenParts(id).includes(part),
      onTick: (fn) => state.tickers.push(fn),
      onCleanup: (fn) => state.cleanups.push(fn),
      registerPresetType: (type) => state.presetTypes.push(type),
      presetTypes: () => state.presetTypes,
      presetType: (type) => state.presetTypes.find((t) => t.type === type),
      addPresets(type, incoming) {
        const preset = state.presetTypes.find((t) => t.type === type);
        if (!preset) return 0;
        const current = preset.list();
        const seen = new Set(current.map((p) => JSON.stringify(p)));
        const added = incoming.map(preset.clean).filter((p) => p && !seen.has(JSON.stringify(p)));
        if (added.length) {
          preset.save(current.concat(added));
          preset.onChange?.();
        }
        return added.length;
      },
    };
  }

  // ===================
  // Panel
  // ===================
  const getCollapsed = () => readJson(SECTIONS_KEY, {}).collapsed ?? [];
  function setCollapsed(collapsed) {
    writeJson(SECTIONS_KEY, { ...readJson(SECTIONS_KEY, {}), collapsed });
    document.querySelectorAll("#gather-mods-panel .gm-section").forEach((el) => {
      el.classList.toggle("collapsed", collapsed.includes(el.dataset.section));
    });
  }

  function ensurePanel() {
    if (!installed || document.getElementById("gather-mods-panel")) return;
    const sidebar = findSidebar();
    if (!sidebar) return;
    const panel = document.createElement("div");
    panel.id = "gather-mods-panel";
    if (localStorage.getItem(PANEL_COLLAPSED_KEY) === "true") panel.classList.add("collapsed");
    const collapsed = getCollapsed();
    panel.innerHTML = `
      <div class="gm-head" id="gm-head">
        <h4>🛠️ Mods<span class="gm-update-dot" id="gm-update-dot" title="Updates or new modules available"></span></h4>
        <span class="gm-head-actions"><span class="gm-cog" id="gm-settings-toggle" title="Settings">⚙</span><span class="gm-chevron">▾</span></span>
      </div>
      <div class="gm-body">
        ${
          installed.sections
            .map(
              (s) => `
          <section class="gm-section${collapsed.includes(s.id) ? " collapsed" : ""}" data-section="${s.id}">
            <div class="gm-section-head"><div class="gm-label">${escapeHtml(s.title)}</div><span class="gm-chevron">▾</span></div>
            <div class="gm-section-body">${s.html}</div>
          </section>`,
            )
            .join("") ||
          '<div class="gm-empty">No module installed. Open ⚙ to choose modules.</div>'
        }
      </div>`;
    applyTheme(panel);
    sidebar.insertBefore(panel, sidebar.children[sidebar.children.length - 1] || null);
    panel.querySelector("#gm-head").onclick = () => {
      panel.classList.toggle("collapsed");
      localStorage.setItem(PANEL_COLLAPSED_KEY, panel.classList.contains("collapsed"));
    };
    panel.querySelector("#gm-settings-toggle").onclick = (e) => {
      e.stopPropagation();
      openSettingsModal();
    };
    panel.querySelectorAll(".gm-section-head").forEach((head) => {
      head.onclick = () => {
        const id = head.parentElement.dataset.section;
        const current = getCollapsed();
        setCollapsed(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
      };
    });
    for (const s of installed.sections) {
      const body = panel.querySelector(`[data-section="${s.id}"] .gm-section-body`);
      const hidden = hiddenParts(s.id);
      body.querySelectorAll("[data-part]").forEach((el) => {
        if (hidden.includes(el.dataset.part)) el.style.display = "none";
      });
      runSafely(() => s.mount?.(body));
    }
    renderUpdateDot();
  }

  function renderUpdateDot() {
    document
      .getElementById("gm-update-dot")
      ?.classList.toggle("visible", pendingUpdates().length > 0 || unseenModules().length > 0);
  }

  function onLauncherState() {
    clearTimeout(launcherPing);
    launcherLost = false;
    trackInstalledVersions();
    renderUpdateDot();
    if (document.getElementById("gm-settings-modules")) renderSettings();
  }

  // ===================
  // Settings
  // ===================
  function openSettingsModal() {
    const modal = openModal(
      "Mod settings",
      `
      <div class="gm-settings-body">
        <section class="gm-settings-group">
          <h4>Modules</h4>
          <p class="gm-hint">Pick the features you want: only the code of installed modules runs in Gather and gets updated. Uninstalling a module keeps its data (presets, saved locations…). In the panel, click a section title to fold it.</p>
          <div id="gm-settings-modules"></div>
          <div class="gm-row gm-settings-actions">
            <button class="gm-btn" id="gm-expand-all">Unfold all</button>
            <button class="gm-btn" id="gm-collapse-all">Fold all</button>
          </div>
          <p class="gm-hint" id="gm-modules-message"></p>
        </section>
        <section class="gm-settings-group">
          <h4>What's new</h4>
          <div id="gm-settings-changelog"></div>
        </section>
        <section class="gm-settings-group">
          <h4>Updates</h4>
          <p class="gm-hint">When Gather is opened with “Gather Mods.app”, the launcher checks every 15 minutes for new module versions, and only accepts code signed by the GitHub release workflow of the repo’s main branch.</p>
          <div id="gm-update-info"></div>
          <label class="gm-setting" id="gm-auto-update-row">
            <span class="gm-setting-text">Automatic updates<span>Install new versions of your modules as soon as they are published, without restarting Gather. When off, updates are announced here and in the panel header (dot), and you review and install them yourself. New modules are never installed automatically.</span></span>
            <input type="checkbox" class="gm-switch" id="gm-auto-update" />
          </label>
          <div class="gm-row gm-settings-actions" id="gm-update-actions">
            <button class="gm-btn" id="gm-check-update">Check now</button>
            <button class="gm-btn" id="gm-review-update"></button>
          </div>
          <p class="gm-hint" id="gm-update-message"></p>
        </section>
      </div>`,
      "gm-modal-settings",
    );
    modal.querySelector("#gm-expand-all").onclick = () => setCollapsed([]);
    modal.querySelector("#gm-collapse-all").onclick = () =>
      setCollapsed(installed?.sections.map((s) => s.id) ?? []);
    modal.querySelector("#gm-auto-update").onchange = (e) =>
      sendToLauncher({ type: "set-auto-update", value: e.target.checked });
    modal.querySelector("#gm-check-update").onclick = () => {
      sendToLauncher({ type: "check-now" });
      modal.querySelector("#gm-update-message").textContent = "Checking…";
    };
    modal.querySelector("#gm-review-update").onclick = openReviewModal;
    showChangelogHistory = false;
    pendingInstall = null;
    expandedChangelogs.clear();
    renderSettings();
    pingLauncher();
    writeJson(SEEN_MODULES_KEY, [
      ...new Set([...seenModules(), ...userModules().map((m) => m.id)]),
    ]);
    renderUpdateDot();
  }

  function renderSettings() {
    renderModuleList();
    renderChangelog();
    renderUpdateInfo();
  }

  function renderModuleList() {
    const list = document.getElementById("gm-settings-modules");
    if (!list) return;
    const modules = userModules();
    if (!modules.length) {
      list.innerHTML =
        '<div class="gm-empty">Module list unavailable (launcher not connected and no bundled catalog).</div>';
      return;
    }
    const selected = selectedModules();
    const unseen = unseenModules().map((m) => m.id);
    const pending = new Map(pendingUpdates().map((p) => [p.id, p]));
    const removed = hasLauncher() ? (launcherState().removed ?? []) : [];
    const hiddenAll = readJson(HIDDEN_PARTS_KEY, {});
    const nameOf = (id) => catalogModules().find((m) => m.id === id)?.name ?? id;
    const changesHtml = (changes) =>
      `<ul>${(changes ?? []).map((c) => `<li class="${changeClass(c)}">${escapeHtml(c)}</li>`).join("")}</ul>`;
    const moduleHtml = (m) => {
      const id = escapeHtml(m.id);
      const version = installedVersion(m.id);
      const badges = [
        unseen.includes(m.id) ? '<span class="gm-badge">New</span>' : "",
        pending.has(m.id)
          ? `<span class="gm-badge">Update v${escapeHtml(pending.get(m.id).to)}</span>`
          : "",
      ].join("");
      const parts = version ? (installed?.sections.find((s) => s.id === m.id)?.parts ?? []) : [];
      const hidden = hiddenAll[m.id] ?? [];
      const partsHtml = parts.length
        ? `<span class="gm-parts">Show:${parts
            .map(
              (p) =>
                `<span class="gm-part${hidden.includes(p.id) ? "" : " on"}" data-part-of="${id}" data-part="${escapeHtml(p.id)}" title="Click to ${hidden.includes(p.id) ? "show" : "hide and turn off"} ${escapeHtml(p.label)}">${escapeHtml(p.label)}</span>`,
            )
            .join("")}</span>`
        : "";
      const open = expandedChangelogs.has(m.id);
      const changelog = open
        ? `<div class="gm-module-changelog">${(m.changelog ?? [])
            .map(
              (e) =>
                `<div class="gm-changelog"><div class="gm-changelog-head"><b>v${escapeHtml(e.version)}</b><span>${escapeHtml(e.date ?? "")}${e.version === version ? " · installed" : ""}</span></div>${changesHtml(e.changes)}</div>`,
            )
            .join("")}</div>`
        : "";
      const libs = [...requiredClosure([m.id])].filter(
        (dep) => dep !== m.id && dep !== "core" && !installedVersion(dep),
      );
      const confirm =
        pendingInstall === m.id
          ? `<div class="gm-install-confirm">
          <div>Install <b>${escapeHtml(m.name)} v${escapeHtml(m.version)}</b>? Latest changes:</div>
          ${changesHtml(m.changelog?.[0]?.changes)}
          ${libs.length ? `<div>Also installs: ${escapeHtml(libs.map(nameOf).join(", "))}.</div>` : ""}
          <div class="gm-row gm-settings-actions"><button class="gm-btn" data-install-cancel>Cancel</button><button class="gm-btn active" data-install="${id}">Install v${escapeHtml(m.version)}</button></div>
        </div>`
          : "";
      return `
      <div class="gm-module">
        <label class="gm-setting${launcherLost ? " disabled" : ""}">
          <span class="gm-setting-text"><span class="gm-setting-title">${escapeHtml(m.name)} <span class="gm-version">${version ? `v${escapeHtml(version)}` : `v${escapeHtml(m.version)} · not installed`}</span>${badges}</span><span>${escapeHtml(m.description)}</span></span>
          <input type="checkbox" class="gm-switch" data-module="${id}" ${selected.includes(m.id) ? "checked" : ""} ${launcherLost ? "disabled" : ""} />
        </label>
        ${confirm}
        <div class="gm-module-extra">${partsHtml}<span class="gm-link" data-changelog="${id}">${open ? "Hide changelog" : "Changelog"}</span></div>
        ${changelog}
      </div>`;
    };
    list.innerHTML = modules.map(moduleHtml).join("");
    list.insertAdjacentHTML(
      "beforeend",
      removed
        .map(
          (id) => `
        <div class="gm-setting gm-removed">
          <span class="gm-setting-text"><span class="gm-setting-title">${escapeHtml(id)}<span class="gm-badge gm-badge-removed">Removed</span></span><span>No longer published. Uninstall it if you don't need it anymore.</span></span>
          <button class="gm-btn gm-btn-danger" data-uninstall="${escapeHtml(id)}" ${launcherLost ? "disabled" : ""}>Uninstall</button>
        </div>`,
        )
        .join(""),
    );
    if (launcherLost) {
      const message = document.getElementById("gm-modules-message");
      message.textContent =
        "The launcher is not running: reopen Gather Mods.app to change modules.";
      message.classList.add("gm-text-danger");
    }
    const showModuleChange = (row, installing) => {
      const message = document.getElementById("gm-modules-message");
      message.textContent = installing ? "Installing…" : "Uninstalling…";
      message.classList.toggle("gm-text-danger", !installing);
      row.classList.toggle("gm-uninstalling", !installing);
    };
    list.querySelectorAll("[data-module]").forEach((input) => {
      input.onchange = () => {
        const id = input.dataset.module;
        if (input.checked && !installedVersion(id)) {
          input.checked = false;
          pendingInstall = id;
          renderModuleList();
          return;
        }
        showModuleChange(input.closest(".gm-setting"), input.checked);
        setModuleSelected(id, input.checked);
      };
    });
    list.querySelectorAll("[data-install]").forEach((btn) => {
      btn.onclick = () => {
        btn.disabled = true;
        pendingInstall = null;
        showModuleChange(btn.closest(".gm-module").querySelector(".gm-setting"), true);
        setModuleSelected(btn.dataset.install, true);
      };
    });
    list.querySelectorAll("[data-install-cancel]").forEach((btn) => {
      btn.onclick = () => {
        pendingInstall = null;
        renderModuleList();
      };
    });
    list.querySelectorAll("[data-changelog]").forEach((link) => {
      link.onclick = () => {
        const id = link.dataset.changelog;
        if (!expandedChangelogs.delete(id)) expandedChangelogs.add(id);
        renderModuleList();
      };
    });
    list.querySelectorAll("[data-part]").forEach((chip) => {
      chip.onclick = () =>
        setPartHidden(chip.dataset.partOf, chip.dataset.part, chip.classList.contains("on"));
    });
    list.querySelectorAll("[data-uninstall]").forEach((btn) => {
      btn.onclick = () => {
        btn.disabled = true;
        showModuleChange(btn.closest(".gm-setting"), false);
        setModuleSelected(btn.dataset.uninstall, false);
      };
    });
  }

  function renderChangelog() {
    const box = document.getElementById("gm-settings-changelog");
    if (!box) return;
    const selected = selectedModules();
    const unseen = unseenModules().map((m) => m.id);
    const previous = readJson(PREVIOUS_VERSIONS_KEY, {});
    const items = catalogModules()
      .filter(
        (m) =>
          m.kind !== "lib" &&
          (m.kind === "core" || selected.includes(m.id) || unseen.includes(m.id)),
      )
      .flatMap((m) => {
        const current = installedVersion(m.id);
        const since = previous[m.id];
        return (m.changelog ?? []).map((entry, index) => {
          const pending = !!current && isNewerVersion(entry.version, current);
          const recent = !!current && !pending && !!since && isNewerVersion(entry.version, since);
          return {
            module: m,
            entry,
            notInstalled: !current,
            pending,
            recent,
            highlighted: pending || recent || (!current && index === 0),
          };
        });
      });
    const highlighted = items
      .filter((i) => i.highlighted)
      .sort((a, b) => (b.entry.date || "").localeCompare(a.entry.date || ""));
    const history = items.filter((i) => !i.highlighted);
    const entryHtml = ({ module, entry, notInstalled, pending, recent }) => `
        <div class="gm-changelog${notInstalled || pending ? " gm-fresh" : recent ? " gm-recent" : ""}">
          <div class="gm-changelog-head"><b>${escapeHtml(module.name)} v${escapeHtml(entry.version)}</b><span>${escapeHtml(entry.date ?? "")}${notInstalled ? " · not installed" : pending ? " · update available" : recent ? " · installed" : ""}</span></div>
          <ul>${(entry.changes ?? []).map((c) => `<li class="${changeClass(c)}">${escapeHtml(c)}</li>`).join("")}</ul>
        </div>`;
    box.innerHTML = [
      highlighted.length
        ? highlighted.map(entryHtml).join("")
        : '<div class="gm-empty">Everything is up to date.</div>',
      history.length
        ? `<div class="gm-changelog-more"><span class="gm-link" id="gm-changelog-toggle">${showChangelogHistory ? "Hide" : "Show"} full history</span></div>`
        : "",
      showChangelogHistory ? history.map(entryHtml).join("") : "",
    ].join("");
    const toggle = document.getElementById("gm-changelog-toggle");
    if (toggle)
      toggle.onclick = () => {
        showChangelogHistory = !showChangelogHistory;
        renderChangelog();
      };
  }

  function renderUpdateInfo() {
    const info = document.getElementById("gm-update-info");
    if (!info) return;
    const state = launcherState();
    const connected = hasLauncher() && !launcherLost;
    const pending = pendingUpdates();
    const row = (label, value, cls = "") =>
      `<div class="gm-info-row"><span>${label}</span><span class="${cls}">${escapeHtml(value)}</span></div>`;
    info.innerHTML = [
      launcherLost
        ? row("Launcher", "Not running: reopen Gather Mods.app", "gm-text-danger")
        : row(
            "Launcher",
            connected ? "Connected" : "Not connected (mod pasted by hand, no updates)",
          ),
      row("Last check", hasLauncher() ? formatTime(state.checkedAt) : "—"),
      row(
        "Latest release",
        hasLauncher() && state.catalog
          ? `commit ${shortCommit(state.catalog.commit)} · ${formatDate(state.catalog.publishedAt)}`
          : "—",
      ),
      row(
        "Updates",
        !connected
          ? "—"
          : pending.length
            ? pending.map((p) => `${p.name} ${p.from} → ${p.to}`).join(", ")
            : "Everything is up to date",
      ),
      ...(state?.error ? [row("Last error", state.error)] : []),
    ].join("");
    const auto = document.getElementById("gm-auto-update");
    auto.checked = hasLauncher() && state.autoUpdate;
    auto.disabled = !connected;
    document.getElementById("gm-auto-update-row").classList.toggle("disabled", !connected);
    document.getElementById("gm-update-actions").style.display = connected ? "" : "none";
    const review = document.getElementById("gm-review-update");
    review.style.display = pending.length ? "" : "none";
    review.textContent = `Review & install ${pending.length} update${pending.length > 1 ? "s" : ""}`;
    document.getElementById("gm-update-message").textContent = "";
  }

  function openReviewModal() {
    const pending = pendingUpdates();
    if (!pending.length) return;
    const modal = openModal(
      "Review updates",
      `
      <p class="gm-hint">The launcher only accepts code signed by the GitHub release workflow on main. The changelog is written by the author; the diff below is the exact code that will run.</p>
      <div class="gm-diff" id="gm-diff"><div>Loading…</div></div>
      <div class="gm-row gm-settings-actions">
        <button class="gm-btn" id="gm-review-cancel">Cancel</button>
        <button class="gm-btn active" id="gm-review-install">Install ${pending.length} update${pending.length > 1 ? "s" : ""}</button>
      </div>`,
      "gm-modal-review",
    );
    modal.querySelector("#gm-review-cancel").onclick = closeModal;
    modal.querySelector("#gm-review-install").onclick = (e) => {
      e.target.textContent = "Installing…";
      sendToLauncher({ type: "apply-update" });
    };
    sendToLauncher({ type: "get-diff" });
  }

  function renderReviewDiff() {
    const box = document.getElementById("gm-diff");
    const diffs = window.__gatherModsLauncherDiff;
    if (!box || !Array.isArray(diffs)) return;
    const lineClass = (l) =>
      l.startsWith("@@") ? "gm-hunk" : l[0] === "+" ? "gm-add" : l[0] === "-" ? "gm-rem" : "";
    box.innerHTML = diffs
      .flatMap((d) => [
        `<div class="gm-diff-module">${escapeHtml(d.name)} ${escapeHtml(d.from ?? "new")} → ${escapeHtml(d.to)}</div>`,
        ...(d.changes ?? []).map(
          (c) => `<div class="gm-diff-note ${changeClass(c)}">• ${escapeHtml(c)}</div>`,
        ),
        ...(d.diff || " (no code change)")
          .split("\n")
          .map((l) => `<div class="${lineClass(l)}">${escapeHtml(l) || " "}</div>`),
      ])
      .join("");
  }

  const CORE_CSS = `
    #gather-mods-panel { padding: 8px 14px 12px; font-family: inherit; color: var(--gm-fg); border-bottom: 1px solid var(--gm-border); }
    #gather-mods-panel .gm-head { display:flex; align-items:center; justify-content:space-between; cursor:pointer; padding:4px 0; }
    #gather-mods-panel .gm-head h4 { margin:0; font-size:11px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:var(--gm-muted); }
    #gather-mods-panel .gm-head-actions { display:flex; align-items:center; gap:8px; }
    #gather-mods-panel .gm-cog { color:var(--gm-muted); font-size:13px; line-height:1; }
    #gather-mods-panel .gm-cog:hover { color:var(--theme-color-accent,#6c5ce7); }
    #gather-mods-panel .gm-update-dot { display:none; width:6px; height:6px; margin-left:6px; border-radius:50%; background:var(--theme-color-accent,#6c5ce7); vertical-align:middle; }
    #gather-mods-panel .gm-update-dot.visible { display:inline-block; }
    #gather-mods-panel .gm-chevron { color:var(--gm-muted); font-size:11px; transition:transform .15s; }
    #gather-mods-panel.collapsed .gm-body { display:none; }
    #gather-mods-panel.collapsed > .gm-head .gm-chevron { transform:rotate(-90deg); }
    #gather-mods-panel .gm-body { max-height:60vh; overflow-y:auto; overscroll-behavior:contain; margin-right:-6px; padding-right:6px; }
    #gather-mods-panel .gm-body::-webkit-scrollbar { width:5px; }
    #gather-mods-panel .gm-body::-webkit-scrollbar-thumb { background:var(--gm-border); border-radius:3px; }
    #gather-mods-panel .gm-section-head { display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; }
    #gather-mods-panel .gm-section-head:hover .gm-label { color:var(--gm-fg); }
    #gather-mods-panel .gm-section.collapsed .gm-section-body { display:none; }
    #gather-mods-panel .gm-section.collapsed .gm-chevron { transform:rotate(-90deg); }
    #gather-mods-panel .gm-sublabel { font-size:11px; color:var(--gm-muted); margin:8px 2px 2px; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-label { font-size:10px; font-weight:600; text-transform:uppercase; color:var(--gm-muted); margin:9px 0 4px; }
    :is(#gather-mods-panel, #gather-mods-modal) button.gm-btn { display:block; width:100%; text-align:left; padding:7px 10px; margin:3px 0; font-size:13px;
      background:var(--gm-surface); border:1px solid transparent; border-radius:8px; color:var(--gm-fg); cursor:pointer; transition:background .12s; }
    :is(#gather-mods-panel, #gather-mods-modal) button.gm-btn:hover { background:var(--gm-surface-hover); }
    :is(#gather-mods-panel, #gather-mods-modal) button.gm-btn.active { background:var(--theme-color-accent,#6c5ce7); color:#fff; border-color:transparent; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-input { width:100%; box-sizing:border-box; padding:7px 10px; margin:3px 0; font-size:13px;
      background:var(--gm-input); border:1px solid var(--gm-border); border-radius:8px; color:var(--gm-fg); outline:none; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-input:focus { border-color:var(--theme-color-accent,#6c5ce7); }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-input::placeholder { color:var(--gm-muted); }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-list { max-height:160px; overflow-y:auto; }
    :is(#gather-mods-panel, #gather-mods-modal) :is(.gm-list, .gm-grid)::-webkit-scrollbar { width:5px; }
    :is(#gather-mods-panel, #gather-mods-modal) :is(.gm-list, .gm-grid)::-webkit-scrollbar-thumb { background:var(--gm-border); border-radius:3px; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-item { display:flex; align-items:center; justify-content:space-between; gap:6px;
      padding:6px 10px; margin:2px 0; font-size:13px; background:var(--gm-surface); border-radius:8px; cursor:pointer; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-item:hover { background:var(--gm-surface-hover); }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-item .gm-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-item.active { background:var(--theme-color-accent,#6c5ce7); color:#fff; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-del { color:var(--gm-muted); font-size:13px; flex-shrink:0; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-del:hover { color:#ff6b6b; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-empty { color:var(--gm-muted); font-size:12px; padding:4px 2px; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-row { display:flex; gap:6px; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-row .gm-input { flex:1; margin:3px 0; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-row button.gm-btn { width:auto; flex-shrink:0; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-status { display:flex; justify-content:space-between; gap:6px; font-size:12px; color:var(--gm-muted); padding:2px 2px 4px; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-link { cursor:pointer; text-decoration:underline; flex-shrink:0; }
    :is(#gather-mods-panel, #gather-mods-modal) .gm-actions { display:flex; gap:8px; flex-shrink:0; }
    #gather-mods-panel .gm-pub { color:var(--gm-muted); font-size:13px; flex-shrink:0; }
    #gather-mods-panel .gm-pub:hover { color:var(--theme-color-accent,#6c5ce7); }
    #gather-mods-modal { position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,.45); font-family:inherit; color:var(--gm-fg); }
    #gather-mods-modal .gm-modal { width:min(860px, 92vw); height:min(640px, 86vh); display:flex; flex-direction:column; gap:10px; padding:16px;
      box-sizing:border-box; background:var(--gm-bg); border:1px solid var(--gm-border); border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,.35); }
    #gather-mods-modal .gm-modal-head { display:flex; align-items:center; justify-content:space-between; }
    #gather-mods-modal .gm-modal-head h3 { margin:0; font-size:15px; font-weight:700; }
    #gather-mods-modal .gm-close { cursor:pointer; color:var(--gm-muted); font-size:16px; }
    #gather-mods-modal .gm-close:hover { color:var(--gm-fg); }
    #gather-mods-modal .gm-modal-settings { width:min(560px, 92vw); height:auto; max-height:86vh; }
    #gather-mods-modal .gm-settings-body { overflow-y:auto; display:flex; flex-direction:column; gap:18px; padding-right:4px; }
    #gather-mods-modal .gm-settings-body::-webkit-scrollbar { width:5px; }
    #gather-mods-modal .gm-settings-body::-webkit-scrollbar-thumb { background:var(--gm-border); border-radius:3px; }
    #gather-mods-modal .gm-settings-group h4 { margin:0 0 4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.5px; color:var(--gm-muted); }
    #gather-mods-modal .gm-hint { margin:0 0 8px; font-size:12px; line-height:1.45; color:var(--gm-muted); }
    #gather-mods-modal .gm-hint:empty { display:none; }
    #gather-mods-modal .gm-setting { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; margin:4px 0;
      border-radius:8px; background:var(--gm-surface); cursor:pointer; }
    #gather-mods-modal .gm-setting.disabled { opacity:.5; cursor:not-allowed; }
    #gather-mods-modal .gm-module { margin:4px 0; border-radius:8px; background:var(--gm-surface); }
    #gather-mods-modal .gm-module > .gm-setting { margin:0; background:transparent; }
    #gather-mods-modal .gm-module-extra { display:flex; flex-wrap:wrap; align-items:center; gap:5px; padding:0 10px 8px; font-size:11px; color:var(--gm-muted); }
    #gather-mods-modal .gm-module-extra .gm-link { margin-left:auto; }
    #gather-mods-modal .gm-parts { display:flex; flex-wrap:wrap; align-items:center; gap:5px; }
    #gather-mods-modal .gm-part { padding:1px 7px; border-radius:6px; border:1px solid var(--gm-border); cursor:pointer; text-decoration:line-through; }
    #gather-mods-modal .gm-part.on { text-decoration:none; color:var(--gm-fg); background:var(--gm-surface-hover); }
    #gather-mods-modal .gm-module-changelog { padding:0 10px 8px; }
    #gather-mods-modal .gm-install-confirm { margin:0 10px 8px; padding:8px 10px; border-radius:8px; font-size:12px; line-height:1.45;
      background:rgba(39,174,96,.10); box-shadow:inset 3px 0 0 var(--gm-green); }
    #gather-mods-modal .gm-install-confirm ul { margin:4px 0 6px; padding-left:18px; }
    #gather-mods-modal .gm-setting-text { display:flex; flex-direction:column; gap:2px; font-size:13px; font-weight:600; }
    #gather-mods-modal .gm-setting-text > span:not(.gm-setting-title) { font-size:12px; font-weight:400; color:var(--gm-muted); line-height:1.4; }
    #gather-mods-modal .gm-version { font-size:11px; font-weight:400; color:var(--gm-muted); margin-left:4px; }
    #gather-mods-modal .gm-badge { font-size:10px; font-weight:700; margin-left:6px; padding:1px 6px; border-radius:6px; color:#fff; background:var(--gm-green); }
    #gather-mods-modal .gm-badge-removed { background:var(--gm-red); }
    #gather-mods-modal .gm-setting:is(.gm-removed, .gm-uninstalling) { background:rgba(229,72,77,.12); box-shadow:inset 3px 0 0 var(--gm-red); }
    #gather-mods-modal .gm-removed { cursor:default; }
    #gather-mods-modal .gm-setting button.gm-btn-danger { width:auto; flex-shrink:0; margin:0; color:var(--gm-red); border-color:var(--gm-red); background:transparent; }
    #gather-mods-modal .gm-setting button.gm-btn-danger:hover { background:rgba(229,72,77,.15); }
    #gather-mods-modal .gm-setting button.gm-btn-danger:disabled { opacity:.5; cursor:default; }
    #gather-mods-modal .gm-text-danger { color:var(--gm-red); }
    #gather-mods-modal .gm-switch { appearance:none; flex-shrink:0; width:34px; height:20px; margin:0; border-radius:10px; position:relative; cursor:pointer;
      background:var(--gm-surface-hover); border:1px solid var(--gm-border); transition:background .15s; }
    #gather-mods-modal .gm-switch::after { content:""; position:absolute; top:1px; left:1px; width:16px; height:16px; border-radius:50%;
      background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); transition:transform .15s; }
    #gather-mods-modal .gm-switch:checked { background:var(--theme-color-accent,#6c5ce7); }
    #gather-mods-modal .gm-switch:checked::after { transform:translateX(14px); }
    #gather-mods-modal .gm-switch:disabled { cursor:not-allowed; }
    #gather-mods-modal .gm-changelog { padding:6px 2px; border-bottom:1px solid var(--gm-border); font-size:12px; }
    #gather-mods-modal .gm-changelog:is(.gm-fresh, .gm-recent) { padding-left:9px; }
    #gather-mods-modal .gm-changelog.gm-fresh { background:rgba(39,174,96,.10); box-shadow:inset 3px 0 0 var(--gm-green); }
    #gather-mods-modal .gm-changelog.gm-recent { background:rgba(108,92,231,.10); box-shadow:inset 3px 0 0 var(--theme-color-accent,#6c5ce7); }
    #gather-mods-modal .gm-changelog-head { display:flex; justify-content:space-between; gap:8px; }
    #gather-mods-modal .gm-changelog-head span { color:var(--gm-muted); }
    #gather-mods-modal .gm-changelog-more { padding:8px 2px; font-size:12px; color:var(--gm-muted); }
    #gather-mods-modal .gm-fresh .gm-changelog-head span { color:var(--gm-green); font-weight:600; }
    #gather-mods-modal .gm-recent .gm-changelog-head span { color:var(--theme-color-accent,#6c5ce7); font-weight:600; }
    #gather-mods-modal .gm-changelog ul { margin:4px 0 0; padding-left:18px; color:var(--gm-muted); line-height:1.45; }
    #gather-mods-modal .gm-changelog:is(.gm-fresh, .gm-recent) ul { color:var(--gm-fg); }
    #gather-mods-modal :is(.gm-changelog li, .gm-diff .gm-diff-note).gm-change-removed { color:var(--gm-red); }
    #gather-mods-modal .gm-info-row { display:flex; justify-content:space-between; gap:12px; padding:5px 2px; font-size:13px; border-bottom:1px solid var(--gm-border); }
    #gather-mods-modal .gm-info-row span:first-child { color:var(--gm-muted); }
    #gather-mods-modal .gm-info-row span:last-child { text-align:right; word-break:break-word; }
    #gather-mods-modal .gm-settings-actions { margin-top:6px; }
    #gather-mods-modal .gm-settings-actions button.gm-btn { flex:1; text-align:center; margin:0; }
    #gather-mods-modal .gm-modal-review { width:min(960px, 94vw); height:min(760px, 88vh); }
    #gather-mods-modal .gm-diff { flex:1; overflow:auto; margin:0; padding:8px 0; border-radius:8px; background:var(--gm-input);
      font:11px/1.45 ui-monospace, Menlo, monospace; white-space:pre; }
    #gather-mods-modal .gm-diff div { padding:0 10px; min-width:max-content; }
    #gather-mods-modal .gm-diff .gm-diff-module { font:600 13px/1.6 inherit; font-family:inherit; padding-top:10px; color:var(--gm-green); }
    #gather-mods-modal .gm-diff .gm-diff-note { font-family:inherit; color:var(--gm-green); white-space:normal; }
    #gather-mods-modal .gm-diff .gm-add { background:rgba(46,204,113,.18); }
    #gather-mods-modal .gm-diff .gm-rem { background:rgba(255,59,48,.18); }
    #gather-mods-modal .gm-diff .gm-hunk { color:var(--gm-muted); padding-top:6px; }
  `;
})();
