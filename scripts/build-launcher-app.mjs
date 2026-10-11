import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "launcher/gather-mods-launcher.mjs");
const APP = join(homedir(), "Applications/Gather Mods.app");
const LOG = join(homedir(), "Library/Logs/gather-mods-launcher.log");
const GATHER_APP = "/Applications/GatherV2.app";

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const command = `nohup ${shellQuote(process.execPath)} ${shellQuote(LAUNCHER)} >> ${shellQuote(LOG)} 2>&1 &`;
const appleScript = `do shell script ${JSON.stringify(command)}`;

mkdirSync(dirname(APP), { recursive: true });
rmSync(APP, { recursive: true, force: true });
execFileSync("osacompile", ["-o", APP, "-e", appleScript]);

const iconName = execFileSync("defaults", [
  "read",
  join(GATHER_APP, "Contents/Info.plist"),
  "CFBundleIconFile",
])
  .toString()
  .trim()
  .replace(/\.icns$/, "");
copyFileSync(
  join(GATHER_APP, "Contents/Resources", `${iconName}.icns`),
  join(APP, "Contents/Resources/applet.icns"),
);
execFileSync("touch", [APP]);
console.log(`Built ${APP} (logs: ${LOG})`);
