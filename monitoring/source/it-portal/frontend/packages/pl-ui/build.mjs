import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Fixed public filenames identify the backwards-compatible v1 UI API.
// Deploy the tested assets together with their consumers; no application CSS is copied.
const files = { "core.js": "ui-v1.js", "styles.css": "ui-v1.css" };
const output = new URL("../../public/ecosystem/", import.meta.url);
const check = process.argv.includes("--check");
if (!check) await mkdir(output, { recursive: true });
for (const [source, target] of Object.entries(files)) {
  const from = new URL(source, import.meta.url),
    to = new URL(target, output);
  if (check) {
    if (!(await readFile(from)).equals(await readFile(to)))
      throw new Error(
        `Stale UI asset: ${fileURLToPath(to)}. Run npm run ui:build.`,
      );
  } else await copyFile(from, to);
}

// Standalone admin installations must not depend on the Platform being reachable.
// These are generated distribution assets, byte-identical to the shared source.
const standalone = process.argv.includes("--standalone") ? [
  "../../../../monitoring-admin/app/static/ecosystem/",
  "../../../../websites-admin/app/static/ecosystem/",
] : [];
for (const directory of standalone) {
  const target = new URL(directory, import.meta.url);
  if (!check) await mkdir(target, { recursive: true });
  for (const name of [
    "ui-v1.js",
    "ui-v1.css",
    "theme-catalog.js",
    "theme-runtime.js",
    "theme-menu.css",
  ]) {
    const from = new URL(name, output),
      to = new URL(name, target);
    if (check) {
      if (!(await readFile(from)).equals(await readFile(to)))
        throw new Error(`Stale standalone UI asset: ${fileURLToPath(to)}`);
    } else await copyFile(from, to);
  }
}
