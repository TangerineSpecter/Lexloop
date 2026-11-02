import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = readFileSync(resolve(root, 'deploy/updater/Dockerfile'), 'utf8');
const entrypoint = 'deploy/updater/server.mjs';

function copiedUpdaterFiles(source) {
  const files = new Set();
  for (const [, instruction] of source.matchAll(/^COPY\s+(.+?)\s+\.\/?\s*$/gm)) {
    for (const token of instruction.split(/\s+/)) {
      if (token.startsWith('deploy/updater/')) files.add(token);
    }
  }
  return files;
}

function localImports(source) {
  const imports = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

test('updater image copies the complete local runtime import graph', () => {
  const copied = copiedUpdaterFiles(dockerfile);
  assert.ok(copied.has(entrypoint), 'Dockerfile must copy the Node entrypoint');
  assert.match(dockerfile, /CMD\s+\["node",\s*"server\.mjs"\]/);

  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    visited.add(relative);
    assert.ok(copied.has(relative), `${relative} is imported at runtime but not copied`);
    const absolute = resolve(root, relative);
    assert.ok(existsSync(absolute), `${relative} is referenced but missing from the build context`);
    const source = readFileSync(absolute, 'utf8');
    for (const specifier of localImports(source)) {
      const imported = resolve(dirname(absolute), specifier);
      assert.ok(imported.startsWith(`${resolve(root, 'deploy/updater')}${sep}`));
      const importedRelative = imported
        .slice(root.length + 1)
        .split(sep)
        .join('/');
      pending.push(importedRelative);
    }
  }
});
