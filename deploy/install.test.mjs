import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';

function installFixture(t, failure = '') {
  const root = mkdtempSync(join(tmpdir(), 'lexloop-install-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  mkdirSync(source);
  mkdirSync(bin);
  mkdirSync(join(root, 'cron'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (...args) =>
    execFileSync(realGit, ['-C', source, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--initial-branch=master');
  git('config', 'user.name', 'Install test');
  git('config', 'user.email', 'install@example.invalid');
  for (const path of [
    'package.json',
    'apps/api/package.json',
    'apps/web/package.json',
    'apps/worker/package.json',
    'packages/types/package.json',
  ]) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), JSON.stringify({ version: '1.0.3' }));
  }
  mkdirSync(join(source, 'deploy'));
  writeFileSync(join(source, 'deploy/backup.sh'), '#!/bin/sh\nexit 0\n');
  git('add', '.');
  git('commit', '-m', 'release');
  git('tag', '-a', 'v1.0.3', '-m', 'release');
  const sha = git('rev-parse', 'HEAD');
  function executable(name, code) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
  }
  executable('id', `process.stdout.write('0\\n');`);
  executable(
    'git',
    `
    const cp = require('node:child_process');
    const args = process.argv.slice(2);
    let result;
    if (args[0] === 'clone') {
      result = cp.spawnSync(${JSON.stringify(realGit)}, ['clone', '--mirror', ${JSON.stringify(source)}, args.at(-1)], {stdio: 'inherit'});
      if (!result.status) result = cp.spawnSync(${JSON.stringify(realGit)}, ['--git-dir', args.at(-1), 'remote', 'set-url', 'origin', 'https://github.com/TangerineSpecter/Lexloop.git'], {stdio: 'inherit'});
    } else if (args.includes('fetch')) {
      result = cp.spawnSync(${JSON.stringify(realGit)}, ['--git-dir', args[1], 'update-ref', 'refs/remotes/origin/master', 'refs/heads/master'], {stdio: 'inherit'});
    } else result = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
    process.exitCode = result.status ?? 1;
  `,
  );
  executable(
    'docker',
    `
    const args = process.argv.slice(2);
    require('node:fs').appendFileSync(${JSON.stringify(join(root, 'commands'))}, JSON.stringify(args) + '\\n');
    if (args.includes('up') && ((${JSON.stringify(failure)} === 'updater' && args.includes('updater')) || (${JSON.stringify(failure)} === 'app' && args.includes('web')))) process.exitCode = 1;
  `,
  );
  executable('curl', `process.stdout.write(JSON.stringify({commitSha: ${JSON.stringify(sha)}}));`);
  // Run the actual installer with external commands isolated and privileged paths
  // redirected to a temporary directory; no host deployment or cron is modified.
  const script = readFileSync('deploy/install.sh', 'utf8')
    .replaceAll('/opt/lexloop', join(root, 'installed'))
    .replaceAll('/etc/cron.d', join(root, 'cron'));
  const path = join(root, 'install.sh');
  writeFileSync(path, script);
  const result = spawnSync('bash', [path], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HTTP_PORT: '65431' },
  });
  return {
    root,
    result,
    commands: readFileSync(join(root, 'commands'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  };
}

test('clean installation validates updater and application health and registers backup', (t) => {
  const { root, result, commands } = installFixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已部署完成/);
  assert.ok(existsSync(join(root, 'cron/lexloop-backup')));
  assert.match(
    readFileSync(join(root, 'installed/config/production.env'), 'utf8'),
    /APP_VERSION=1\.0\.3/,
  );
  assert.ok(commands.some((args) => args.includes('exec') && args.includes('api')));
  for (const service of ['updater', 'web'])
    assert.ok(
      commands.some(
        (args) => args.includes('up') && args.includes(service) && args.includes('--wait'),
      ),
    );
});

test('API startup failure leaves updater and backup installed and reports incomplete installation', (t) => {
  const { root, result, commands } = installFixture(t, 'app');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /失败阶段：启动并验证应用服务/);
  assert.doesNotMatch(result.stdout, /已部署完成/);
  assert.ok(existsSync(join(root, 'cron/lexloop-backup')));
  assert.ok(commands.some((args) => args.includes('up') && args.includes('updater')));
  assert.doesNotMatch(
    readFileSync(join(root, 'installed/config/production.env'), 'utf8'),
    /^APP_VERSION=/m,
  );
});

test('unhealthy updater prevents a false successful installation', (t) => {
  const { result, commands } = installFixture(t, 'updater');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /失败阶段：启动并验证更新服务/);
  assert.doesNotMatch(result.stdout, /已部署完成/);
  assert.ok(!commands.some((args) => args.includes('up') && args.includes('web')));
});
