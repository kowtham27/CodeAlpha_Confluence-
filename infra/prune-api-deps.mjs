// Removes packages the API cannot reach at run time from a production install
// (run by the api-deps stage of infra/Dockerfile).
//
// Why: @prisma/client declares `prisma` (the CLI) and `typescript` as
// OPTIONAL peer dependencies, and pnpm links them because the API has
// `prisma` as a dev dependency. Neither is ever imported at run time: the
// generated client uses only @prisma/client/runtime. But the CLI brings
// Prisma Studio, a bundled Postgres (PGlite), React, Effect and more: about
// half of node_modules.
//
// How: walk pnpm's virtual store from the given entry points, following each
// package's dependency links, except those two optional peers of
// @prisma/client. Everything in node_modules/.pnpm not reached is deleted.
// Reachability, not a list of names, so a Prisma upgrade cannot leave
// something needed behind or something unneeded in.
import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const root = process.cwd();
const store = join(root, 'node_modules', '.pnpm');
const entries = process.argv.slice(2); // node_modules dirs of the entry packages
const SKIP = { '@prisma/client': new Set(['prisma', 'typescript']) };

/** The .pnpm/<key> directory a real package path lives in. */
const keyOf = (real) => relative(store, real).split(sep)[0];

/** Names linked in a node_modules dir (scoped names one level deeper). */
function linked(dir) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === '.bin' || name === '.pnpm') continue;
    if (name.startsWith('@')) {
      for (const sub of readdirSync(join(dir, name))) out.push(`${name}/${sub}`);
    } else {
      out.push(name);
    }
  }
  return out;
}

const reached = new Set();
const queue = [];

function visit(nodeModules, owner) {
  for (const name of linked(nodeModules)) {
    if (SKIP[owner]?.has(name)) continue;
    let real;
    try {
      real = realpathSync(join(nodeModules, name));
    } catch {
      continue; // a dangling optional link
    }
    if (!real.startsWith(store)) continue; // a workspace package; its deps are entries
    const key = keyOf(real);
    const id = `${key}|${name}`;
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push({ key, name });
  }
}

for (const entry of entries) visit(join(root, entry), null);
while (queue.length > 0) {
  const { key, name } = queue.shift();
  // A package's own dependencies are its siblings in .pnpm/<key>/node_modules.
  const pkgDir = join(store, key, 'node_modules', name);
  const siblings = name.includes('/') ? dirname(dirname(pkgDir)) : dirname(pkgDir);
  visit(siblings, name);
}

const keep = new Set([...reached].map((id) => id.split('|')[0]));
let removed = 0;
for (const key of readdirSync(store)) {
  const path = join(store, key);
  if (keep.has(key) || !statSync(path).isDirectory() || key === 'node_modules') continue;
  rmSync(path, { recursive: true, force: true });
  removed += 1;
}
console.log(`prune-api-deps: kept ${keep.size} packages, removed ${removed}`);
