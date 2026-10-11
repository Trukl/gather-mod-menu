import { writeFileSync } from "node:fs";
import { BUNDLE_PATH, buildBundle, loadLocalCatalog } from "./catalog.mjs";

writeFileSync(BUNDLE_PATH, buildBundle(loadLocalCatalog()));
console.log(`Built ${BUNDLE_PATH}`);
