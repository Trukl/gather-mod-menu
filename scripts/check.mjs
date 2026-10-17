// Checks a pull request against the branch it merges into, with the rules a
// release applies: modules.json is valid, a module whose code changed has a
// higher version (with its changelog entry), its code parses, and the bundle,
// generated on main, is left out. Usage: node scripts/check.mjs [base]
import { execFileSync } from "node:child_process";
import { Script } from "node:vm";
import { releaseChanges } from "../launcher/mod-release.mjs";
import { loadLocalCatalog, moduleMeta, sha256 } from "./catalog.mjs";

const base = process.argv[2] ?? "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const modules = loadLocalCatalog();
const baseModules = JSON.parse(git("show", `${base}:modules.json`)).modules.map((m) => ({
  ...moduleMeta(m),
  hash: sha256(git("show", `${base}:${m.file}`)),
}));
const { errors, changed } = releaseChanges(modules, baseModules);
for (const m of modules) {
  try {
    new Script(m.code, { filename: m.id });
  } catch (e) {
    errors.push(`${m.id}: ${e.message}`);
  }
}
if (git("diff", "--name-only", `${base}...HEAD`, "--", "gather-mod-menu.js").trim())
  errors.push(
    `gather-mod-menu.js is generated on main after the merge: leave it out (git checkout ${base} -- gather-mod-menu.js)`,
  );

if (errors.length) {
  console.error("Check failed:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(changed.length ? "Modules changed:\n- " + changed.join("\n- ") : "No module changed");
