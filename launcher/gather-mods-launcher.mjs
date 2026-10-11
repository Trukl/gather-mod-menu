#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verify as verifySignature } from "sigstore";
import {
  catalogErrors,
  isNewerVersion,
  requiredClosure,
  signedPayload,
  SIGNER_POLICY,
  unifiedDiff,
  UPDATES_URL,
} from "./mod-release.mjs";

const APP_PATH = "/Applications/GatherV2.app";
const APP_PROCESS = "GatherV2";
const PORT = Number(process.env.GATHER_MODS_PORT) || 31337;
const DEBUGGER_URL = `http://127.0.0.1:${PORT}`;
const GATHER_PAGE_PREFIX = "https://app.v2.gather.town/";
const CACHE_DIR = join(homedir(), "Library/Caches/gather-mods");
const CATALOG_PATH = join(CACHE_DIR, "catalog.json");
const INSTALLED_PATH = join(CACHE_DIR, "installed.json");
const CODE_DIR = join(CACHE_DIR, "modules");
const LEGACY_RELEASE_PATH = join(CACHE_DIR, "mod-release.json");
const LOCK_PATH = join(CACHE_DIR, "launcher.pid");
const SETTINGS_DIR = join(homedir(), "Library/Application Support/gather-mods");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
const PAGE_BINDING = "gatherModsLauncher";
const TARGET_POLL_MS = 2000;
const PORT_LOST_EXIT_MS = 30_000;
const UPDATE_CHECK_MS = Number(process.env.GATHER_MODS_UPDATE_CHECK_MS) || 15 * 60_000;
const RELEASES_URL = process.env.GATHER_MODS_UPDATES_URL || UPDATES_URL;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ===================
// Settings and local state
// ===================
let settings = { autoUpdate: false, ...readJsonFile(SETTINGS_PATH, {}) };
let catalog = null;
let installed = readJsonFile(INSTALLED_PATH, { modules: {} }).modules;
let checkedAt = null;
let lastError = null;

function saveSettings() {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
}
const catalogModule = (id) => catalog?.modules.find((m) => m.id === id);
const userModuleIds = () =>
  (catalog?.modules ?? []).filter((m) => m.kind === "module").map((m) => m.id);
const selectedModules = () => settings.modules ?? userModuleIds();

// ===================
// Signed catalog and module code
// ===================
// The catalog is signed by the GitHub release workflow (Sigstore); module code
// is fetched by hash and checked against the signed catalog.
function parseCatalog(raw) {
  const manifest = JSON.parse(raw.manifest);
  const errors = catalogErrors(manifest.modules ?? []);
  if (errors.length) throw new Error("invalid catalog: " + errors.join("; "));
  return { commit: manifest.commit, modules: manifest.modules, publishedAt: raw.publishedAt };
}
async function verifyCatalog(raw) {
  if (typeof raw?.manifest !== "string" || typeof raw.bundle !== "object" || !raw.bundle)
    throw new Error("malformed catalog");
  await verifySignature(raw.bundle, signedPayload(raw.manifest), SIGNER_POLICY);
  return parseCatalog(raw);
}

const rollbackOf = (next, current) =>
  next.modules.find((m) => {
    const old = current?.modules.find((o) => o.id === m.id);
    return old && isNewerVersion(old.version, m.version);
  });

