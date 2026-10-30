#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultWebDir = resolve(rootDir, 'apps/web');
let activeCommand;
let activeServer;
let interruptedBy;

export function classifyBrowserProcess(comm) {
  if (comm.startsWith('chromium-subre')) return 'subreaper';
  if (comm.startsWith('chrome_crashpa') || comm.startsWith('chromium_crash')) return 'crashpad';
  if (comm === 'chromium') return 'chromium';
  return null;
}

export async function collectBrowserProcessSnapshot() {
  const host = hostname();
  if (process.platform !== 'linux') return { supported: false, host, bootId: null, counts: null };

  let bootId = null;
  try {
    bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return { supported: false, host, bootId: null, counts: null };
  }

  const counts = Object.fromEntries(
    ['chromium', 'crashpad', 'subreaper'].map((name) => [
      name,
      { total: 0, active: 0, zombies: 0 },
    ]),
  );
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const [comm, stat] = await Promise.all([
        readFile(`/proc/${entry.name}/comm`, 'utf8'),
        readFile(`/proc/${entry.name}/stat`, 'utf8'),
      ]);
      const category = classifyBrowserProcess(comm.trim());
      if (!category) continue;
      const state = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0];
      const count = counts[category];
      count.total += 1;
      if (state === 'Z') count.zombies += 1;
      else count.active += 1;
    } catch {
      // A short-lived process may exit between listing /proc and reading its files.
    }
  }
  return { supported: true, host, bootId, counts };
}

function describeBrowserProcessSnapshot(label, snapshot) {
  if (!snapshot.supported)
    return `${label} browser process baseline: unavailable on this executor.`;
  const format = ({ total, active, zombies }) =>
    `${total} total, ${active} active, ${zombies} zombies`;
  return `${label} browser process baseline [${snapshot.host}, boot ${snapshot.bootId}]: chromium ${format(snapshot.counts.chromium)}; crashpad ${format(snapshot.counts.crashpad)}; subreaper ${format(snapshot.counts.subreaper)}.`;
}

function describeBrowserProcessDelta(before, after) {
  if (!before.supported || !after.supported)
    return 'Browser process baseline comparison unavailable; at least one snapshot is unavailable.';
  if (before.host !== after.host || before.bootId !== after.bootId)
    return 'Browser process baseline comparison skipped because the executor identity changed.';
  const delta = (name, key) => after.counts[name][key] - before.counts[name][key];
  return `Browser process delta [same executor]: chromium ${delta('chromium', 'total')} total/${delta('chromium', 'zombies')} zombies; crashpad ${delta('crashpad', 'total')}/${delta('crashpad', 'zombies')}; subreaper ${delta('subreaper', 'total')}/${delta('subreaper', 'zombies')}.`;
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      interruptedBy = signal;
      signalProcessGroup(activeCommand, signal);
      signalProcessGroup(activeServer, signal);
    });
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listFiles(directory) {
  const files = [];
  async function visit(current, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative.split(sep).join('/'));
    }
  }
  await visit(directory);
  return files.sort();
}

async function copyContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    await cp(join(source, name), join(destination, name), { recursive: true, force: true });
  }
}

async function prepareChromiumSubreaper() {
  if (process.platform !== 'linux') return null;
  const directory = await mkdtemp(join(tmpdir(), 'lexloop-chromium-reaper-'));
  const executable = join(directory, 'chromium-subreaper');
  const source = join(rootDir, 'apps/web/test/chromium-subreaper.c');
  const compiler = process.env.CC ?? 'cc';
  const result = spawnSync(
    compiler,
    ['-std=c11', '-O2', '-Wall', '-Wextra', source, '-o', executable],
    {
      cwd: rootDir,
      encoding: 'utf8',
    },
  );
  if (result.error || result.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    console.warn('Linux Chromium 子进程回收器不可用；将退回进程组清理。');
    return null;
  }
  return { directory, executable };
}

