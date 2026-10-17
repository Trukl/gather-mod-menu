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
  const SEEN_NOTICES_KEY = STORAGE_PREFIX + "seenNotices";
  const UPDATE_REQUIRED_KEY = STORAGE_PREFIX + "updateRequired";
  const SEEN_ANNOUNCEMENTS_KEY = STORAGE_PREFIX + "seenAnnouncements";
  const ANNOUNCEMENTS_POLL_MS = 10 * 60_000;
  const HUB_URL_KEY = STORAGE_PREFIX + "hubUrl";
  const INSTALL_ID_KEY = STORAGE_PREFIX + "installId";
  const REPORTED_INSTALL_KEY = STORAGE_PREFIX + "reportedInstall";
  const DEFAULT_HUB_URL = "https://gather-mods-hub.minnecorentin.workers.dev";
  const VERSIONS_HEADER = "X-Gather-Mods";
  const BUNDLE_URL =
    "https://raw.githubusercontent.com/Trukl/gather-mod-menu/main/gather-mod-menu.js";
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
    const previous = button.innerHTML;
    button.textContent = text;
    setTimeout(() => (button.innerHTML = previous), ms);
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
  // Theme — follow Gather (light/dark) via the sidebar's text luminance. The
  // .gm root class carries the design tokens, .gm-dark switches them.
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
    el.classList.add("gm");
    el.classList.toggle("gm-dark", isDarkTheme());
  }

  // ===================
  // Modal
  // ===================
  let modalLocked = false;
  function onModalKey(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (!modalLocked) closeModal();
  }
  function closeModal() {
    modalLocked = false;
    document.removeEventListener("keydown", onModalKey, true);
    document.getElementById("gather-mods-modal")?.remove();
  }
  // A locked modal only closes through its own buttons.
  function openModal(title, bodyHtml, modalClass = "", locked = false) {
    closeModal();
    modalLocked = locked;
    const modal = document.createElement("div");
    modal.id = "gather-mods-modal";
    modal.innerHTML = `
      <div class="gm-window gm-modal ${modalClass}" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="gm-window-head"><span class="gm-window-title">${escapeHtml(title)}</span>${locked ? "" : '<button class="gm-iconbtn" id="gm-modal-close" title="Close"><i class="gm-i" data-i="x"></i></button>'}</div>
        ${bodyHtml}
      </div>`;
    applyTheme(modal);
    document.body.appendChild(modal);
    document.addEventListener("keydown", onModalKey, true);
    for (const type of ["keydown", "keyup", "keypress"])
      modal.addEventListener(type, (e) => e.stopPropagation());
    modal.addEventListener("mousedown", (e) => {
      if (e.target === modal && !locked) closeModal();
    });
    if (!locked) modal.querySelector("#gm-modal-close").onclick = closeModal;
    return modal;
  }
  // A message window: icon tile, title and text, actions at the bottom.
  function openMessage({ icon, tone = "", title, html, actions, locked = false }) {
    return openModal(
      title,
      `
      <div class="gm-window-body">
        <span class="gm-message-icon ${tone}"><i class="gm-i" data-i="${icon}"></i></span>
        <div class="gm-message-title">${escapeHtml(title)}</div>
        ${html}
      </div>
      <div class="gm-window-foot">${actions}</div>`,
      "gm-modal-message",
      locked,
    );
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
  // The hub checks the versions of the running modules and answers 426 with
  // the breaking changes they miss.
  async function hubFetch(path, init = {}) {
    const versions = ["core", ...(installed?.apis.keys() ?? [])]
      .map((id) => [id, installedVersion(id)])
      .filter(([, version]) => version)
      .map(([id, version]) => `${id}=${version}`)
      .join(",");
    const r = await fetch(hubUrl() + path, {
      ...init,
      headers: { ...init.headers, [VERSIONS_HEADER]: versions },
    });
    if (r.status === 426) onHubUpdateRequired(await r.clone().json());
    return r;
  }
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
  function setSelectedModules(ids) {
    if (hasLauncher()) {
      sendToLauncher({ type: "set-modules", modules: ids });
      return;
    }
    writeJson(
      DISABLED_MODULES_KEY,
      userModules()
        .map((m) => m.id)
        .filter((m) => !ids.includes(m)),
    );
    registry.reload();
  }
  function setModuleSelected(id, on) {
    const selected = new Set(selectedModules());
    if (on) selected.add(id);
    else selected.delete(id);
    sessionStorage.setItem(REOPEN_SETTINGS_KEY, "1");
    setSelectedModules([...selected]);
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
      required: requiredUpdates(),
      announcements: [],
      announcementsPoll: null,
    };
    installed = state;
    const blocked = blockedModules(state.required);
    const enabled =
      hasLauncher() || !registry.bundleCatalog ? null : requiredClosure(selectedModules());
    for (const def of defs) {
      if (def.id === "core" || blocked.has(def.id) || (enabled && !enabled.has(def.id))) continue;
      try {
        state.apis.set(def.id, def.setup(makeContext(def.id, state)) ?? {});
      } catch (e) {
        console.error(`[GatherMods] module "${def.id}" failed to start`, e);
      }
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [CORE_CSS, ICON_CSS, ...state.styles].join("\n");
    document.head.appendChild(style);
    ensurePanel();
    initSeenNotices();
    trackInstalledVersions();
    window.addEventListener("gathermods:launcher-state", onLauncherState);
    window.addEventListener("gathermods:launcher-diff", renderReviewDiff);
    state.tick = setInterval(() => {
      ensurePanel();
      const panel = document.getElementById("gather-mods-panel");
      if (panel) applyTheme(panel);
      renderSectionStatus();
      for (const fn of state.tickers) runSafely(fn);
      showAnnouncements(false);
    }, TICK_MS);
    if (sessionStorage.getItem(REOPEN_SETTINGS_KEY)) {
      sessionStorage.removeItem(REOPEN_SETTINGS_KEY);
      openSettingsModal();
    }
    showUpdateRequired();
    showNews();
    fetchAnnouncements();
    state.announcementsPoll = setInterval(fetchAnnouncements, ANNOUNCEMENTS_POLL_MS);
    console.log(`[GatherMods] installed: ${[...state.apis.keys()].join(", ") || "core only"}`);
  }

  function teardown() {
    clearTimeout(waitTimer);
    const state = installed;
    installed = null;
    if (!state) return;
    clearInterval(state.tick);
    clearInterval(state.announcementsPoll);
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
      hubFetch,
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
    document.querySelectorAll("#gather-mods-panel .gm-sec").forEach((el) => {
      el.classList.toggle("open", !collapsed.includes(el.dataset.section));
    });
    renderSectionStatus();
  }
  const moduleIcon = (id) => catalogModules().find((m) => m.id === id)?.icon ?? "puzzle";

  function ensurePanel() {
    if (!installed || document.getElementById("gather-mods-panel")) return;
    const sidebar = findSidebar();
    if (!sidebar) return;
    const panel = document.createElement("div");
    panel.id = "gather-mods-panel";
    if (localStorage.getItem(PANEL_COLLAPSED_KEY) === "true") panel.classList.add("collapsed");
    const collapsed = getCollapsed();
    panel.innerHTML = `
      <div class="gm-panel-head" id="gm-head">
        <span class="gm-panel-title">Mods<i class="gm-i xs" data-i="chevron-down"></i></span>
        <span class="gm-dot" id="gm-update-dot" title="Updates or new modules available"></span>
        <span class="gm-spacer"></span>
        <button class="gm-iconbtn" id="gm-settings-toggle" title="Settings"><i class="gm-i" data-i="settings"></i></button>
      </div>
      <div class="gm-body">
        <div id="gm-announcements"></div>
        ${
          installed.required.length
            ? `<div class="gm-news gm-alert" id="gm-required"><i class="gm-i" data-i="triangle-alert"></i><span class="gm-news-text">Update required: ${escapeHtml(installed.required.map((r) => r.module.name).join(", "))}</span><i class="gm-i sm" data-i="chevron-right"></i></div>`
            : ""
        }
        ${
          installed.sections
            .map(
              (s) => `
          <section class="gm-sec${collapsed.includes(s.id) ? "" : " open"}" data-section="${s.id}">
            <div class="gm-sec-head"><i class="gm-i" data-i="${escapeHtml(moduleIcon(s.id))}"></i><span class="gm-sec-title">${escapeHtml(s.title)}</span><span class="gm-pill gm-new gm-sec-status"></span><i class="gm-i sm gm-chev" data-i="chevron-right"></i></div>
            <div class="gm-sec-body">${s.html}</div>
          </section>`,
            )
            .join("") ||
          (installed.required.length
            ? ""
            : '<div class="gm-empty">No module installed: pick some in the settings.</div>')
        }
      </div>`;
    applyTheme(panel);
    sidebar.insertBefore(panel, sidebar.children[sidebar.children.length - 1] || null);
    const required = panel.querySelector("#gm-required");
    if (required) required.onclick = showUpdateRequired;
    panel.querySelector("#gm-head").onclick = () => {
      panel.classList.toggle("collapsed");
      localStorage.setItem(PANEL_COLLAPSED_KEY, panel.classList.contains("collapsed"));
    };
    panel.querySelector("#gm-settings-toggle").onclick = (e) => {
      e.stopPropagation();
      openSettingsModal();
    };
    panel.querySelectorAll(".gm-sec-head").forEach((head) => {
      head.onclick = () => {
        const id = head.parentElement.dataset.section;
        const current = getCollapsed();
        setCollapsed(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
      };
    });
    for (const s of installed.sections) {
      const body = panel.querySelector(`[data-section="${s.id}"] .gm-sec-body`);
      const hidden = hiddenParts(s.id);
      body.querySelectorAll("[data-part]").forEach((el) => {
        if (hidden.includes(el.dataset.part)) el.style.display = "none";
      });
      runSafely(() => s.mount?.(body));
    }
    renderSectionStatus();
    renderUpdateDot();
    renderAnnouncements();
  }

  // A module's status() (“On”, “2 playing”…) shows on its folded section.
  function renderSectionStatus() {
    for (const s of installed?.sections ?? []) {
      const pill = document.querySelector(
        `#gather-mods-panel [data-section="${s.id}"] .gm-sec-status`,
      );
      if (pill && s.status) runSafely(() => (pill.textContent = s.status() || ""));
    }
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
    if (requiredUpdateStep) return continueRequiredUpdate();
    if (reloadIfRequiredChanged()) return;
    showNews();
  }

  // ===================
  // News — a changelog entry can carry a `notice` (breaking change, action
  // needed). Unseen notices of installed modules, and of their pending
  // updates, open a modal once.
  // ===================
  const noticeKey = ({ module, entry }) => `${module.id}@${entry.version}`;
  function currentNotices() {
    const notices = [];
    for (const module of catalogModules()) {
      const version = installedVersion(module.id);
      if (!version) continue;
      for (const entry of module.changelog ?? [])
        if (entry.notice)
          notices.push({ module, entry, pending: isNewerVersion(entry.version, version) });
    }
    return notices;
  }
  // First run: notices up to the versions this install already had (or all of
  // them on a fresh install) count as seen. Runs before trackInstalledVersions.
  function initSeenNotices() {
    if (readJson(SEEN_NOTICES_KEY, null)) return;
    const known = readJson(KNOWN_VERSIONS_KEY, {});
    const old = currentNotices().filter(
      ({ module, entry }) => !known[module.id] || !isNewerVersion(entry.version, known[module.id]),
    );
    writeJson(SEEN_NOTICES_KEY, old.map(noticeKey));
  }
  const noticeHtml = (entry) =>
    entry.notice
      ? `<div class="gm-notice${entry.breaking ? " gm-breaking" : ""}"><i class="gm-i sm" data-i="${entry.breaking ? "triangle-alert" : "info"}"></i><span>${entry.breaking ? "<b>Breaking change.</b> " : ""}${escapeHtml(entry.notice)}</span></div>`
      : "";
  const changesHtml = (changes) =>
    `<ul class="gm-changes">${(changes ?? []).map((c) => `<li class="${changeClass(c)}">${escapeHtml(c)}</li>`).join("")}</ul>`;
  const formatDay = (date) =>
    date
      ? new Date(date.includes("T") ? date : `${date}T12:00`).toLocaleDateString([], {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
  // One changelog entry of a module; `state` is [label, pill class].
  const entryHtml = (module, entry, state) => `
    <div class="gm-mod gm-entry">
      <span class="gm-mod-icon"><i class="gm-i" data-i="${escapeHtml(module.icon ?? "puzzle")}"></i></span>
      <div class="gm-mod-main">
        <div class="gm-mod-name">${escapeHtml(module.name)} ${escapeHtml(entry.version)}${state ? `<span class="gm-pill ${state[1]}">${state[0]}</span>` : ""}<span class="gm-spacer"></span><span class="gm-mod-version">${formatDay(entry.date)}</span></div>
        ${noticeHtml(entry)}
        ${changesHtml(entry.changes)}
      </div>
    </div>`;
  function showNews() {
    if (document.getElementById("gather-mods-modal")) return;
    const seen = readJson(SEEN_NOTICES_KEY, []);
    const notices = currentNotices().filter((n) => !seen.includes(noticeKey(n)));
    if (!notices.length) return;
    writeJson(SEEN_NOTICES_KEY, [...seen, ...notices.map(noticeKey)]);
    const canReview = hasLauncher() && notices.some((n) => n.pending);
    const breaking = notices.some((n) => n.entry.breaking);
    const modal = openMessage({
      icon: breaking ? "triangle-alert" : "info",
      tone: breaking ? "gm-warn" : "",
      title: "Mod news",
      html: `<div class="gm-entries">${notices
        .map(({ module, entry, pending }) =>
          entryHtml(
            module,
            entry,
            pending ? ["Update available", "gm-up"] : ["Installed", "gm-new"],
          ),
        )
        .join("")}</div>`,
      actions: `${canReview ? '<button class="gm-btn gm-ghost" id="gm-news-review">Review & install</button>' : ""}<button class="gm-btn gm-primary" id="gm-news-ok">Got it</button>`,
    });
    modal.querySelector("#gm-news-ok").onclick = closeModal;
    const review = modal.querySelector("#gm-news-review");
    if (review) review.onclick = openReviewModal;
  }

  // ===================
  // Required updates — a changelog entry marked `breaking` is the minimum
  // version a module needs: below it, the module does not start until it is
  // updated or disabled, and an outdated core turns the whole mod off. The hub
  // reports the breaking changes the local catalog does not know yet.
  // ===================
  let requiredUpdateStep = null;
  // Versions this install has, running or blocked.
  function ownedVersions() {
    if (hasLauncher())
      return Object.fromEntries(
        Object.entries(launcherState().installed ?? {}).map(([id, m]) => [id, m.version]),
      );
    const owned = requiredClosure(selectedModules());
    return Object.fromEntries(
      catalogModules()
        .filter((m) => owned.has(m.id))
        .map((m) => [m.id, m.version]),
    );
  }
  function requiredUpdates() {
    const owned = ownedVersions();
    const fromHub = readJson(UPDATE_REQUIRED_KEY, {});
    return catalogModules().flatMap((module) => {
      const version = owned[module.id];
      if (!version) return [];
      const entries = new Map();
      for (const entry of [...(module.changelog ?? []), ...(fromHub[module.id] ?? [])])
        if (entry.breaking && isNewerVersion(entry.version, version))
          entries.set(entry.version, entry);
      const sorted = [...entries.values()].sort((a, b) =>
        isNewerVersion(a.version, b.version) ? -1 : 1,
      );
      return sorted.length ? [{ module, version, entries: sorted }] : [];
    });
  }
  function blockedModules(required) {
    const outdated = new Set(required.map((r) => r.module.id));
    if (outdated.has("core")) return new Set(defs.map((d) => d.id));
    return new Set(
      catalogModules()
        .map((m) => m.id)
        .filter((id) => [...requiredClosure([id])].some((dep) => outdated.has(dep))),
    );
  }
  const requiredKey = (required) =>
    required.map((r) => `${r.module.id}@${r.entries[0].version}`).join();
  function reloadIfRequiredChanged() {
    if (!installed || requiredKey(requiredUpdates()) === requiredKey(installed.required))
      return false;
    registry.reload();
    return true;
  }
  function onHubUpdateRequired({ modules }) {
    const fromHub = readJson(UPDATE_REQUIRED_KEY, {});
    for (const { id, changelog } of modules) fromHub[id] = changelog;
    writeJson(UPDATE_REQUIRED_KEY, fromHub);
    reloadIfRequiredChanged();
  }

  function showUpdateRequired() {
    const required = installed?.required ?? [];
    if (!required.length) return;
    const coreOutdated = required.some((r) => r.module.id === "core");
    const blocked = blockedModules(required);
    const toDisable = selectedModules().filter((id) => blocked.has(id));
    const nameOf = (id) => catalogModules().find((m) => m.id === id)?.name ?? id;
    const seen = readJson(SEEN_NOTICES_KEY, []);
    const shown = required.flatMap(({ module, entries }) =>
      entries.map((entry) => noticeKey({ module, entry })),
    );
    writeJson(SEEN_NOTICES_KEY, [...new Set([...seen, ...shown])]);
    const modal = openMessage({
      icon: "triangle-alert",
      tone: "gm-warn",
      title: coreOutdated
        ? "Update required"
        : `Update required: ${required.map((r) => r.module.name).join(", ")}`,
      html: `
        <div class="gm-message-text">${
          coreOutdated
            ? "This version of the mod no longer works: the mod stays off until you update it."
            : "Some of your modules no longer work in this version: they stay off until you update or disable them."
        }</div>
        <div class="gm-entries">${required
          .flatMap(({ module, version, entries }) =>
            entries.map((entry) =>
              entryHtml(module, entry, [`You have ${escapeHtml(version)}`, "gm-gone"]),
            ),
          )
          .join("")}</div>
        <div class="gm-note gm-err"><i class="gm-i sm" data-i="circle-alert"></i><span id="gm-required-message"></span></div>`,
      actions: `${
        coreOutdated || toDisable.length
          ? `<button class="gm-btn gm-ghost" id="gm-required-off">${coreOutdated ? "Turn off the mod" : `Disable ${escapeHtml(toDisable.map(nameOf).join(", "))}`}</button>`
          : ""
      }<button class="gm-btn gm-primary" id="gm-required-update">${hasLauncher() ? "Update now" : "Get the new version"}</button>`,
      locked: true,
    });
    const off = modal.querySelector("#gm-required-off");
    if (off)
      off.onclick = () =>
        coreOutdated
          ? teardown()
          : setSelectedModules(selectedModules().filter((id) => !blocked.has(id)));
    modal.querySelector("#gm-required-update").onclick = (e) => {
      if (!hasLauncher()) return window.open(BUNDLE_URL, "_blank");
      e.target.disabled = true;
      e.target.textContent = "Updating…";
      continueRequiredUpdate();
    };
  }

  // The launcher may not know the required versions yet: it checks for them
  // first. A state push after "apply-update" means nothing was installed.
  function continueRequiredUpdate() {
    const step = requiredUpdateStep;
    requiredUpdateStep = null;
    const pending = pendingUpdates();
    const ready = installed.required.every(({ module, entries }) => {
      const update = pending.find((p) => p.id === module.id);
      return update && !isNewerVersion(entries[0].version, update.to);
    });
    if (step !== "apply" && ready) {
      requiredUpdateStep = "apply";
      sendToLauncher({ type: "apply-update" });
    } else if (step === null) {
      requiredUpdateStep = "check";
      sendToLauncher({ type: "check-now" });
    } else {
      const button = document.getElementById("gm-required-update");
      if (!button) return;
      button.disabled = false;
      button.textContent = "Update now";
      document.getElementById("gm-required-message").textContent =
        launcherState().error ??
        "The new version is not available yet: try again in a few minutes.";
    }
  }

  // ===================
  // Announcements — messages from the hub admin (maintenance, incident…): a
  // new one opens a window once no other window is open, active ones stay at
  // the top of the panel.
  // ===================
  async function fetchAnnouncements() {
    const state = installed;
    try {
      const r = await hubFetch("/announcements");
      if (!r.ok) return;
      const { announcements } = await r.json();
      if (installed !== state) return;
      state.announcements = announcements;
      renderAnnouncements();
    } catch (e) {
      console.warn("[GatherMods] announcements unavailable:", e.message);
    }
  }
  function renderAnnouncements() {
    const box = document.getElementById("gm-announcements");
    if (!box) return;
    const [latest, ...more] = installed.announcements;
    box.innerHTML = latest
      ? `<div class="gm-news${latest.level === "warning" ? " gm-warn" : ""}" title="Read the announcements"><i class="gm-i" data-i="megaphone"></i><span class="gm-news-text">${escapeHtml(latest.title)}</span>${more.length ? `<span class="gm-pill gm-new">+${more.length}</span>` : ""}<i class="gm-i sm" data-i="chevron-right"></i></div>`
      : "";
    if (latest) box.firstElementChild.onclick = () => showAnnouncements(true);
  }
  function showAnnouncements(all) {
    const seen = readJson(SEEN_ANNOUNCEMENTS_KEY, []);
    const list = all
      ? installed.announcements
      : installed.announcements.filter((a) => !seen.includes(a.id));
    if (!list.length || (!all && document.getElementById("gather-mods-modal"))) return;
    writeJson(
      SEEN_ANNOUNCEMENTS_KEY,
      installed.announcements.map((a) => a.id),
    );
    const show = (index) => {
      const a = list[index];
      const warning = a.level === "warning";
      const modal = openMessage({
        icon: warning ? "triangle-alert" : "megaphone",
        tone: warning ? "gm-warn" : "",
        title: a.title,
        html: `
          <div class="gm-message-text">${escapeHtml(a.message)}</div>
          <div class="gm-message-meta">${list.length > 1 ? `<span class="gm-pill">${index + 1} of ${list.length}</span><span class="gm-link" id="gm-announcements-next">Next</span><span class="gm-spacer"></span>` : ""}<span>${escapeHtml(formatDate(a.createdAt))}</span></div>`,
        actions: '<button class="gm-btn gm-primary" id="gm-announcements-ok">Got it</button>',
      });
      modal.querySelector("#gm-announcements-ok").onclick = closeModal;
      const next = modal.querySelector("#gm-announcements-next");
      if (next) next.onclick = () => show((index + 1) % list.length);
    };
    show(0);
  }

  // ===================
  // Settings
  // ===================
  let settingsTab = "modules";
  function openSettingsModal() {
    if (installed?.required.length) return showUpdateRequired();
    const modal = openModal(
      "Mods settings",
      `
      <div class="gm-tabs" role="tablist">
        <button role="tab" data-tab="modules">Modules</button>
        <button role="tab" data-tab="news">What's new<span class="gm-pill gm-new" id="gm-news-count"></span></button>
        <button role="tab" data-tab="updates">Updates<span class="gm-pill gm-up" id="gm-updates-count"></span></button>
      </div>
      <div class="gm-tab-pane" data-pane="modules">
        <div class="gm-window-body gm-modules-body">
          <div class="gm-hint gm-modules-hint">Only the modules you turn on run in Gather. Turning one off keeps its data (presets, saved locations…).</div>
          <div id="gm-settings-modules"></div>
        </div>
        <div class="gm-window-foot">
          <div class="gm-note"><i class="gm-i sm" data-i="info"></i><span id="gm-modules-message"></span></div>
          <span class="gm-spacer"></span>
          <button class="gm-btn gm-ghost gm-sm" id="gm-collapse-all" title="Fold every section of the panel">Fold all</button>
          <button class="gm-btn gm-ghost gm-sm" id="gm-expand-all" title="Unfold every section of the panel">Unfold all</button>
        </div>
      </div>
      <div class="gm-tab-pane" data-pane="news">
        <div class="gm-window-body gm-news-body" id="gm-settings-changelog"></div>
      </div>
      <div class="gm-tab-pane" data-pane="updates">
        <div class="gm-window-body">
          <div id="gm-update-info"></div>
          <label class="gm-toggle" id="gm-auto-update-row">
            <span class="gm-toggle-text"><span class="gm-toggle-title">Install updates automatically</span><span class="gm-hint">As soon as they are published, without restarting Gather. Off: the dot in the panel tells you, and you review the code before installing. New modules are never installed automatically.</span></span>
            <input type="checkbox" class="gm-switch" id="gm-auto-update" />
          </label>
          <div class="gm-list" id="gm-update-list"></div>
          <div class="gm-note"><i class="gm-i sm" data-i="shield-check"></i><span>With Gather Mods.app, the launcher checks for new versions every 15 minutes and only accepts code signed by the release workflow of the repo's main branch.</span></div>
        </div>
        <div class="gm-window-foot" id="gm-update-actions">
          <div class="gm-note"><span id="gm-update-message"></span></div>
          <span class="gm-spacer"></span>
          <button class="gm-btn gm-ghost" id="gm-check-update"><i class="gm-i" data-i="refresh-cw"></i>Check now</button>
          <button class="gm-btn gm-primary" id="gm-review-update"></button>
        </div>
      </div>`,
      "gm-modal-settings",
    );
    const showTab = (tab) => {
      settingsTab = tab;
      modal
        .querySelectorAll("[data-tab]")
        .forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
      modal
        .querySelectorAll("[data-pane]")
        .forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
    };
    modal.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    showTab(settingsTab);
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
    const moduleHtml = (m) => {
      const id = escapeHtml(m.id);
      const version = installedVersion(m.id);
      const pills = [
        unseen.includes(m.id) ? '<span class="gm-pill gm-new">New</span>' : "",
        pending.has(m.id)
          ? `<span class="gm-pill gm-up">Update ${escapeHtml(pending.get(m.id).to)}</span>`
          : "",
      ].join("");
      const parts = version ? (installed?.sections.find((s) => s.id === m.id)?.parts ?? []) : [];
      const hidden = hiddenAll[m.id] ?? [];
      const partsHtml = parts.length
        ? `<div class="gm-mod-parts">${parts
            .map((p) => {
              const on = !hidden.includes(p.id);
              return `<span class="gm-chip${on ? " on" : ""}" data-part-of="${id}" data-part="${escapeHtml(p.id)}" title="${on ? "Hide and turn off" : "Show"} ${escapeHtml(p.label)}">${on ? '<i class="gm-i xs" data-i="check"></i>' : ""}${escapeHtml(p.label)}</span>`;
            })
            .join("")}</div>`
        : "";
      const open = expandedChangelogs.has(m.id);
      const changelog = open
        ? `<div class="gm-mod-changelog">${(m.changelog ?? [])
            .map(
              (e) =>
                `<div class="gm-release"><div class="gm-mod-name">${escapeHtml(e.version)}<span class="gm-mod-version">${formatDay(e.date)}${e.version === version ? " · installed" : ""}</span></div>${noticeHtml(e)}${changesHtml(e.changes)}</div>`,
            )
            .join("")}</div>`
        : "";
      const libs = [...requiredClosure([m.id])].filter(
        (dep) => dep !== m.id && dep !== "core" && !installedVersion(dep),
      );
      const confirm =
        pendingInstall === m.id
          ? `<div class="gm-card gm-install-confirm">
          <span class="gm-confirm-text">Install <b>${escapeHtml(m.name)} ${escapeHtml(m.version)}</b>? Latest changes:</span>
          ${changesHtml(m.changelog?.[0]?.changes)}
          ${libs.length ? `<span class="gm-hint">Also installs: ${escapeHtml(libs.map(nameOf).join(", "))}.</span>` : ""}
          <div class="gm-btn-row"><button class="gm-btn gm-sm" data-install-cancel>Cancel</button><button class="gm-btn gm-sm gm-primary" data-install="${id}">Install ${escapeHtml(m.version)}</button></div>
        </div>`
          : "";
      return `
      <div class="gm-mod${launcherLost ? " gm-disabled" : ""}">
        <span class="gm-mod-icon"><i class="gm-i" data-i="${escapeHtml(m.icon ?? "puzzle")}"></i></span>
        <div class="gm-mod-main">
          <div class="gm-mod-name">${escapeHtml(m.name)}<span class="gm-mod-version">${version ? escapeHtml(version) : `${escapeHtml(m.version)} · not installed`}</span>${pills}</div>
          <div class="gm-mod-desc">${escapeHtml(m.description)}</div>
          ${partsHtml}${confirm}${changelog}
        </div>
        <div class="gm-mod-side">
          <input type="checkbox" class="gm-switch" data-module="${id}" title="${selected.includes(m.id) ? "Uninstall" : "Install"} ${escapeHtml(m.name)}" ${selected.includes(m.id) ? "checked" : ""} ${launcherLost ? "disabled" : ""} />
          <span class="gm-link" data-changelog="${id}">${open ? "Hide changelog" : "Changelog"}</span>
        </div>
      </div>`;
    };
    list.innerHTML = modules.map(moduleHtml).join("");
    list.insertAdjacentHTML(
      "beforeend",
      removed
        .map(
          (id) => `
        <div class="gm-mod gm-removed">
          <span class="gm-mod-icon"><i class="gm-i" data-i="package-x"></i></span>
          <div class="gm-mod-main">
            <div class="gm-mod-name">${escapeHtml(id)}<span class="gm-pill gm-gone">Removed</span></div>
            <div class="gm-mod-desc">No longer published. Uninstall it if you don't need it anymore.</div>
          </div>
          <div class="gm-mod-side"><button class="gm-btn gm-sm gm-danger" data-uninstall="${escapeHtml(id)}" ${launcherLost ? "disabled" : ""}>Uninstall</button></div>
        </div>`,
        )
        .join(""),
    );
    const message = document.getElementById("gm-modules-message");
    const setMessage = (text, error) => {
      message.textContent = text;
      message.parentElement.classList.toggle("gm-err", error);
    };
    if (launcherLost)
      setMessage("The launcher is not running: reopen Gather Mods.app to change modules.", true);
    const showModuleChange = (row, installing) => {
      setMessage(installing ? "Installing…" : "Uninstalling…", !installing);
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
        showModuleChange(input.closest(".gm-mod"), input.checked);
        setModuleSelected(id, input.checked);
      };
    });
    list.querySelectorAll("[data-install]").forEach((btn) => {
      btn.onclick = () => {
        btn.disabled = true;
        pendingInstall = null;
        showModuleChange(btn.closest(".gm-mod"), true);
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
        showModuleChange(btn.closest(".gm-mod"), false);
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
    const itemHtml = ({ module, entry, notInstalled, pending, recent }) =>
      entryHtml(
        module,
        entry,
        notInstalled
          ? ["Not installed", ""]
          : pending
            ? ["Update available", "gm-up"]
            : recent
              ? ["Installed", "gm-new"]
              : null,
      );
    box.innerHTML = [
      highlighted.length
        ? highlighted.map(itemHtml).join("")
        : '<div class="gm-empty"><i class="gm-i sm" data-i="circle-check"></i>Everything is up to date</div>',
      history.length
        ? `<div class="gm-history-toggle"><span class="gm-link" id="gm-changelog-toggle">${showChangelogHistory ? "Hide" : "Show"} full history</span></div>`
        : "",
      showChangelogHistory ? history.map(itemHtml).join("") : "",
    ].join("");
    document.getElementById("gm-news-count").textContent = highlighted.length || "";
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
    const note = (cls, icon, text) =>
      `<div class="gm-note ${cls}"><i class="gm-i sm" data-i="${icon}"></i><span>${escapeHtml(text)}</span></div>`;
    info.innerHTML = [
      launcherLost
        ? note("gm-err", "circle-alert", "The launcher is not running: reopen Gather Mods.app.")
        : connected
          ? note(
              "gm-ok",
              "circle-check",
              `Launcher connected · checked at ${formatTime(state.checkedAt)}${state.catalog ? ` · release of ${formatDay(state.catalog.publishedAt)} (${shortCommit(state.catalog.commit)})` : ""}`,
            )
          : note(
              "",
              "info",
              "Mod pasted by hand: no updates. Open Gather with Gather Mods.app to get them.",
            ),
      state?.error ? note("gm-err", "circle-alert", `Last error: ${state.error}`) : "",
    ].join("");
    document.getElementById("gm-update-list").innerHTML = !connected
      ? ""
      : pending.length
        ? pending
            .map((p) => {
              const m = catalogModules().find((x) => x.id === p.id);
              const change = m?.changelog?.find((e) => e.version === p.to)?.changes?.[0] ?? "";
              return `<div class="gm-item"><span class="gm-mod-icon gm-sm"><i class="gm-i sm" data-i="${escapeHtml(m?.icon ?? "puzzle")}"></i></span><div class="gm-item-text"><span class="gm-item-title">${escapeHtml(p.name)} ${escapeHtml(p.from)} → ${escapeHtml(p.to)}</span><span class="gm-item-meta">${escapeHtml(change)}</span></div></div>`;
            })
            .join("")
        : '<div class="gm-empty"><i class="gm-i sm" data-i="circle-check"></i>Everything is up to date</div>';
    document.getElementById("gm-updates-count").textContent = pending.length || "";
    const auto = document.getElementById("gm-auto-update");
    auto.checked = hasLauncher() && state.autoUpdate;
    auto.disabled = !connected;
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
      <div class="gm-window-body">
        <div class="gm-note"><i class="gm-i sm" data-i="shield-check"></i><span>The launcher only accepts code signed by the GitHub release workflow on main. The changelog is written by the author; the diff below is the exact code that will run.</span></div>
        <div class="gm-diff" id="gm-diff"><div>Loading…</div></div>
      </div>
      <div class="gm-window-foot">
        <button class="gm-btn gm-ghost" id="gm-review-cancel">Cancel</button>
        <button class="gm-btn gm-primary" id="gm-review-install">Install ${pending.length} update${pending.length > 1 ? "s" : ""}</button>
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
    .gm { color-scheme:light; --gm-text:rgba(0,0,0,.88); --gm-text-2:rgba(0,0,0,.6); --gm-text-3:rgba(0,0,0,.42);
      --gm-fill:rgba(0,0,0,.04); --gm-fill-2:rgba(0,0,0,.075); --gm-line:rgba(0,0,0,.08); --gm-surface:#fff; --gm-raised:#fff;
      --gm-accent:var(--theme-color-accent,#4257da); --gm-on-accent:#fff;
      --gm-accent-soft:color-mix(in srgb, var(--gm-accent) 11%, transparent); --gm-accent-text:color-mix(in srgb, var(--gm-accent) 88%, black);
      --gm-danger:#d0342c; --gm-danger-soft:rgba(208,52,44,.09); --gm-success:#1c8a4a; --gm-success-soft:rgba(28,138,74,.1);
      --gm-warning:#a8650a; --gm-warning-soft:rgba(245,165,36,.16); --gm-ring:0 0 0 3px color-mix(in srgb, var(--gm-accent) 22%, transparent);
      --gm-shadow-pop:0 16px 40px rgba(0,0,0,.14), 0 2px 8px rgba(0,0,0,.06); --gm-shadow-knob:0 1px 2px rgba(0,0,0,.18), 0 0 0 .5px rgba(0,0,0,.06);
      font:400 13px/1.4 InterVariable, Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; font-feature-settings:"cv11", "ss01";
      color:var(--gm-text); -webkit-font-smoothing:antialiased; }
    .gm.gm-dark { color-scheme:dark; --gm-text:rgba(255,255,255,.92); --gm-text-2:rgba(255,255,255,.6); --gm-text-3:rgba(255,255,255,.4);
      --gm-fill:rgba(255,255,255,.06); --gm-fill-2:rgba(255,255,255,.1); --gm-line:rgba(255,255,255,.09); --gm-surface:#1c1c1f; --gm-raised:#2a2a2e;
      --gm-accent-soft:color-mix(in srgb, var(--gm-accent) 22%, transparent); --gm-accent-text:color-mix(in srgb, var(--gm-accent) 55%, white);
      --gm-danger:#ff6b63; --gm-danger-soft:rgba(255,107,99,.13); --gm-success:#43d17f; --gm-success-soft:rgba(67,209,127,.13);
      --gm-warning:#f5b544; --gm-warning-soft:rgba(245,181,68,.15); --gm-shadow-pop:0 16px 40px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.06); }
    .gm *, .gm *::before, .gm *::after { box-sizing:border-box; }
    :where(.gm) :where(button, input, select, textarea) { font:inherit; color:inherit; }
    .gm ::-webkit-scrollbar { width:6px; height:6px; }
    .gm ::-webkit-scrollbar-thumb { background:var(--gm-fill-2); border-radius:3px; }
    .gm ::-webkit-scrollbar-track { background:transparent; }

    .gm-i { display:inline-block; flex:none; width:16px; height:16px; vertical-align:-3px; background:currentColor;
      -webkit-mask:var(--gm-i) center / contain no-repeat; mask:var(--gm-i) center / contain no-repeat; }
    .gm-i.sm { width:14px; height:14px; vertical-align:-2px; }
    .gm-i.xs { width:12px; height:12px; vertical-align:-1px; }
    .gm-spacer { flex:1; }

    #gather-mods-panel { padding:6px 14px 10px; border-bottom:1px solid var(--gm-line); }
    #gather-mods-panel .gm-panel-head { display:flex; align-items:center; gap:4px; height:28px; padding-left:2px; cursor:pointer; user-select:none; }
    #gather-mods-panel .gm-panel-title { display:flex; align-items:center; gap:4px; font-size:12px; font-weight:500; color:var(--gm-text-2); }
    #gather-mods-panel .gm-panel-title .gm-i { transition:transform .15s; }
    #gather-mods-panel.collapsed .gm-panel-title .gm-i { transform:rotate(-90deg); }
    #gather-mods-panel .gm-dot { display:none; width:6px; height:6px; margin-left:2px; border-radius:50%; background:var(--gm-accent); }
    #gather-mods-panel .gm-dot.visible { display:block; }
    #gather-mods-panel .gm-body { display:flex; flex-direction:column; gap:2px; max-height:60vh; overflow-y:auto; overscroll-behavior:contain; margin:2px -6px 0; padding:0 6px; }
    #gather-mods-panel.collapsed .gm-body { display:none; }
    #gm-announcements:empty { display:none; }
    .gm-news { display:flex; align-items:center; gap:8px; padding:8px 10px; margin:2px 0 4px; border-radius:10px; background:var(--gm-accent-soft);
      color:var(--gm-accent-text); font-size:12.5px; font-weight:500; cursor:pointer; }
    .gm-news-text { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .gm-news.gm-warn { background:var(--gm-warning-soft); color:var(--gm-warning); }
    .gm-news.gm-alert { background:var(--gm-danger-soft); color:var(--gm-danger); }
    .gm-sec-head { display:flex; align-items:center; gap:10px; height:32px; padding:0 8px; border-radius:8px; cursor:pointer; user-select:none; }
    .gm-sec-head:hover { background:var(--gm-fill); }
    .gm-sec-head > .gm-i:first-child { color:var(--gm-text-2); }
    .gm-sec-title { flex:1; min-width:0; font-size:13px; font-weight:500; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .gm-sec-head .gm-chev { color:var(--gm-text-3); transition:transform .15s; }
    .gm-sec.open .gm-chev { transform:rotate(90deg); }
    .gm-sec.open .gm-sec-status { display:none; }
    .gm-sec-body { display:none; flex-direction:column; gap:8px; padding:4px 0 12px; }
    .gm-sec.open .gm-sec-body { display:flex; }
    .gm-sec-body > div[data-part]:not([class]) { display:flex; flex-direction:column; gap:8px; }
    .gm-sec + .gm-sec.open, .gm-sec.open + .gm-sec { border-top:1px solid var(--gm-line); padding-top:2px; }
    .gm-sub { display:flex; align-items:center; gap:6px; margin:6px 2px -2px; font-size:11.5px; font-weight:500; color:var(--gm-text-2); }
    .gm-sub .gm-spacer + * { margin-right:-2px; }

    .gm-btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; max-width:100%; height:32px; padding:0 12px; border:0;
      border-radius:8px; background:var(--gm-fill); color:var(--gm-text); font-size:12.5px; font-weight:500; white-space:nowrap; cursor:pointer;
      transition:background .12s, filter .12s; }
    .gm-btn > span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .gm-btn:hover { background:var(--gm-fill-2); }
    .gm-btn .gm-i { color:var(--gm-text-2); }
    .gm-btn.gm-block { width:100%; justify-content:flex-start; }
    .gm-btn.gm-primary { background:var(--gm-accent); color:var(--gm-on-accent); }
    .gm-btn.gm-primary:hover { filter:brightness(1.08); }
    .gm-btn.gm-ghost { background:transparent; color:var(--gm-text-2); }
    .gm-btn.gm-ghost:hover { background:var(--gm-fill); color:var(--gm-text); }
    .gm-btn.gm-danger, .gm-btn.gm-danger:hover { color:var(--gm-danger); }
    .gm-btn.gm-danger:hover { background:var(--gm-danger-soft); }
    .gm-btn.gm-danger.gm-solid { background:var(--gm-danger); color:#fff; }
    .gm-btn.gm-danger.gm-solid:hover { filter:brightness(1.08); }
    .gm-btn.is-on { background:var(--gm-accent-soft); color:var(--gm-accent-text); }
    .gm-btn:is(.gm-primary, .gm-danger, .is-on) .gm-i { color:inherit; }
    .gm-btn.gm-sm { height:26px; padding:0 9px; gap:5px; border-radius:7px; font-size:12px; }
    .gm-btn:disabled { opacity:.4; pointer-events:none; }
    .gm-btn-row { display:flex; gap:6px; }
    .gm-btn-row > .gm-btn { flex:1; min-width:0; }
    .gm-iconbtn { display:inline-grid; place-items:center; width:26px; height:26px; flex:none; padding:0; border:0; border-radius:7px;
      background:transparent; color:var(--gm-text-2); cursor:pointer; }
    .gm-iconbtn:hover { background:var(--gm-fill-2); color:var(--gm-text); }
    .gm-iconbtn.gm-danger:hover { background:var(--gm-danger-soft); color:var(--gm-danger); }
    .gm-iconbtn.on { background:var(--gm-accent-soft); color:var(--gm-accent-text); }
    .gm-iconbtn:disabled { opacity:.4; pointer-events:none; }

    .gm-toggle { display:flex; align-items:center; gap:10px; min-height:40px; padding:6px 8px; border-radius:8px; cursor:pointer; }
    .gm-toggle:hover { background:var(--gm-fill); }
    .gm-toggle:has(.gm-switch:disabled) { opacity:.5; cursor:not-allowed; }
    .gm-toggle-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
    .gm-toggle-title { font-size:13px; font-weight:500; }
    .gm-hint { font-size:11.5px; line-height:1.35; color:var(--gm-text-2); }
    .gm-switch { appearance:none; position:relative; width:30px; height:18px; flex:none; margin:0; border:0; border-radius:9px;
      background:var(--gm-fill-2); cursor:pointer; transition:background .15s; }
    .gm-switch::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff;
      box-shadow:var(--gm-shadow-knob); transition:transform .15s; }
    .gm-switch:checked { background:var(--gm-accent); }
    .gm-switch:checked::after { transform:translateX(12px); }
    .gm-switch:disabled { cursor:not-allowed; }
    .gm-switch:focus-visible { box-shadow:var(--gm-ring); }

    .gm-input, .gm-select { width:100%; height:32px; padding:0 10px; border:1px solid transparent; border-radius:8px; background-color:var(--gm-fill);
      font-size:12.5px; outline:none; transition:background-color .12s, border-color .12s, box-shadow .12s; }
    .gm-input::placeholder { color:var(--gm-text-3); }
    .gm-input:hover, .gm-select:hover { background-color:var(--gm-fill-2); }
    .gm-input:focus { background-color:var(--gm-surface); border-color:color-mix(in srgb, var(--gm-accent) 55%, transparent); box-shadow:var(--gm-ring); }
    .gm-input::-webkit-inner-spin-button, .gm-input::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
    .gm-select { appearance:none; padding-right:26px; cursor:pointer; background-repeat:no-repeat; background-size:4px 4px;
      background-image:linear-gradient(45deg, transparent 50%, var(--gm-text-2) 50%), linear-gradient(135deg, var(--gm-text-2) 50%, transparent 50%);
      background-position:calc(100% - 13px) 14px, calc(100% - 9px) 14px; }
    .gm-field { position:relative; display:flex; align-items:center; min-width:0; }
    .gm-field > .gm-i { position:absolute; left:10px; color:var(--gm-text-3); pointer-events:none; }
    .gm-field > .gm-i + .gm-input { padding-left:32px; }
    .gm-field > .gm-unit { position:absolute; right:10px; font-size:12px; color:var(--gm-text-3); pointer-events:none; }
    .gm-field > .gm-input:has(+ .gm-unit) { padding-right:44px; }
    .gm-field > .gm-btn { position:absolute; right:3px; }
    .gm-field > .gm-input:has(~ .gm-btn) { padding-right:64px; }
    .gm-prop { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:32px; padding:0 2px 0 8px; }
    .gm-prop > span:first-child { font-size:12.5px; color:var(--gm-text-2); }
    .gm-prop > :is(.gm-field, .gm-select, .gm-seg, .gm-input) { width:132px; flex:none; }
    .gm-seg { display:flex; gap:2px; padding:2px; border-radius:9px; background:var(--gm-fill); }
    .gm-seg > button { flex:1 1 auto; display:inline-flex; align-items:center; justify-content:center; gap:4px; min-width:0; height:26px; padding:0 7px;
      border:0; border-radius:7px; background:transparent; font-size:12px; font-weight:500; color:var(--gm-text-2); white-space:nowrap; cursor:pointer; }
    .gm-seg > button:hover { color:var(--gm-text); }
    .gm-seg > button.on { background:var(--gm-raised); color:var(--gm-text); box-shadow:0 1px 2px rgba(0,0,0,.1), 0 0 0 .5px rgba(0,0,0,.05); }
    .gm-dark .gm-seg > button.on { background:rgba(255,255,255,.14); }
    .gm-seg > button:disabled { opacity:.4; pointer-events:none; }

    .gm-list { display:flex; flex-direction:column; gap:1px; }
    .gm-item { display:flex; align-items:center; gap:9px; min-height:32px; padding:4px 6px 4px 8px; border-radius:8px; cursor:pointer; }
    .gm-item:hover { background:var(--gm-fill); }
    .gm-item > .gm-i:first-child { color:var(--gm-text-3); }
    .gm-item-text { flex:1; min-width:0; display:flex; flex-direction:column; }
    .gm-item-title { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gm-item-meta { font-size:11.5px; color:var(--gm-text-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gm-tail { font-size:11.5px; color:var(--gm-text-3); white-space:nowrap; }
    .gm-actions { display:none; gap:1px; margin:-2px -2px -2px 0; }
    .gm-item:hover .gm-actions, .gm-item.show-actions .gm-actions { display:flex; }
    .gm-item:hover .gm-tail.hide-on-hover { display:none; }
    .gm-item.is-on { background:var(--gm-accent-soft); }
    .gm-item.is-on :is(.gm-item-title, .gm-tail), .gm-item.is-on > .gm-i:first-child { color:var(--gm-accent-text); }
    .gm-item.is-muted .gm-item-title { color:var(--gm-text-3); text-decoration:line-through; }
    .gm-avatar { display:grid; place-items:center; width:22px; height:22px; flex:none; border-radius:50%; font-size:10px; font-weight:600; color:#fff; }
    .gm-thumb { width:22px; height:22px; flex:none; border-radius:5px; background:var(--gm-fill) center / contain no-repeat; image-rendering:pixelated; }
    .gm-playing { display:inline-flex; align-items:flex-end; gap:1.5px; height:10px; }
    .gm-playing i { width:2px; border-radius:1px; background:currentColor; }
    .gm-empty { display:flex; align-items:center; gap:8px; padding:6px 8px; font-size:12px; color:var(--gm-text-3); }

    .gm-note { display:flex; align-items:flex-start; gap:6px; padding:0 2px; font-size:11.5px; line-height:1.4; color:var(--gm-text-2); }
    .gm-note > .gm-i { margin-top:1px; }
    .gm-note:has(> span:last-child:empty) { display:none; }
    .gm-note.gm-ok > .gm-i { color:var(--gm-success); }
    .gm-note.gm-err { color:var(--gm-danger); }
    .gm-link { color:var(--gm-accent-text); font-weight:500; cursor:pointer; }
    .gm-link:hover { text-decoration:underline; }
    .gm-link.gm-danger { color:var(--gm-danger); }
    .gm-pill { display:inline-flex; align-items:center; height:18px; padding:0 6px; border-radius:5px; font-size:10.5px; font-weight:600;
      white-space:nowrap; background:var(--gm-fill-2); color:var(--gm-text-2); }
    .gm-pill:empty { display:none; }
    .gm-pill.gm-new { background:var(--gm-accent-soft); color:var(--gm-accent-text); }
    .gm-pill.gm-up { background:var(--gm-success-soft); color:var(--gm-success); }
    .gm-pill.gm-gone { background:var(--gm-danger-soft); color:var(--gm-danger); }
    .gm-card { display:flex; flex-direction:column; gap:8px; padding:10px; border-radius:12px; background:var(--gm-fill); }
    .gm-card.gm-confirm { background:var(--gm-danger-soft); }
    .gm-confirm-text { font-size:12.5px; color:var(--gm-text); }
    .gm-tip { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:6px; background:rgba(17,17,20,.92); color:#fff;
      font-size:12px; font-weight:500; white-space:nowrap; }
    .gm-kbd { padding:0 4px; border-radius:4px; background:rgba(255,255,255,.16); font-size:11px; }

    .gm-window { display:flex; flex-direction:column; border-radius:16px; background:var(--gm-surface); box-shadow:var(--gm-shadow-pop); overflow:hidden; }
    .gm-window-head { display:flex; align-items:center; gap:8px; flex:none; height:48px; padding:0 10px 0 16px; border-bottom:1px solid var(--gm-line); }
    .gm-window-head > .gm-i { color:var(--gm-text-2); }
    .gm-window-title { flex:1; min-width:0; font-size:14px; font-weight:600; letter-spacing:-.01em; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .gm-window-body { display:flex; flex-direction:column; gap:10px; flex:1 1 auto; min-height:0; padding:14px 16px; overflow-y:auto; overscroll-behavior:contain; }
    .gm-window-foot { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex:none; padding:12px 16px; border-top:1px solid var(--gm-line); }
    .gm-label { font-size:11.5px; font-weight:500; color:var(--gm-text-2); }
    .gm-tabs { display:flex; gap:18px; flex:none; padding:0 20px; border-bottom:1px solid var(--gm-line); }
    .gm-tabs > button { position:relative; display:inline-flex; align-items:center; gap:6px; height:40px; padding:0; border:0; background:none;
      font-size:13px; font-weight:500; color:var(--gm-text-2); cursor:pointer; }
    .gm-tabs > button:is(:hover, .on) { color:var(--gm-text); }
    .gm-tabs > button.on::after { content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px; border-radius:1px; background:var(--gm-accent); }
    .gm-mod { display:flex; gap:12px; padding:12px; }
    .gm-mod + .gm-mod { border-top:1px solid var(--gm-line); }
    .gm-mod-icon { display:grid; place-items:center; width:32px; height:32px; flex:none; border-radius:9px; background:var(--gm-fill); color:var(--gm-text-2); }
    .gm-mod-icon.gm-sm { width:28px; height:28px; border-radius:8px; }
    .gm-mod-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
    .gm-mod-name { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:13px; font-weight:600; }
    .gm-mod-version { font-size:11.5px; font-weight:400; color:var(--gm-text-3); }
    .gm-mod-desc { font-size:12px; line-height:1.45; color:var(--gm-text-2); }
    .gm-mod-parts { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
    .gm-mod-side { display:flex; flex-direction:column; align-items:flex-end; gap:8px; flex:none; }
    .gm-mod-side .gm-link { font-size:11.5px; }
    .gm-mod.gm-disabled { opacity:.5; pointer-events:none; }
    .gm-mod:is(.gm-uninstalling, .gm-removed) { border-radius:12px; background:var(--gm-danger-soft); }
    .gm-mod-changelog { display:flex; flex-direction:column; gap:10px; margin-top:8px; padding-top:8px; border-top:1px solid var(--gm-line); }
    .gm-mod-changelog .gm-mod-name { font-size:12.5px; }
    .gm-install-confirm { margin-top:8px; background:var(--gm-accent-soft); }
    .gm-chip { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 8px; border:1px solid var(--gm-line); border-radius:11px;
      font-size:11.5px; color:var(--gm-text-2); cursor:pointer; user-select:none; }
    .gm-chip:hover { color:var(--gm-text); }
    .gm-chip.on { border-color:transparent; background:var(--gm-fill-2); color:var(--gm-text); }
    .gm-chip.on .gm-i { color:var(--gm-success); }
    .gm-changes { margin:2px 0 0; padding-left:16px; list-style:disc; font-size:12px; line-height:1.5; color:var(--gm-text-2); }
    .gm-changes .gm-change-removed { color:var(--gm-danger); }
    .gm-notice { display:flex; align-items:flex-start; gap:6px; margin:2px 0; padding:8px 10px; border-radius:8px; font-size:12.5px; line-height:1.45;
      background:var(--gm-warning-soft); color:var(--gm-text); }
    .gm-notice > .gm-i { margin-top:2px; color:var(--gm-warning); }
    .gm-notice.gm-breaking { background:var(--gm-danger-soft); }
    .gm-notice.gm-breaking > .gm-i { color:var(--gm-danger); }

    #gather-mods-modal { position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.32); }
    #gather-mods-modal .gm-modal { position:relative; width:min(560px, 92vw); max-height:86vh; }
    #gather-mods-modal .gm-modal-settings { width:min(600px, 92vw); height:min(680px, 86vh); }
    #gather-mods-modal .gm-modal-review { width:min(960px, 94vw); height:min(760px, 88vh); }
    #gather-mods-modal .gm-modal-review > .gm-window-body { overflow:hidden; }
    #gather-mods-modal .gm-modal-message { width:min(460px, 92vw); }
    .gm-modal-message > .gm-window-head { position:absolute; top:10px; right:10px; height:auto; padding:0; border:0; }
    .gm-modal-message .gm-window-title { display:none; }
    .gm-modal-message > .gm-window-body { gap:12px; padding:22px 22px 8px; }
    .gm-modal-message > .gm-window-foot { padding:12px 22px 18px; border:0; }
    .gm-message-icon { display:grid; place-items:center; flex:none; width:40px; height:40px; border-radius:12px; background:var(--gm-accent-soft); color:var(--gm-accent-text); }
    .gm-message-icon.gm-warn { background:var(--gm-warning-soft); color:var(--gm-warning); }
    .gm-message-title { padding-right:24px; font-size:16px; font-weight:600; letter-spacing:-.01em; }
    .gm-message-text { font-size:13px; line-height:1.5; color:var(--gm-text-2); white-space:pre-line; overflow-wrap:anywhere; }
    .gm-message-meta { display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--gm-text-3); }
    .gm-entries { display:flex; flex-direction:column; }
    .gm-entries .gm-mod { padding:10px 0; }
    .gm-tab-pane { display:none; flex:1; min-height:0; flex-direction:column; }
    .gm-tab-pane.on { display:flex; }
    .gm-modules-body, .gm-news-body { gap:0; padding:4px 8px 8px; }
    .gm-modules-hint { padding:10px 12px 2px; }
    .gm-history-toggle { padding:10px 12px; font-size:12px; }
    #gm-update-list .gm-item { cursor:default; }
    #gm-update-list .gm-item:hover { background:none; }
    .gm-diff { flex:1; min-height:0; overflow:auto; padding:8px 0; border-radius:10px; background:var(--gm-fill); font:11px/1.45 ui-monospace, Menlo, monospace; white-space:pre; }
    .gm-diff div { min-width:max-content; padding:0 12px; }
    .gm-diff .gm-diff-module { padding-top:10px; font:600 13px/1.6 InterVariable, Inter, sans-serif; color:var(--gm-text); }
    .gm-diff .gm-diff-note { font:12px/1.5 InterVariable, Inter, sans-serif; color:var(--gm-text-2); white-space:normal; }
    .gm-diff .gm-diff-note.gm-change-removed { color:var(--gm-danger); }
    .gm-diff .gm-add { background:var(--gm-success-soft); }
    .gm-diff .gm-rem { background:var(--gm-danger-soft); }
    .gm-diff .gm-hunk { padding-top:6px; color:var(--gm-text-3); }
  `;

  // Lucide icons (lucide.dev, ISC license) drawn as CSS masks, so markup only
  // needs <i class="gm-i" data-i="name"></i>.
  const ICONS = {
    armchair:
      '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/>',
    "arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>',
    boxes:
      '<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "circle-alert":
      '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>',
    "clipboard-paste":
      '<path d="M11 14h10"/><path d="M16 4h2a2 2 0 0 1 2 2v1.344"/><path d="m17 18 4-4-4-4"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    download:
      '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    "eye-off":
      '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
    "file-up":
      '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/>',
    footprints:
      '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
    ghost:
      '<path d="M15 10v1"/><path d="M7.528 20.472a1.6 1.6 0 012.277 0l1.057 1.056a1.6 1.6 0 002.276 0l1.057-1.056a1.6 1.6 0 012.277 0l1.114 1.114a1.4 1.4 0 002.414-1V10a8 8 0 00-16 0v10.586a1.4 1.4 0 002.414 1z"/><path d="M9 10v1"/>',
    globe:
      '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    hammer:
      '<path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
    history:
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    image:
      '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    "image-plus":
      '<path d="M16 5h6"/><path d="M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/><circle cx="9" cy="9" r="2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    "lamp-desk":
      '<path d="M10.293 2.293a1 1 0 0 1 1.414 0l2.5 2.5 5.994 1.227a1 1 0 0 1 .506 1.687l-7 7a1 1 0 0 1-1.687-.506l-1.227-5.994-2.5-2.5a1 1 0 0 1 0-1.414z"/><path d="m14.207 4.793-3.414 3.414"/><path d="M3 20a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="m9.086 6.5-4.793 4.793a1 1 0 0 0-.18 1.17L7 18"/>',
    layers:
      '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    "link-2":
      '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
    "map-pin":
      '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    megaphone:
      '<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/>',
    moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    "mouse-pointer-click":
      '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
    move: '<path d="M12 2v20"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/>',
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    "package-x":
      '<path d="M12 22V12"/><path d="m16.5 14.5 5 5"/><path d="m16.5 19.5 5-5"/><path d="M21 10.5V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l.13-.074"/><path d="M3.29 7 12 12l8.71-5"/><path d="m7.5 4.27 8.997 5.148"/>',
    paintbrush:
      '<path d="m14.622 17.897-10.68-2.913"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"/>',
    pause:
      '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
    pencil:
      '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    puzzle:
      '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
    "refresh-cw":
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    "rotate-ccw":
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    settings:
      '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
    "share-2":
      '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
    "shield-check":
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    shirt:
      '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
    sparkles:
      '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
    "trash-2":
      '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    "triangle-alert":
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    "undo-2":
      '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    upload:
      '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    "wand-sparkles":
      '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    zap: '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>',
  };
  const ICON_CSS = Object.entries(ICONS)
    .map(([name, body]) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
      return `.gm-i[data-i="${name}"] { --gm-i: url("data:image/svg+xml,${encodeURIComponent(svg)}"); }`;
    })
    .join("\n");
})();
