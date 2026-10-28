import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareStandalone } from './test-web-browser-standalone.mjs';

async function fixture(t) {
  const webDir = await mkdtemp(join(tmpdir(), 'lexloop-standalone-prepare-'));
  t.after(() => rm(webDir, { recursive: true, force: true }));
  return webDir;
}

async function createBuild(webDir, { withPublic = true } = {}) {
  await mkdir(join(webDir, '.next/standalone/apps/web'), { recursive: true });
  await mkdir(join(webDir, '.next/static/chunks/app'), { recursive: true });
  await mkdir(join(webDir, '.next/static/css'), { recursive: true });
  await writeFile(join(webDir, '.next/standalone/apps/web/server.js'), 'server fixture');
  await writeFile(join(webDir, '.next/static/chunks/app/page.js'), 'bundle fixture');
  await writeFile(join(webDir, '.next/static/css/app.css'), 'style fixture');
  if (withPublic) {
    await mkdir(join(webDir, 'public'), { recursive: true });
    await writeFile(join(webDir, 'public/icon.svg'), '<svg/>');
  }
}

test('prepares static assets at the standalone server path and copies optional public files', async (t) => {
  const webDir = await fixture(t);
  await createBuild(webDir);

  const result = await prepareStandalone(webDir);

  assert.equal(result.staticFiles, 2);
  assert.equal(result.javascriptFiles, 1);
  assert.equal(result.stylesheetFiles, 1);
  assert.equal(result.publicFiles, 1);
  assert.equal(
    await readFile(
      join(webDir, '.next/standalone/apps/web/.next/static/chunks/app/page.js'),
      'utf8',
    ),
    'bundle fixture',
  );
  assert.equal(
    await readFile(join(webDir, '.next/standalone/apps/web/public/icon.svg'), 'utf8'),
    '<svg/>',
  );
});

test('accepts a build without public assets but still prepares static assets', async (t) => {
  const webDir = await fixture(t);
  await createBuild(webDir, { withPublic: false });

  const result = await prepareStandalone(webDir);

  assert.equal(result.staticFiles, 2);
  assert.equal(result.publicFiles, 0);
});

test('fails clearly when the configured standalone server path is missing', async (t) => {
  const webDir = await fixture(t);
  await mkdir(join(webDir, '.next/static/chunks'), { recursive: true });
  await mkdir(join(webDir, '.next/static/css'), { recursive: true });
  await writeFile(join(webDir, '.next/static/chunks/app.js'), 'bundle fixture');
  await writeFile(join(webDir, '.next/static/css/app.css'), 'style fixture');

  await assert.rejects(prepareStandalone(webDir), /缺少 standalone 服务入口/);
});

test('fails clearly when Next static assets are absent', async (t) => {
  const webDir = await fixture(t);
  await mkdir(join(webDir, '.next/standalone/apps/web'), { recursive: true });
  await writeFile(join(webDir, '.next/standalone/apps/web/server.js'), 'server fixture');

  await assert.rejects(prepareStandalone(webDir), /缺少 Web 构建静态资源目录/);
});

test('fails when static assets do not include both JavaScript and CSS', async (t) => {
  const webDir = await fixture(t);
  await mkdir(join(webDir, '.next/standalone/apps/web'), { recursive: true });
  await mkdir(join(webDir, '.next/static/chunks'), { recursive: true });
  await writeFile(join(webDir, '.next/standalone/apps/web/server.js'), 'server fixture');
  await writeFile(join(webDir, '.next/static/chunks/app.js'), 'bundle fixture');

  await assert.rejects(prepareStandalone(webDir), /Web 静态资源不完整/);
});