export async function prepareStandalone(webDir = defaultWebDir) {
  const standaloneDir = resolve(webDir, '.next/standalone/apps/web');
  const serverPath = join(standaloneDir, 'server.js');
  const staticSource = resolve(webDir, '.next/static');
  const staticDestination = join(standaloneDir, '.next/static');

  if (!(await isFile(serverPath))) {
    throw new Error(
      `缺少 standalone 服务入口：${serverPath}。请检查 next.config.ts 的 outputFileTracingRoot 与 Next.js 输出布局。`,
    );
  }
  if (!(await isDirectory(staticSource))) {
    throw new Error(`缺少 Web 构建静态资源目录：${staticSource}。请先运行 next build。`);
  }

  const sourceFiles = await listFiles(staticSource);
  const javascriptFiles = sourceFiles.filter((path) => path.endsWith('.js'));
  const stylesheetFiles = sourceFiles.filter((path) => path.endsWith('.css'));
  if (!sourceFiles.length || !javascriptFiles.length || !stylesheetFiles.length) {
    throw new Error(
      `Web 静态资源不完整：${sourceFiles.length} 个文件、${javascriptFiles.length} 个 JS、${stylesheetFiles.length} 个 CSS。`,
    );
  }

  await copyContents(staticSource, staticDestination);
  for (const relative of sourceFiles) {
    const source = join(staticSource, relative);
    const destination = join(staticDestination, relative);
    if (!(await isFile(destination)))
      throw new Error(`standalone 静态资源复制后缺少文件：${destination}`);
    if ((await stat(source)).size !== (await stat(destination)).size)
      throw new Error(`standalone 静态资源复制后大小不一致：${relative}`);
  }

  const publicSource = resolve(webDir, 'public');
  let publicFiles = [];
  if (await isDirectory(publicSource)) {
    publicFiles = await listFiles(publicSource);
    const publicDestination = join(standaloneDir, 'public');
    await copyContents(publicSource, publicDestination);
    for (const relative of publicFiles) {
      const source = join(publicSource, relative);
      const destination = join(publicDestination, relative);
      if (!(await isFile(destination)))
        throw new Error(`standalone public 资源复制后缺少文件：${destination}`);
      if ((await stat(source)).size !== (await stat(destination)).size)
        throw new Error(`standalone public 资源复制后大小不一致：${relative}`);
    }
  }

  return {
    serverPath,
    staticDestination,
    staticFiles: sourceFiles.length,
    javascriptFiles: javascriptFiles.length,
    stylesheetFiles: stylesheetFiles.length,
    publicFiles: publicFiles.length,
  };
}

export async function verifyDashboardCodeSplits(webDir = defaultWebDir) {
  const buildDir = join(webDir, '.next');
  const appManifest = JSON.parse(await readFile(join(buildDir, 'app-build-manifest.json'), 'utf8'));
  const loadableManifest = JSON.parse(
    await readFile(join(buildDir, 'react-loadable-manifest.json'), 'utf8'),
  );
  const layoutFiles = appManifest.pages?.['/layout'];
  if (!Array.isArray(layoutFiles)) throw new Error('构建清单缺少共享布局：/layout');
  const routeAssets = new Map(
    [
      '/page',
      '/dashboard/page',
      '/dashboard/notebook/page',
      '/dashboard/micro-stories/page',
      '/dashboard/practice/page',
    ].map((route) => {
      const files = appManifest.pages?.[route];
      if (!Array.isArray(files)) throw new Error(`构建清单缺少首页路由：${route}`);
      return [route, new Set([...layoutFiles, ...files])];
    }),
  );
  const requiredDynamicImports = [
    'app/page.tsx -> ../components/dashboard',
    'components/dashboard-route.tsx -> ./dashboard',
    'components/dashboard.tsx -> ./learning-history-page',
    'components/dashboard.tsx -> ./mistakes-page',
    'components/dashboard.tsx -> ./statistics-page',
    'components/dashboard.tsx -> ./system-settings',
    'components/dashboard.tsx -> ./travel-scenario-page',
  ];
  const sharedLayoutAssets = new Set(layoutFiles);
  const deferredAssets = new Set();
  for (const key of requiredDynamicImports) {
    const entry = loadableManifest[key];
    if (!entry?.files?.some((file) => file.endsWith('.js'))) {
      throw new Error(`Dashboard 按需加载模块未进入独立构建块：${key}`);
    }
    for (const file of entry.files) {
      if (file.endsWith('.js') && !sharedLayoutAssets.has(file)) deferredAssets.add(file);
    }
  }
  const allInitialAssets = new Set([...routeAssets.values()].flatMap((assets) => [...assets]));
  const included = [...deferredAssets].filter((file) => allInitialAssets.has(file));
  if (included.length) {
    throw new Error(`首页首屏仍包含延迟模块：${included.join(', ')}`);
  }

  for (const [route, assets] of routeAssets) {
    if (!assets.size) throw new Error(`${route} 首屏没有脚本资源`);
  }

  const sizes = {};
  for (const [route, assets] of routeAssets) {
    let rawBytes = 0;
    let gzipBytes = 0;
    for (const file of assets) {
      if (!file.endsWith('.js')) continue;
      const bytes = await readFile(join(buildDir, file));
      rawBytes += bytes.length;
      gzipBytes += gzipSync(bytes, { level: 9 }).length;
    }
    if (gzipBytes > 150_000) {
      throw new Error(`${route} 首页 JavaScript 超过 150 KB gzip：${gzipBytes} 字节`);
    }
    sizes[route] = { rawBytes, gzipBytes };
  }
  return sizes;
}

function run(command, args, { cwd, env = process.env, label }) {
  if (interruptedBy) return Promise.reject(new Error(`验收已被 ${interruptedBy} 中断。`));
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      rejectRun(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    activeCommand = child;
    child.once('error', (error) => {
      if (activeCommand === child) activeCommand = undefined;
      rejectRun(new Error(`${label}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (activeCommand === child) activeCommand = undefined;
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${label} 失败${signal ? `（${signal}）` : `（退出码 ${code}）`}`));
    });
  });
}