async function fetchCatalog() {
  try {
    const res = await fetch(`${RELEASES_URL}/catalog`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const next = await verifyCatalog(raw);
    const rollback = rollbackOf(next, catalog);
    if (rollback) throw new Error(`catalog downgrades ${rollback.id}, ignored`);
    writeFileSync(CATALOG_PATH, JSON.stringify(raw));
    catalog = next;
    checkedAt = new Date().toISOString();
    lastError = null;
  } catch (e) {
    lastError = `Catalog check failed: ${e.message}`;
    log(lastError);
  }
}

function readCode(hash) {
  try {
    const code = readFileSync(join(CODE_DIR, `${hash}.js`), "utf8");
    return sha256(code) === hash ? code : null;
  } catch {
    return null;
  }
}
async function fetchCode(hash) {
  const cached = readCode(hash);
  if (cached !== null) return cached;
  const res = await fetch(`${RELEASES_URL}/modules/${hash}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`module ${hash.slice(0, 8)}: HTTP ${res.status}`);
  const code = await res.text();
  if (sha256(code) !== hash) throw new Error(`module ${hash.slice(0, 8)}: hash mismatch`);
  mkdirSync(CODE_DIR, { recursive: true });
  writeFileSync(join(CODE_DIR, `${hash}.js`), code);
  return code;
}

// ===================
// Install plan: selected modules + their dependencies. Missing modules are
// always installed; newer versions only with includeUpdates. A module whose
// required minimum version of a dependency is not installed pulls that update.
// ===================
function plan(includeUpdates) {
  if (!catalog) return { install: [], pending: [], keep: Object.keys(installed) };
  const needed = requiredClosure(catalog.modules, selectedModules());
  const install = new Map();
  const target = (id) => install.get(id) ?? installed[id];
  for (const id of needed) {
    const entry = catalogModule(id);
    const current = installed[id];
    if (!current || (includeUpdates && isNewerVersion(entry.version, current.version)))
      install.set(id, entry);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const id of needed) {
      for (const [dep, min] of Object.entries(target(id)?.requires ?? catalogModule(id).requires)) {
        const depVersion = target(dep)?.version;
        if (depVersion && !isNewerVersion(min, depVersion)) continue;
        if (!install.has(dep)) {
          install.set(dep, catalogModule(dep));
          changed = true;
        }
      }
    }
  }
  const removed = Object.keys(installed).filter(
    (id) => !catalogModule(id) && (id === "core" || selectedModules().includes(id)),
  );
  const pending = [...needed]
    .filter((id) => !install.has(id) && installed[id])
    .map((id) => ({ entry: catalogModule(id), current: installed[id] }))
    .filter(({ entry, current }) => isNewerVersion(entry.version, current.version));
  return { install: [...install.values()], pending, keep: [...needed, ...removed] };
}

async function applyPlan(includeUpdates) {
  const { install, keep } = plan(includeUpdates);
  await Promise.all(install.map((m) => fetchCode(m.hash)));
  const next = Object.fromEntries(Object.entries(installed).filter(([id]) => keep.includes(id)));
  for (const m of install) {
    next[m.id] = { version: m.version, hash: m.hash, requires: m.requires };
    log(`Installing ${m.id} ${m.version}`);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(installed);
  installed = next;
  if (changed) {
    mkdirSync(CODE_DIR, { recursive: true });
    writeFileSync(INSTALLED_PATH, JSON.stringify({ modules: installed }));
    const used = new Set(Object.values(installed).map((m) => `${m.hash}.js`));
    for (const file of readdirSync(CODE_DIR, { withFileTypes: true }))
      if (file.isFile() && !used.has(file.name)) rmSync(join(CODE_DIR, file.name));
  }
  return changed;
}

function injectedCode() {
  const order = [
    ...(catalog?.modules.map((m) => m.id) ?? []),
    ...Object.keys(installed).filter((id) => !catalogModule(id)),
  ];
  const ids = order.filter((id) => installed[id]);
  if (ids.length) return ids.map((id) => readCode(installed[id].hash) ?? "").join("\n");
  return readJsonFile(LEGACY_RELEASE_PATH, null)?.code ?? null;
}

// ===================
// Page bridge
// ===================
const pageState = () => {
  const { pending } = plan(false);
  return {
    protocol: 2,
    autoUpdate: settings.autoUpdate,
    checkedAt,
    error: lastError,
    catalog: catalog && {
      commit: catalog.commit,
      publishedAt: catalog.publishedAt,
      modules: catalog.modules.map(({ hash, ...meta }) => meta),
    },
    installed: Object.fromEntries(
      Object.entries(installed).map(([id, m]) => [id, { version: m.version }]),
    ),
    selected: selectedModules(),
    pending: pending.map(({ entry, current }) => ({
      id: entry.id,
      name: entry.name,
      from: current.version,
      to: entry.version,
    })),
    removed: Object.keys(installed).filter((id) => catalog && !catalogModule(id)),
  };
};
const stateAssignment = () => `window.__gatherModsLauncherState = ${JSON.stringify(pageState())};`;
const pageSource = (code) =>
  `if (window.top === window && location.href.startsWith(${JSON.stringify(GATHER_PAGE_PREFIX)})) {\n${stateAssignment()}\n${code ?? ""}\n}`;
const statePush = () =>
  `${stateAssignment()} window.dispatchEvent(new CustomEvent("gathermods:launcher-state"));`;

class CdpSession {
  #nextId = 1;
  #pending = new Map();
  onEvent = null;

  constructor(webSocketUrl) {
    this.ws = new WebSocket(webSocketUrl);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.closed = new Promise((resolve) =>
      this.ws.addEventListener("close", resolve, { once: true }),
    );
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        this.onEvent?.(message);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.closed.then(() => {
      for (const { reject } of this.#pending.values()) reject(new Error("CDP connection closed"));
      this.#pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
}

const sessions = new Map();

function syncSession(targetId, reinjectMod) {
  const session = sessions.get(targetId);
  if (!session) return Promise.resolve();
  session.queue = session.queue
    .then(async () => {
      const source = pageSource(injectedCode());
      if (session.scriptId)
        await session.cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: session.scriptId,
        });
      const { identifier } = await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source,
      });
      session.scriptId = identifier;
      await session.cdp.send("Runtime.evaluate", {
        expression: reinjectMod ? source : statePush(),
      });
    })
    .catch((e) => log("Page sync failed:", e.message));
  return session.queue;
}
const syncAllSessions = (reinjectMod) =>
  Promise.all([...sessions.keys()].map((id) => syncSession(id, reinjectMod)));

async function update(includeUpdates) {
  try {
    const changed = await applyPlan(includeUpdates);
    if (changed) log(`Installed modules: ${Object.keys(installed).join(", ")}`);
    return syncAllSessions(changed);
  } catch (e) {
    lastError = `Install failed: ${e.message}`;
    log(lastError);
    return syncAllSessions(false);
  }
}

async function sendDiff(targetId) {
  const session = sessions.get(targetId);
  if (!session) return;
  const diffs = [];
  for (const { entry, current } of plan(false).pending) {
    const before = readCode(current.hash) ?? "";
    const after = await fetchCode(entry.hash);
    diffs.push({
      id: entry.id,
      name: entry.name,
      from: current.version,
      to: entry.version,
      changes: entry.changelog
        .filter((c) => isNewerVersion(c.version, current.version))
        .flatMap((c) => c.changes.map((text) => `${c.version}: ${text}`)),
      diff: unifiedDiff(before, after),
    });
  }
  await session.cdp.send("Runtime.evaluate", {
    expression: `window.__gatherModsLauncherDiff = ${JSON.stringify(diffs)}; window.dispatchEvent(new CustomEvent("gathermods:launcher-diff"));`,
  });
}

async function handlePageMessage(payload, targetId) {
  let message;
  try {
    message = JSON.parse(payload);
  } catch {
    return;
  }
  if (message.type === "set-auto-update") {
    settings.autoUpdate = message.value === true;
    saveSettings();
    log(`Auto-update ${settings.autoUpdate ? "enabled" : "disabled"}`);
    return update(settings.autoUpdate);
  }
  if (message.type === "set-modules" && Array.isArray(message.modules)) {
    settings.modules = message.modules.filter((id) => userModuleIds().includes(id));
    saveSettings();
    log(`Selected modules: ${settings.modules.join(", ") || "none"}`);
    return update(settings.autoUpdate);
  }
  if (message.type === "apply-update") return update(true);
  if (message.type === "get-state")
    return sessions.get(targetId)?.cdp.send("Runtime.evaluate", { expression: statePush() });
  if (message.type === "check-now") return checkForUpdate();
  if (message.type === "get-diff") return sendDiff(targetId);
}

async function attach(target) {
  const cdp = new CdpSession(target.webSocketDebuggerUrl);
  sessions.set(target.id, { cdp, scriptId: null, queue: Promise.resolve() });
  cdp.onEvent = (message) => {
    if (message.method === "Runtime.bindingCalled" && message.params.name === PAGE_BINDING)
      handlePageMessage(message.params.payload, target.id).catch((e) =>
        log("Page message failed:", e.message),
      );
  };
  try {
    await cdp.opened;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.addBinding", { name: PAGE_BINDING });
    await syncSession(target.id, true);
    log(`Injected modules into ${target.url}`);
  } catch (e) {
    log("Injection failed:", e.message);
    sessions.delete(target.id);
    cdp.ws.close();
    return;
  }
  cdp.closed.then(() => sessions.delete(target.id));
}

async function checkForUpdate() {
  await fetchCatalog();
  const { pending } = plan(false);
  if (pending.length && !settings.autoUpdate)
    log(`Updates available: ${pending.map((p) => `${p.entry.id} ${p.entry.version}`).join(", ")}`);
  return update(settings.autoUpdate);
}

// ===================
// GatherV2 process
// ===================
async function isDebuggerUp() {
  try {
    const res = await fetch(`${DEBUGGER_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

const isGatherRunning = () => spawnSync("pgrep", ["-x", APP_PROCESS]).status === 0;

async function startGatherWithDebugger() {
  if (await isDebuggerUp()) return;
  if (isGatherRunning()) {
    log("GatherV2 is running without the debug port, restarting it");
    execFileSync("osascript", ["-e", `quit app "${APP_PROCESS}"`]);
    for (let i = 0; i < 40 && isGatherRunning(); i++) await sleep(500);
    if (isGatherRunning()) throw new Error("GatherV2 did not quit");
  }
  execFileSync("open", ["-a", APP_PATH, "--args", `--remote-debugging-port=${PORT}`]);
  for (let i = 0; i < 120; i++) {
    if (await isDebuggerUp()) return;
    await sleep(500);
  }
  throw new Error("GatherV2 debug port did not open");
}

async function attachNewPages() {
  try {
    const targets = await (await fetch(`${DEBUGGER_URL}/json/list`)).json();
    for (const target of targets)
      if (
        target.type === "page" &&
        target.url.startsWith(GATHER_PAGE_PREFIX) &&
        !sessions.has(target.id)
      )
        attach(target);
  } catch (e) {
    log("Target polling failed:", e.message);
  }
}

// A single failed probe must not stop the launcher while GatherV2 keeps running.
async function watchGatherPages() {
  let portLostSince = null;
  while (isGatherRunning()) {
    if (await isDebuggerUp()) {
      portLostSince = null;
      await attachNewPages();
    } else {
      portLostSince ??= Date.now();
      if (Date.now() - portLostSince > PORT_LOST_EXIT_MS) {
        log("GatherV2 debug port unreachable for 30s");
        return;
      }
    }
    await sleep(TARGET_POLL_MS);
  }
  log("GatherV2 closed");
}

function acquireLock() {
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    process.kill(Number(readFileSync(LOCK_PATH, "utf8")), 0);
    return false;
  } catch {}
  writeFileSync(LOCK_PATH, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(LOCK_PATH, "utf8") === String(process.pid)) rmSync(LOCK_PATH);
    } catch {}
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));
  return true;
}

if (!acquireLock()) {
  log("Launcher already running, focusing GatherV2");
  execFileSync("open", ["-a", APP_PATH]);
  process.exit(0);
}

// The cached catalog was verified before being written.
try {
  const cachedCatalog = readJsonFile(CATALOG_PATH, null);
  if (cachedCatalog) catalog = parseCatalog(cachedCatalog);
} catch {}
await fetchCatalog();
try {
  await applyPlan(settings.autoUpdate);
} catch (e) {
  lastError = `Install failed: ${e.message}`;
  log(lastError);
}
await startGatherWithDebugger();
if (!injectedCode()) {
  log("No module installed and no cached mod, GatherV2 started without mods");
  process.exit(1);
}
log(`Ready (${Object.keys(installed).join(", ") || "legacy mod"}), watching GatherV2 pages`);
const updateTimer = setInterval(checkForUpdate, UPDATE_CHECK_MS);
await watchGatherPages();
clearInterval(updateTimer);
log("Launcher exiting");
process.exit(0);
