import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "launcher/gather-mods-launcher.mjs");
const ICON = join(ROOT, "launcher/icon.icns");
const APP = join(homedir(), "Applications/Gather Mods.app");
const LOG = join(homedir(), "Library/Logs/gather-mods-launcher.log");

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const command = `nohup ${shellQuote(process.execPath)} ${shellQuote(LAUNCHER)} >> ${shellQuote(LOG)} 2>&1 &`;
const appleScript = `do shell script ${JSON.stringify(command)}`;

mkdirSync(dirname(APP), { recursive: true });
rmSync(APP, { recursive: true, force: true });
execFileSync("osacompile", ["-o", APP, "-e", appleScript]);

// osacompile adds the AppleScript icon in Assets.car, which macOS shows
// instead of applet.icns as long as CFBundleIconName names it.
copyFileSync(ICON, join(APP, "Contents/Resources/applet.icns"));
rmSync(join(APP, "Contents/Resources/Assets.car"));
execFileSync("plutil", ["-remove", "CFBundleIconName", join(APP, "Contents/Info.plist")]);
execFileSync("codesign", ["--force", "--sign", "-", APP]);
execFileSync("touch", [APP]);
console.log(`Built ${APP} (logs: ${LOG})`);