async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise((resolveListen, rejectListen) => {
    listener.once('error', rejectListen);
    listener.listen(0, '127.0.0.1', resolveListen);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('无法分配本地浏览器测试端口。');
  await new Promise((resolveClose, rejectClose) =>
    listener.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

async function waitForHttp(child, url) {
  let lastError = '服务尚未就绪';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (interruptedBy) throw new Error(`验收已被 ${interruptedBy} 中断。`);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `standalone 服务提前退出${child.signalCode ? `（${child.signalCode}）` : `，退出码 ${child.exitCode}`}。`,
      );
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`standalone 服务在 30 秒内未就绪：${lastError}`);
}

async function verifyRenderedAssets(baseUrl) {
  const pageUrl = new URL('/dashboard/practice?tab=output', baseUrl);
  const response = await fetch(pageUrl);
  if (!response.ok) throw new Error(`浏览器测试页面返回 HTTP ${response.status}。`);
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']*\/_next\/static\/[^"']+)["']/g)].map(
    (match) => match[1],
  );
  const uniqueAssets = [...new Set(assets)];
  if (!uniqueAssets.some((asset) => /\.js(?:\?|$)/.test(asset)))
    throw new Error('standalone 页面没有引用 Next.js JavaScript 静态资源。');
  if (!uniqueAssets.some((asset) => /\.css(?:\?|$)/.test(asset)))
    throw new Error('standalone 页面没有引用 Next.js CSS 静态资源。');
  for (const asset of uniqueAssets) {
    const assetResponse = await fetch(new URL(asset, baseUrl));
    if (!assetResponse.ok)
      throw new Error(`standalone 静态资源返回 HTTP ${assetResponse.status}：${asset}`);
  }
  return uniqueAssets.length;
}

async function stopServer(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function checkBrowserExecutable(executable) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `浏览器不可用：${executable}。可通过 LAB_BROWSER_EXECUTABLE 指定 Chromium 可执行文件。`,
    );
  }
}

async function main() {
  const webDir = defaultWebDir;
  const browserExecutable = process.env.LAB_BROWSER_EXECUTABLE ?? 'chromium';
  checkBrowserExecutable(browserExecutable);

  await run(resolve(webDir, 'node_modules/.bin/next'), ['build'], {
    cwd: webDir,
    label: 'Web 生产构建',
  });
  const dashboardBundleSizes = await verifyDashboardCodeSplits(webDir);
  console.log(
    `首页首屏 JavaScript（原始 / gzip）：/ ${dashboardBundleSizes['/page'].rawBytes} / ${dashboardBundleSizes['/page'].gzipBytes} 字节，/dashboard ${dashboardBundleSizes['/dashboard/page'].rawBytes} / ${dashboardBundleSizes['/dashboard/page'].gzipBytes} 字节。`,
  );
  const prepared = await prepareStandalone(webDir);
  console.log(
    `standalone 资源已准备：${prepared.staticFiles} 个静态文件（${prepared.javascriptFiles} JS / ${prepared.stylesheetFiles} CSS），${prepared.publicFiles} 个 public 文件。`,
  );

  const standaloneDir = dirname(prepared.serverPath);
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const subreaper = await prepareChromiumSubreaper();
  if (subreaper) console.log('Linux Chromium 子进程回收器已就绪。');
  const processBaseline = await collectBrowserProcessSnapshot();
  console.log(describeBrowserProcessSnapshot('Before', processBaseline));
  const server = spawn(process.execPath, [prepared.serverPath], {
    cwd: standaloneDir,
    env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port) },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  activeServer = server;

  try {
    await waitForHttp(server, `${baseUrl}/dashboard/practice?tab=output`);
    const assetCount = await verifyRenderedAssets(baseUrl);
    console.log(`standalone 页面与 ${assetCount} 个 JS/CSS 资源均可访问。`);

    const tests = (await readdir(join(webDir, 'test')))
      .filter((name) => name.endsWith('.browser.test.mjs'))
      .sort()
      .map((name) => join('test', name));
    if (!tests.length) throw new Error('没有找到 test/*.browser.test.mjs 浏览器验收文件。');
    await run(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
      cwd: webDir,
      env: {
        ...process.env,
        ...(subreaper ? { LAB_CHROMIUM_SUBREAPER: subreaper.executable } : {}),
        LAB_BROWSER_EXECUTABLE: browserExecutable,
        LAB_BROWSER_TEST_URL: baseUrl,
      },
      label: 'standalone 浏览器回归',
    });
  } finally {
    try {
      await stopServer(server);
    } finally {
      if (activeServer === server) activeServer = undefined;
      try {
        if (subreaper) await rm(subreaper.directory, { recursive: true, force: true });
      } finally {
        const processAfter = await collectBrowserProcessSnapshot();
        console.log(describeBrowserProcessSnapshot('After', processAfter));
        console.log(describeBrowserProcessDelta(processBaseline, processAfter));
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSignalHandlers();
  main().catch((error) => {
    console.error(
      `standalone 浏览器验收失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
