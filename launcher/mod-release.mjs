export const UPDATES_URL = "https://gather-mod-menu-updates.minnecorentin.workers.dev";

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

export const SIGNER_POLICY = {
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI: `^https://github\\.com/Trukl/gather-mod-menu/${RELEASE_WORKFLOW.replaceAll(".", "\\.")}@refs/heads/main$`,
};

export const signedPayload = (manifest) =>
  Buffer.from(`gather-mod-menu-catalog\n${manifest}`, "utf8");

const parseVersion = (v) => v.split(".").map((n) => Number(n) || 0);

export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const KINDS = ["core", "lib", "module"];
const MAX_NOTICE = 300;

// Modules are listed in load order: core first, dependencies before dependents.
export function catalogErrors(modules) {
  const errors = [];
  const seen = new Map();
  if (modules[0]?.id !== "core" || modules[0]?.kind !== "core")
    errors.push("core must be the first module");
  for (const m of modules) {
    if (!ID_RE.test(m.id)) errors.push(`${m.id}: invalid id`);
    if (seen.has(m.id)) errors.push(`${m.id}: duplicate id`);
    if (!KINDS.includes(m.kind) || (m.kind === "core") !== (m.id === "core"))
      errors.push(`${m.id}: invalid kind ${m.kind}`);
    if (!VERSION_RE.test(m.version)) errors.push(`${m.id}: invalid version ${m.version}`);
    for (const [dep, min] of Object.entries(m.requires ?? {})) {
      const target = seen.get(dep);
      if (!target) errors.push(`${m.id}: requires ${dep}, which must be listed before it`);
      else if (target.kind === "core") errors.push(`${m.id}: core is implicit, do not require it`);
      else if (isNewerVersion(min, target.version))
        errors.push(`${m.id}: requires ${dep} ${min} but the catalog has ${target.version}`);
    }
    if (!m.changelog?.some((e) => e.version === m.version))
      errors.push(`${m.id}: no changelog entry for ${m.version}`);
    for (const e of m.changelog ?? [])
      if (
        e.notice !== undefined &&
        (typeof e.notice !== "string" || !e.notice.trim() || e.notice.length > MAX_NOTICE)
      )
        errors.push(
          `${m.id} ${e.version}: notice must be a non-empty text of ${MAX_NOTICE} characters at most`,
        );
    seen.set(m.id, m);
  }
  return errors;
}

// Compares a candidate catalog to the published one: a changed module needs a
// higher version, an unchanged one keeps its version, nothing goes backwards.
export function releaseChanges(next, published) {
  const errors = [];
  const changed = [];
  const previous = new Map((published ?? []).map((m) => [m.id, m]));
  for (const m of next) {
    const old = previous.get(m.id);
    if (!old) changed.push(`${m.id} ${m.version} (new)`);
    else if (old.hash === m.hash) {
      if (old.version !== m.version)
        errors.push(`${m.id}: version changed to ${m.version} without code change`);
    } else if (!isNewerVersion(m.version, old.version))
      errors.push(`${m.id}: code changed, bump its version above ${old.version}`);
    else changed.push(`${m.id} ${old.version} → ${m.version}`);
  }
  for (const id of previous.keys())
    if (!next.some((m) => m.id === id)) changed.push(`${id} (removed)`);
  return { errors, changed };
}

export function requiredClosure(modules, ids) {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const needed = new Set();
  const visit = (id) => {
    if (needed.has(id) || !byId.has(id)) return;
    needed.add(id);
    for (const dep of Object.keys(byId.get(id).requires ?? {})) visit(dep);
  };
  ["core", ...ids].forEach(visit);
  return needed;
}

function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const trace = [];
  let v = new Int32Array(3);
  v[1] = 0;
  for (let d = 0; d <= max; d++) {
    const next = new Int32Array(2 * d + 3);
    const get = (k) => v[k + d];
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? get(k + 1) : get(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[k + d + 1] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, n, m);
      }
    }
    trace.push(next);
    v = next;
  }
  return [];
}

function backtrack(trace, n, m) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const get = (k) => prev[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push(["=", --x, --y]);
    if (down) ops.push(["+", x, --y]);
    else ops.push(["-", --x, y]);
  }
  while (x > 0 && y > 0) ops.push(["=", --x, --y]);
  return ops.reverse();
}

export function unifiedDiff(before, after, context = 3) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = [
    ...Array.from({ length: start }, (_, i) => ["=", i, i]),
    ...editScript(a.slice(start, endA), b.slice(start, endB)).map(([op, i, j]) => [
      op,
      i + start,
      j + start,
    ]),
    ...Array.from({ length: a.length - endA }, (_, i) => ["=", endA + i, endB + i]),
  ];
  const changed = ops.map((op, i) => (op[0] === "=" ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const hunks = [];
  for (const i of changed) {
    const last = hunks.at(-1);
    if (last && i - last.end <= 2 * context) last.end = i;
    else hunks.push({ start: i, end: i });
  }
  const lines = [];
  for (const h of hunks) {
    const from = Math.max(0, h.start - context);
    const to = Math.min(ops.length - 1, h.end + context);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((o) => o[0] !== "+").length;
    const newCount = slice.filter((o) => o[0] !== "-").length;
    lines.push(`@@ -${slice[0][1] + 1},${oldCount} +${slice[0][2] + 1},${newCount} @@`);
    for (const [op, i, j] of slice)
      lines.push(op === "+" ? `+${b[j]}` : op === "-" ? `-${a[i]}` : ` ${a[i]}`);
  }
  return lines.join("\n");
}
