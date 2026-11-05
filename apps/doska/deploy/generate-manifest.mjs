import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'apps/web/dist');
const manifest = JSON.parse(await readFile(path.join(root, 'deploy/gateway-manifest.json'), 'utf8'));
// The portable manifest is reviewed finite input. Asset generation must not
// silently ship the earlier task-search DTO after the native API gains filters.
// Keep ID and 4096-byte raw-query policy unchanged; native validation additionally
// requires projectId plus a complete customFieldId/customFieldValue pair.
const search = manifest.routes.filter(
  (route) =>
    route.method === "GET" && route.path === "/doska/api/doska/task-search",
);
const searchKeys = [
  "limit",
  "offset",
  "q",
  "projectId",
  "assigneeId",
  "coexecutorId",
  "state",
  "priority",
  "dueFrom",
  "dueTo",
  "unassigned",
  "overdue",
  "archived",
  "resourceId",
  "sourceKind",
  "open",
  "upcoming",
  "labelName",
  "customFieldId",
  "customFieldValue",
];
const expectedSearchFilters = {
  open: { required: false, kind: "boolean", allow_empty: false },
  upcoming: { required: false, kind: "boolean", allow_empty: false },
  labelName: {
    required: false,
    kind: "text",
    allow_empty: false,
    max_chars: 100,
    max_bytes: 400,
  },
  customFieldId: {
    required: false,
    kind: "id",
    allow_empty: false,
    max_bytes: 128,
  },
  customFieldValue: {
    required: false,
    kind: "text",
    allow_empty: false,
    max_chars: 2000,
    max_bytes: 4096,
  },
};
if (
  search.length !== 1 ||
  search[0].kind !== "read" ||
  !search[0].query ||
  Object.keys(search[0].query).sort().join(",") !== searchKeys.sort().join(",")
) {
  throw new Error(
    "Task-search manifest does not match the finite public query contract",
  );
}
for (const [name, expected] of Object.entries(expectedSearchFilters)) {
  const rule = search[0].query[name];
  if (
    Object.keys(rule).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => rule[key] !== value)
  ) {
    throw new Error("Stale task-search query contract: " + name);
  }
}
manifest.routes = manifest.routes.filter(route => route.kind !== 'asset');
const assets = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    const stat = await lstat(filename);
    if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in module assets');
    if (stat.isDirectory()) { await visit(filename); continue; }
    if (!stat.isFile()) throw new Error('Invalid module asset');
    const relative = path.relative(dist, filename).split(path.sep).join('/');
    if (relative === 'index.html') continue;
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.includes('..') || /(?:^|\/)\./.test(relative) || relative.endsWith('.map')) {
      throw new Error('Unsafe module asset name');
    }
    assets.push('/doska/' + relative);
  }
}
await visit(dist);
for (const asset of assets.sort()) manifest.routes.push({ method: 'GET', path: asset, kind: 'asset' });
if (!assets.length || manifest.routes.length > 1024) throw new Error('Invalid module asset manifest size');
const output = JSON.stringify(manifest);
if (Buffer.byteLength(output) > 512 * 1024) throw new Error('Module manifest exceeds bound');
await writeFile(path.join(root, 'deploy/gateway-manifest.built.json'), output + '\n');
