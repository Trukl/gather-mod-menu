import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sign, verify } from "sigstore";
import {
  isNewerVersion,
  releaseChanges,
  signedPayload,
  SIGNER_POLICY,
  UPDATES_URL,
} from "../launcher/mod-release.mjs";
import { BUNDLE_PATH, buildBundle, loadLocalCatalog, moduleMeta, ROOT } from "./catalog.mjs";

const { GITHUB_ACTIONS, GITHUB_REF, GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_OUTPUT, DRY_RUN } =
  process.env;
if (GITHUB_ACTIONS !== "true" || GITHUB_REF !== "refs/heads/main")
  throw new Error("Releases are published by the GitHub release workflow on main");
const dryRun = DRY_RUN === "true";

const modules = loadLocalCatalog();
if (readFileSync(BUNDLE_PATH, "utf8") !== buildBundle(modules))
  throw new Error("gather-mod-menu.js is out of date: run `npm run bundle` and commit it");

const published = await fetch(`${UPDATES_URL}/catalog`).then((r) => (r.ok ? r.json() : null));
const publishedModules = published ? JSON.parse(published.manifest).modules : null;
const { errors, changed } = releaseChanges(modules, publishedModules);
if (errors.length) throw new Error("Release refused:\n- " + errors.join("\n- "));
if (!changed.length) {
  if (GITHUB_EVENT_NAME !== "push") throw new Error("Nothing to release: no module changed");
  console.log("Nothing to release: no module changed");
  process.exit(0);
}
console.log("Changes:\n- " + changed.join("\n- "));

const manifest = JSON.stringify({
  commit: GITHUB_SHA,
  modules: modules.map((m) => ({ ...moduleMeta(m), hash: m.hash })),
});
const bundle = await sign(signedPayload(manifest));
await verify(bundle, signedPayload(manifest), SIGNER_POLICY);

async function idToken(audience) {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`OIDC token request failed: HTTP ${res.status}`);
  return (await res.json()).value;
}

const res = await fetch(`${UPDATES_URL}/release${dryRun ? "?dryRun=1" : ""}`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${await idToken(UPDATES_URL)}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    manifest,
    bundle,
    codes: Object.fromEntries(modules.map((m) => [m.hash, m.code])),
  }),
});
const answer = await res.json().catch(() => ({}));
if (!res.ok) throw new Error(`Upload rejected: ${answer.error || `HTTP ${res.status}`}`);
if (dryRun)
  writeFileSync(
    join(ROOT, "release.json"),
    JSON.stringify({ ...answer, codes: Object.fromEntries(modules.map((m) => [m.hash, m.code])) }),
  );
console.log(`${dryRun ? "Dry run OK" : "Released"} (${GITHUB_SHA})`);

// The next job turns these into a GitHub release.
function releaseNotes() {
  const before = new Map((publishedModules ?? []).map((m) => [m.id, m]));
  return modules
    .filter((m) => before.get(m.id)?.hash !== m.hash)
    .map((m) => {
      const from = before.get(m.id)?.version;
      const changes = m.changelog
        .filter((e) => !from || isNewerVersion(e.version, from))
        .flatMap((e) => e.changes.map((c) => `- ${c}`));
      return [
        `### ${m.name} ${from ? `${from} → ${m.version}` : `${m.version} (new)`}`,
        ...changes,
      ].join("\n");
    })
    .join("\n\n");
}
if (!dryRun && GITHUB_OUTPUT) {
  const date = new Date().toISOString().slice(0, 10);
  const short = GITHUB_SHA.slice(0, 7);
  appendFileSync(
    GITHUB_OUTPUT,
    `tag=${date}-${short}\ntitle=Release ${date} (${short})\nnotes<<RELEASE_NOTES_END\n${releaseNotes()}\nRELEASE_NOTES_END\n`,
  );
}
