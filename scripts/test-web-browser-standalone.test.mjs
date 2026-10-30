import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareStandalone, verifyDashboardCodeSplits } from './test-web-browser-standalone.mjs';

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

async function createDashboardBuild(webDir, { preloadStatistics = false } = {}) {
  const buildDir = join(webDir, '.next');
  const staticDir = join(buildDir, 'static/chunks');
  await mkdir(staticDir, { recursive: true });
  const files = [
    'shared.js',
    'home.js',
    'dashboard-route.js',
    'dashboard.js',
    'notebook-route.js',
    'stories-route.js',
    'practice-route.js',
    'history.js',
    'mistakes.js',
    'statistics.js',
    'settings.js',
    'travel.js',
  ];
  for (const file of files) await writeFile(join(staticDir, file), `fixture:${file}`);
  const dynamicManifest = {
    'app/page.tsx -> ../components/dashboard': { files: ['static/chunks/dashboard.js'] },
    'components/dashboard-route.tsx -> ./dashboard': {
      files: ['static/chunks/dashboard.js'],
    },
    'components/dashboard.tsx -> ./learning-history-page': { files: ['static/chunks/history.js'] },
    'components/dashboard.tsx -> ./mistakes-page': { files: ['static/chunks/mistakes.js'] },
    'components/dashboard.tsx -> ./statistics-page': { files: ['static/chunks/statistics.js'] },
    'components/dashboard.tsx -> ./system-settings': { files: ['static/chunks/settings.js'] },
    'components/dashboard.tsx -> ./travel-scenario-page': { files: ['static/chunks/travel.js'] },
  };
  const homeFiles = ['static/chunks/shared.js', 'static/chunks/home.js'];
  const dashboardFiles = ['static/chunks/shared.js', 'static/chunks/dashboard-route.js'];
  const notebookFiles = ['static/chunks/shared.js', 'static/chunks/notebook-route.js'];
  const storiesFiles = ['static/chunks/shared.js', 'static/chunks/stories-route.js'];
  const practiceFiles = ['static/chunks/shared.js', 'static/chunks/practice-route.js'];
  if (preloadStatistics) dashboardFiles.push('static/chunks/statistics.js');
  await writeFile(
    join(buildDir, 'app-build-manifest.json'),
    JSON.stringify({
      pages: {
        '/layout': ['static/chunks/shared.js'],
        '/page': homeFiles,
        '/dashboard/page': dashboardFiles,
        '/dashboard/notebook/page': notebookFiles,
        '/dashboard/micro-stories/page': storiesFiles,
        '/dashboard/practice/page': practiceFiles,
      },
    }),
  );
  await writeFile(join(buildDir, 'react-loadable-manifest.json'), JSON.stringify(dynamicManifest));
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

test('verifies dashboard subpages are split out of the initial route JavaScript', async (t) => {
  const webDir = await fixture(t);
  await createDashboardBuild(webDir);

  const sizes = await verifyDashboardCodeSplits(webDir);

  assert.ok(sizes['/page'].gzipBytes > 0);
  assert.ok(sizes['/dashboard/page'].gzipBytes > 0);
  assert.ok(sizes['/dashboard/notebook/page'].gzipBytes > 0);
  assert.ok(sizes['/dashboard/micro-stories/page'].gzipBytes > 0);
  assert.ok(sizes['/dashboard/practice/page'].gzipBytes > 0);
});

test('fails when a deferred learning page leaks back into the initial dashboard bundle', async (t) => {
  const webDir = await fixture(t);
  await createDashboardBuild(webDir, { preloadStatistics: true });

  await assert.rejects(verifyDashboardCodeSplits(webDir), /首屏仍包含延迟模块.*statistics\.js/);
});
