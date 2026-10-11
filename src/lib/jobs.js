// Job queue library: map edits from every module run one after the other, in
// click order, so clicks never wait for the previous edit and "delete last"
// always targets what was placed before it.
window.__gatherMods.define("jobs", () => {
  const queue = [];
  let running = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  async function drain() {
    if (running) return;
    while (queue.length) {
      running = queue.shift();
      notify();
      try {
        await running.task(running.controller.signal);
      } catch (e) {
        console.error(`[GatherMods] ${running.owner} job failed`, e);
      }
      running = null;
      notify();
    }
  }

  // replace: drop the owner's queued jobs and abort its running one.
  function run(owner, task, { replace = false } = {}) {
    if (replace) {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].owner === owner) queue.splice(i, 1);
      if (running?.owner === owner) running.controller.abort();
    }
    queue.push({ owner, task, controller: new AbortController() });
    notify();
    drain();
  }

  const isRunning = (owner) => running?.owner === owner;
  const queued = (owner) => queue.filter((j) => j.owner === owner).length;
  const busy = (owner) => isRunning(owner) || queued(owner) > 0;
  const queuedSuffix = (owner) => (queued(owner) ? ` (+${queued(owner)} queued)` : "");

  return { run, busy, isRunning, queued, queuedSuffix, onChange: (fn) => listeners.add(fn) };
});
