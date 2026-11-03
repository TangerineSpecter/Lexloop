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

async function fixture(t, { staleState = false, autoUpdate } = {}) {
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
  if (autoUpdate)
    writeFileSync(
      stateFile,
      JSON.stringify({
        deployment: {
          version: '1.0.0',
          sha: previousSha,
          imageTag: 'old',
          releasePath: previousRelease,
        },
        latest: null,
        checkedAt: null,
        checkError: null,
        checkInProgress: false,
        autoUpdate,
        job: null,
        history: [],
      }),
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
      const planFile = ${JSON.stringify(join(root, 'fetch-plan.json'))};
      const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : [];
      const attempt = fs.readFileSync(${JSON.stringify(join(root, 'fetches'))}, 'utf8').trim().split('\\n').length;
      if (plan[attempt - 1]) {
        process.stderr.write(plan[attempt - 1]);
        process.exitCode = 1;
        return;
      }
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
    if (args.includes('psql')) process.stdout.write(fs.existsSync(${JSON.stringify(join(root, 'supplement-exists'))}) ? 't' : 'f');
    else if (args[0] === 'exec') process.stdout.write('database-backup');
    if (args.includes('up') && args.includes('web') && process.env.APP_VERSION === '1.0.3' && fs.existsSync(${JSON.stringify(join(root, 'fail-switch'))})) {
      if (fs.existsSync(${JSON.stringify(join(root, 'enable-on-switch'))})) fs.writeFileSync(${JSON.stringify(join(root, 'supplement-exists'))}, 'yes');
      process.exitCode = 1;
    }
  `,
  );
  executable(
    'curl',
    `process.stdout.write(JSON.stringify({version: '1.0.3', commitSha: ${JSON.stringify(targetSha)}}));`,
  );
  const socket = join(root, 'updater.sock');
  const serverEnv = {
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
  };
  let logs = '';
  const spawnServer = () => {
    const childProcess = spawn(process.execPath, [resolve('deploy/updater/server.mjs')], {
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childProcess.stdout.on('data', (data) => (logs += data));
    childProcess.stderr.on('data', (data) => (logs += data));
    return childProcess;
  };
  let child = spawnServer();
  const extraChildren = [];
  t.after(async () => {
    for (const childProcess of [child, ...extraChildren]) {
      if (childProcess.exitCode === null) {
        const stopped = once(childProcess, 'exit');
        childProcess.kill();
        await stopped;
      }
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
    startDuplicate: () => {
      const duplicate = spawnServer();
      extraChildren.push(duplicate);
      return duplicate;
    },
    restartAfterUncleanExit: async () => {
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
      const logOffset = logs.length;
      child = spawnServer();
      await until(
        () =>
          logs.slice(logOffset).includes('Lexloop updater listening') ||
          (child.exitCode !== null && assert.fail(logs.slice(logOffset))),
        'server restart after an unclean exit',
      );
    },
    holdFetch: () => writeFileSync(join(root, 'hold-fetch'), 'hold'),
    releaseFetch: () => rmSync(join(root, 'hold-fetch'), { force: true }),
    setFetchPlan: (plan) => {
      writeFileSync(join(root, 'fetches'), '');
      writeFileSync(join(root, 'fetch-plan.json'), JSON.stringify(plan));
    },
    fetchCount: () =>
      existsSync(join(root, 'fetches'))
        ? readFileSync(join(root, 'fetches'), 'utf8').trim().split('\n').filter(Boolean).length
        : 0,
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

test('a second updater cannot remove or take over the active instance socket', async (t) => {
  const f = await fixture(t);
  const duplicate = f.startDuplicate();
  const exit = await Promise.race([
    once(duplicate, 'exit'),
    new Promise((resolve) => setTimeout(() => resolve(null), 1_500)),
  ]);

  assert.ok(exit, 'the duplicate updater must refuse the active socket');
  assert.notEqual(exit[0], 0);
  const status = await f.call('GET', '/status');
  assert.equal(status.status, 200, 'the original updater remains reachable');
  assert.equal(status.body.currentSha, f.previousSha);
});

test('a restart removes a stale socket left by an unclean updater exit', async (t) => {
  const f = await fixture(t);
  await f.restartAfterUncleanExit();

  const status = await f.call('GET', '/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.currentSha, f.previousSha);
  assert.equal(status.body.updaterAvailable, true);
  assert.equal(status.body.checkInProgress, false);
});

test('automatic updates are disabled by default and settings enforce the configured interval range', async (t) => {
  const f = await fixture(t);
  const initial = await f.call('GET', '/auto-update');
  assert.deepEqual(initial.body, {
    available: true,
    enabled: false,
    intervalHours: 24,
    lastCheckAt: null,
    nextCheckAt: null,
    lastCheckResult: 'never',
    lastCheckErrorCode: null,
    lastUpdateAt: null,
    lastUpdateResult: 'never',
    lastUpdateError: null,
  });

  assert.equal(
    (await f.call('POST', '/auto-update', { enabled: true, intervalHours: 5 })).status,
    400,
  );
  const enabled = await f.call('POST', '/auto-update', { enabled: true, intervalHours: 6 });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.intervalHours, 6);
  assert.ok(Date.parse(enabled.body.nextCheckAt) > Date.now());
  assert.equal(enabled.body.lastCheckResult, 'scheduled');

  const disabled = await f.call('POST', '/auto-update', { enabled: false, intervalHours: 6 });
  assert.equal(disabled.body.enabled, false);
  assert.equal(disabled.body.nextCheckAt, null);
  assert.equal(f.fetchCount(), 0, 'saving settings does not immediately check or install');
  assert.equal(f.commands().length, 0);
});

test('a due opted-in automatic update shares checks and uses the validated install pipeline', async (t) => {
  const f = await fixture(t, {
    autoUpdate: {
      enabled: true,
      intervalHours: 6,
      lastCheckResult: 'scheduled',
      nextCheckAt: new Date(Date.now() - 1_000).toISOString(),
    },
  });
  f.holdFetch();
  await until(() => existsSync(join(f.root, 'fetches')), 'scheduled automatic check');

  const manualApply = await f.apply();
  assert.equal(manualApply.status, 409, 'manual update cannot race an automatic check');
  f.releaseFetch();

  const status = await until(async () => {
    const { body } = await f.call('GET', '/status');
    return body.job?.stage === 'SUCCEEDED' && body;
  }, 'automatically installed update');
  const settings = await f.call('GET', '/auto-update');

  assert.equal(status.job.trigger, 'automatic');
  assert.equal(status.currentSha, f.targetSha);
  assert.equal(settings.body.enabled, true);
  assert.equal(settings.body.lastCheckResult, 'update_available');
  assert.equal(settings.body.lastUpdateResult, 'succeeded');
  assert.ok(Date.parse(settings.body.nextCheckAt) > Date.now());
  assert.ok(f.commands().some((command) => command.args[0] === 'exec'));
  assert.ok(f.commands().some((command) => command.args.includes('up')));
});

test('disabling automatic updates during a read-only check prevents the subsequent install', async (t) => {
  const f = await fixture(t, {
    autoUpdate: {
      enabled: true,
      intervalHours: 6,
      lastCheckResult: 'scheduled',
      nextCheckAt: new Date(Date.now() - 1_000).toISOString(),
    },
  });
  f.holdFetch();
  await until(() => existsSync(join(f.root, 'fetches')), 'scheduled automatic check');

  const disabled = await f.call('POST', '/auto-update', { enabled: false, intervalHours: 6 });
  assert.equal(disabled.body.enabled, false);
  assert.equal(disabled.body.nextCheckAt, null);
  f.releaseFetch();

  await until(async () => {
    const { body } = await f.call('GET', '/status');
    return !body.checkInProgress && body.checkedAt;
  }, 'read-only check completed after disabling');
  const result = await f.call('GET', '/auto-update');
  const status = await f.call('GET', '/status');

  assert.equal(result.body.enabled, false);
  assert.equal(result.body.nextCheckAt, null);
  assert.equal(result.body.lastCheckResult, 'update_available');
  assert.equal(result.body.lastUpdateResult, 'never');
  assert.equal(status.body.job, null);
  assert.equal(
    f.commands().length,
    0,
    'disabling during a check stops before any install side effect',
  );
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
    assert.equal(body.checkInProgress, true);
    assert.equal(body.checkedAt, null, 'an in-progress attempt is not a successful check');
  } finally {
    rmSync(gate, { force: true });
  }
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.equal(result.body.latest.version, '1.0.3');
    assert.equal(result.body.updateAvailable, true);
    assert.equal(result.body.checkAttempts, 1);
  }
  assert.equal(results[0].body.checkAttemptId, results[1].body.checkAttemptId);
  assert.equal(readFileSync(join(f.root, 'fetches'), 'utf8').trim(), 'fetch');
});

test('transient TLS interruption retries once then caches the successful check', async (t) => {
  const f = await fixture(t);
  f.setFetchPlan([
    "fatal: unable to access 'https://github.com/example/repo.git/': GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
    null,
  ]);

  const result = await f.call('POST', '/check');

  assert.equal(f.fetchCount(), 2);
  assert.equal(result.body.latest.version, '1.0.3');
  assert.equal(result.body.updateAvailable, true);
  assert.equal(result.body.checkAttempts, 2);
  assert.equal(result.body.checkInProgress, false);
  assert.equal(result.body.checkErrorCode, null);
  assert.ok(result.body.checkedAt);
  assert.ok(result.body.checkAttemptedAt);
  assert.equal(f.commands().length, 0, 'a read-only check must not call Docker or install');
});

test('persistent TLS failure preserves the last successful result and never installs', async (t) => {
  const f = await fixture(t);
  const first = await f.call('POST', '/check');
  assert.equal(first.body.latest.version, '1.0.3');
  const lastSuccessAt = first.body.checkedAt;
  f.setFetchPlan([
    "fatal: unable to access 'https://github.com/example/repo.git/': GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
    "fatal: unable to access 'https://github.com/example/repo.git/': GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
    "fatal: unable to access 'https://github.com/example/repo.git/': GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
  ]);

  const result = await f.call('POST', '/check');

  assert.equal(f.fetchCount(), 3);
  assert.equal(result.body.latest.version, '1.0.3');
  assert.equal(result.body.checkedAt, lastSuccessAt);
  assert.equal(result.body.checkErrorCode, 'GIT_TLS_INTERRUPTED');
  assert.equal(result.body.checkAttempts, 3);
  assert.equal(result.body.checkInProgress, false);
  assert.match(result.body.error, /TLS.*远端版本尚未确认/);
  assert.doesNotMatch(result.body.error, /fatal:|github\.com|repo\.git/);
  assert.ok(result.body.checkAttemptedAt);
  assert.equal(f.commands().length, 0, 'failed checks must not invoke install commands');
});

test('authentication failures do not retry or replace the last successful check', async (t) => {
  const f = await fixture(t);
  const first = await f.call('POST', '/check');
  const lastSuccessAt = first.body.checkedAt;
  f.setFetchPlan([
    "fatal: Authentication failed for 'https://github.com/example/private.git'",
    null,
    null,
  ]);

  const result = await f.call('POST', '/check');

  assert.equal(f.fetchCount(), 1);
  assert.equal(result.body.latest.version, '1.0.3');
  assert.equal(result.body.checkedAt, lastSuccessAt);
  assert.equal(result.body.checkErrorCode, 'GIT_AUTH_FAILED');
  assert.equal(result.body.checkAttempts, 1);
  assert.match(result.body.error, /认证或权限不足/);
  assert.doesNotMatch(result.body.error, /fatal:|github\.com|private\.git/);
  assert.equal(f.commands().length, 0);
});

test('install revalidation cannot use a preserved stale check result after a fetch failure', async (t) => {
  const f = await fixture(t);
  const checked = await f.call('POST', '/check');
  assert.equal(checked.body.updateAvailable, true);
  f.setFetchPlan(["fatal: Authentication failed for 'https://github.com/example/private.git'"]);

  const accepted = await f.apply();
  assert.equal(accepted.status, 202);
  const status = await until(async () => {
    const { body } = await f.call('GET', '/status');
    return body.job?.stage === 'FAILED' && body;
  }, 'install revalidation failure');

  assert.equal(status.latest.version, '1.0.3', 'last successful result remains visible');
  assert.equal(status.checkErrorCode, 'GIT_AUTH_FAILED');
  assert.equal(f.commands().length, 0, 'failed fresh revalidation must stop before Docker/install');
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

test('failed cutover refuses incompatible rollback before starting old writers', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'fail-switch'), 'fail');
  writeFileSync(
    join(f.root, 'enable-on-switch'),
    'simulate first supplemental enrollment after initial check',
  );
  assert.equal((await f.apply()).status, 202);
  await until(
    async () => (await f.call('GET', '/status')).body.job?.stage === 'FAILED',
    'failed rollback',
  );
  const commands = f.commands();
  const checks = commands.filter((command) => command.args.includes('psql'));
  assert.equal(checks.length, 2, 'both install and rollback recheck database compatibility');
  assert.equal(commands.filter((command) => command.args.includes('stop')).length, 2);
  assert.equal(
    commands.filter((command) => command.version === '1.0.0' && command.args.includes('up')).length,
    0,
  );
});
