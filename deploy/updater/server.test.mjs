import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

async function until(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

async function fixture(t, { staleState = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lexloop-updater-test-'));
  const repository = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repository);
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (...args) =>
    execFileSync(realGit, ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '--initial-branch=master');
  git('config', 'user.name', 'Deployment test');
  git('config', 'user.email', 'deployment@example.invalid');
  function commit(version) {
    for (const file of [
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'apps/worker/package.json',
      'packages/types/package.json',
    ]) {
      const path = join(repository, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version }));
    }
    git('add', '.');
    git('commit', '-m', version);
    git('tag', '-a', `v${version}`, '-m', version);
    return git('rev-parse', 'HEAD');
  }
  const previousSha = commit('1.0.0');
  const targetSha = commit('1.0.3');
  git('update-ref', 'refs/remotes/origin/master', targetSha);
  git('remote', 'add', 'origin', 'https://github.com/TangerineSpecter/Lexloop.git');
  const previousRelease = join(root, 'old-release');
  mkdirSync(previousRelease);
  const productionEnv = join(root, 'production.env');
  writeFileSync(
    productionEnv,
    `APP_VERSION=1.0.0\nAPP_COMMIT_SHA=${previousSha}\nLEXLOOP_IMAGE_TAG=old\nCURRENT_RELEASE_PATH=${previousRelease}\n`,
  );
  const stateFile = join(root, 'state.json');
  if (staleState)
    writeFileSync(
      stateFile,
      JSON.stringify({ deployment: { version: '0.9.0', sha: 'old' }, history: [] }),
    );
  function executable(name, source) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  }
  executable(
    'git',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('fetch')) {
      fs.appendFileSync(${JSON.stringify(join(root, 'fetches'))}, 'fetch\\n');
      const gate = ${JSON.stringify(join(root, 'hold-fetch'))};
      if (fs.existsSync(gate)) { const timer = setInterval(() => { if (!fs.existsSync(gate)) clearInterval(timer); }, 20); }
    } else {
      const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
      process.exitCode = result.status ?? 1;
    }
  `,
  );
  executable(
    'docker',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(join(root, 'docker.log'))}, JSON.stringify({args, version: process.env.APP_VERSION}) + '\\n');
    if (args[0] === 'exec') process.stdout.write('database-backup');
    if (args.includes('up') && args.includes('web') && process.env.APP_VERSION === '1.0.3' && fs.existsSync(${JSON.stringify(join(root, 'fail-switch'))})) process.exitCode = 1;
  `,
  );
  executable(
    'curl',
    `process.stdout.write(JSON.stringify({version: '1.0.3', commitSha: ${JSON.stringify(targetSha)}}));`,
  );
  const socket = join(root, 'updater.sock');
  const child = spawn(process.execPath, [resolve('deploy/updater/server.mjs')], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      UPDATER_SOCKET: socket,
      UPDATER_STATE_FILE: stateFile,
      BARE_REPOSITORY: join(repository, '.git'),
      RELEASES_DIR: join(root, 'releases'),
      BACKUPS_DIR: join(root, 'backups'),
      PRODUCTION_ENV: productionEnv,
      APP_VERSION: '1.0.0',
      APP_COMMIT_SHA: previousSha,
      LEXLOOP_IMAGE_TAG: 'old',
      CURRENT_RELEASE_PATH: previousRelease,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => (logs += data));
  child.stderr.on('data', (data) => (logs += data));
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    rmSync(root, { recursive: true, force: true });
  });
  await until(
    () => existsSync(socket) || (child.exitCode !== null && assert.fail(logs)),
    'server startup',
  );
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, method, path, timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('request timeout')));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  return {
    root,
    call,
    targetSha,
    previousSha,
    productionEnv,
    stateFile,
    commands: () =>
      existsSync(join(root, 'docker.log'))
        ? readFileSync(join(root, 'docker.log'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    apply: () =>
      call('POST', '/apply', {
        targetVersion: '1.0.3',
        targetSha,
        actorId: 'admin',
        actorEmail: 'admin@example.invalid',
      }),
  };
}

test('reinstall reconciles persisted identity with the installed release', async (t) => {
  const f = await fixture(t, { staleState: true });
  const { body } = await f.call('GET', '/status');
  assert.equal(body.updaterAvailable, true);
  assert.equal(body.currentVersion, '1.0.0');
  assert.equal(body.currentSha, f.previousSha);
});

test('slow Git checks leave status responsive and concurrent checks share one fetch', async (t) => {
  const f = await fixture(t);
  const gate = join(f.root, 'hold-fetch');
  writeFileSync(gate, 'hold');
  const first = f.call('POST', '/check');
  const second = f.call('POST', '/check');
  try {
    await until(() => existsSync(join(f.root, 'fetches')), 'fetch started');
    const { body } = await f.call('GET', '/status');
    assert.equal(body.updaterAvailable, true);
  } finally {
    rmSync(gate, { force: true });
  }
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.body.latest.version, '1.0.3');
    assert.equal(result.body.updateAvailable, true);
  }
  assert.equal(readFileSync(join(f.root, 'fetches'), 'utf8').trim(), 'fetch');
});

test('partial compose switch failures restore previous application images', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'fail-switch'), 'fail');
  const result = await f.apply();
  assert.equal(result.status, 202);
  const status = await until(async () => {
    const { body } = await f.call('GET', '/status');
    return body.job?.stage === 'FAILED' && body;
  }, 'failed update');
  assert.equal(status.currentSha, f.previousSha);
  assert.ok(
    f
      .commands()
      .some(
        (command) =>
          command.version === '1.0.0' &&
          command.args.includes('up') &&
          command.args.includes('web'),
      ),
  );
  assert.match(readFileSync(f.productionEnv, 'utf8'), /APP_VERSION=1\.0\.0/);
  assert.ok(!f.commands().some((command) => command.args[0] === 'run'));
});

test('successful updates persist identity and refresh updater in an independent container', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.apply()).status, 202);
  const status = await until(async () => {
    const { body } = await f.call('GET', '/status');
    return body.job?.stage === 'SUCCEEDED' && body;
  }, 'successful update');
  assert.equal(status.currentSha, f.targetSha);
  assert.match(readFileSync(f.productionEnv, 'utf8'), /APP_VERSION=1\.0\.3/);
  const helper = await until(
    () => f.commands().find((command) => command.args[0] === 'run'),
    'updater refresh helper',
  );
  assert.ok(helper.args.includes('--detach'));
  assert.ok(helper.args.includes('--entrypoint'));
  assert.ok(helper.args.includes('--no-build'));
  assert.ok(helper.args.includes(`lexloop-updater:1.0.3-${f.targetSha.slice(0, 12)}`));
});
