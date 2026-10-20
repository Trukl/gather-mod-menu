// Auto away: sets you Away (or Busy, your choice) after some minutes without
// any input on the computer (keyboard, mouse, in any app), and back to your
// previous status as soon as you use it again. Only a status this module set
// is given back: the same status chosen by hand stays. A conversation or
// meeting in Gather counts as input. The Gather desktop app gives the
// computer's idle time; a browser tab only sees its own page, so it is not
// supported.
window.__gatherMods.define("auto-away", (ctx) => {
  const { GD, me, readJson, writeJson } = ctx;
  const SETTINGS_KEY = "gathermodv2:autoAway";
  // By space user: the status this module set and the one to give back, kept
  // across reloads.
  const RESTORE_KEY = "gathermodv2:autoAwayRestore";
  const POLL_MS = 5000;
  // Input within two polls means the user is back.
  const BACK_SECONDS = (2 * POLL_MS) / 1000;
  const MINUTES = { min: 1, max: 120, default: 5 };
  const IDLE_STATUSES = ["Away", "Busy"];
  const IN_OFFICE = ["Active", "Busy"];

  const settings = {
    enabled: true,
    minutes: MINUTES.default,
    idleStatus: "Away",
    ...readJson(SETTINGS_KEY, {}),
  };
  const interop = () => window._electron_interop ?? null;
  const isSupported = () => typeof interop()?.getSystemIdleTime === "function";
  // Gather's own test for a conversation or meeting with someone.
  const inConversation = () => GD().Repos.avConnections.hasStrongConnections;
  let conversationAt = 0;
  let status = "";
  let checking = false;

  async function setAvailability(user, availability) {
    await user.setAvailability({ availability, debugSource: "GatherMods.autoAway" });
  }
  async function check() {
    const user = me();
    if (checking || !isSupported() || !user?.connected) return;
    checking = true;
    try {
      if (inConversation()) conversationAt = Date.now();
      const idle = await interop().getSystemIdleTime();
      const restore = readJson(RESTORE_KEY, {});
      const current = user.userSetAvailability.value;
      const auto = restore[user.id];
      if (auto) {
        const back = idle < BACK_SECONDS;
        if (current === auto.set && back) await setAvailability(user, auto.previous);
        // Offline: the screen got locked (Gather's own auto-offline), wait.
        // Any other status: the user picked it, nothing to give back.
        if (current !== "Offline" && (current !== auto.set || back)) {
          delete restore[user.id];
          writeJson(RESTORE_KEY, restore);
          status = "";
        }
      } else if (
        settings.enabled &&
        Math.min(idle, (Date.now() - conversationAt) / 1000) >= settings.minutes * 60 &&
        IN_OFFICE.includes(current) &&
        current !== settings.idleStatus
      ) {
        const set = settings.idleStatus;
        writeJson(RESTORE_KEY, { ...restore, [user.id]: { set, previous: current } });
        await setAvailability(user, set);
        status = `Set ${set} at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, back to ${current} on your next input`;
      }
    } catch (e) {
      status = "Could not change your status: " + e.message;
    } finally {
      checking = false;
      render();
    }
  }
  const timer = setInterval(check, POLL_MS);
  ctx.onCleanup(() => clearInterval(timer));

  let root = null;
  function render() {
    if (!root?.isConnected) return;
    const toggle = root.querySelector("#gm-away-toggle");
    toggle.checked = settings.enabled;
    toggle.disabled = !isSupported();
    root
      .querySelectorAll("#gm-away-idle-status button")
      .forEach((b) => b.classList.toggle("on", b.dataset.status === settings.idleStatus));
    root.querySelector("#gm-away-status").textContent = !isSupported()
      ? "Only in the Gather desktop app: a browser tab can't see activity in other apps"
      : status ||
        (!settings.enabled
          ? "Off"
          : inConversation()
            ? `In a conversation: no ${settings.idleStatus} until it ends`
            : `${settings.idleStatus} after ${settings.minutes} min without keyboard, mouse or conversation, back on your next input. ${settings.idleStatus} set by hand stays.`);
  }
  const save = () => writeJson(SETTINGS_KEY, settings);

  ctx.section({
    title: "Auto away",
    status: () => {
      const auto = readJson(RESTORE_KEY, {})[me()?.id];
      return auto ? auto.set : settings.enabled && isSupported() ? "On" : null;
    },
    html: `
      <label class="gm-toggle">
        <span class="gm-toggle-text"><span class="gm-toggle-title">Auto away</span><span class="gm-hint">When you leave your computer, back on your next input</span></span>
        <input type="checkbox" class="gm-switch" id="gm-away-toggle" />
      </label>
      <div class="gm-prop"><span>Status when idle</span><div class="gm-seg" id="gm-away-idle-status">${IDLE_STATUSES.map((s) => `<button data-status="${s}">${s}</button>`).join("")}</div></div>
      <div class="gm-prop"><span>After</span><label class="gm-field"><input class="gm-input" id="gm-away-minutes" type="number" min="${MINUTES.min}" max="${MINUTES.max}" step="1" /><span class="gm-unit">min</span></label></div>
      <div class="gm-note"><i class="gm-i sm" data-i="moon"></i><span id="gm-away-status"></span></div>`,
    mount(el) {
      root = el;
      const toggle = el.querySelector("#gm-away-toggle");
      toggle.addEventListener("change", () => {
        settings.enabled = toggle.checked;
        save();
        render();
      });
      el.querySelectorAll("#gm-away-idle-status button").forEach((b) => {
        b.onclick = () => {
          settings.idleStatus = b.dataset.status;
          save();
          render();
        };
      });
      const minutes = el.querySelector("#gm-away-minutes");
      minutes.value = settings.minutes;
      minutes.addEventListener("keydown", (e) => e.stopPropagation());
      minutes.addEventListener("input", () => {
        const value = Math.round(Number(minutes.value));
        if (!Number.isFinite(value) || value < MINUTES.min || value > MINUTES.max) return;
        settings.minutes = value;
        save();
        render();
      });
      render();
    },
  });
});
