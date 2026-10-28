import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const releaseScript = resolve(dirname(fileURLToPath(import.meta.url)), 'release.mjs');
const packagePaths = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/worker/package.json',
  'packages/types/package.json',
];
const releaseBody = [
  '主要改动：按本地日历统计每周学习记录。',
  '兼容边界：不改历史数据或复习排期。',
  '测试结果：隔离 API 163/163；Web 浏览器 12/12。',
].join('\n');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout.trim();
}

async function makeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lexloop-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const remote = join(root, 'origin.git');
  await mkdir(repo, { recursive: true });
  run('git', ['init', '--bare', remote], root);
  run('git', ['init', '--initial-branch=master'], repo);
  run('git', ['config', 'user.name', 'Lexloop release test'], repo);
  run('git', ['config', 'user.email', 'release-test@example.invalid'], repo);

  for (const path of packagePaths) {
    const name = path === 'package.json' ? 'lexloop' : `@lexloop/${path.split('/')[1]}`;
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), `${JSON.stringify({ name, version: '1.2.2' }, null, 2)}\n`);
  }
  run('git', ['add', '--all'], repo);
  run('git', ['commit', '-m', 'initial fixture'], repo);
  run('git', ['remote', 'add', 'origin', remote], repo);
  run('git', ['push', '--set-upstream', 'origin', 'master'], repo);

  const bodyFile = join(root, 'release-notes.md');
  await writeFile(bodyFile, `${releaseBody}\n`);
  return { bodyFile, remote, repo, root };
}

test('release commit and annotated tag retain the summary and tested details', async (t) => {
  const { bodyFile, remote, repo } = await makeFixture(t);
  await writeFile(join(repo, 'feature.txt'), 'validated change\n');
  run('git', ['add', '--', 'feature.txt'], repo);
  const result = spawnSync(
    process.execPath,
    [releaseScript, '1.2.3', '--summary', '按本地日历统计每周学习记录', '--body-file', bodyFile],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  const head = run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo);
  const commitSubject = run('git', ['--git-dir', remote, 'show', '-s', '--format=%s', head], repo);
  const commitBody = run('git', ['--git-dir', remote, 'show', '-s', '--format=%b', head], repo);
  const tagObject = run('git', ['--git-dir', remote, 'rev-parse', 'refs/tags/v1.2.3'], repo);
  const tagType = run('git', ['--git-dir', remote, 'cat-file', '-t', tagObject], repo);
  const tagContents = run('git', ['--git-dir', remote, 'cat-file', '-p', tagObject], repo);
  const peeled = run('git', ['--git-dir', remote, 'rev-parse', 'refs/tags/v1.2.3^{}'], repo);

  assert.equal(commitSubject, 'chore(release): v1.2.3 — 按本地日历统计每周学习记录');
  for (const section of ['主要改动：', '兼容边界：', '测试结果：']) {
    assert.ok(commitBody.includes(section));
    assert.ok(tagContents.includes(section));
  }
  assert.equal(tagType, 'tag');
  assert.ok(tagContents.includes('Release v1.2.3 — 按本地日历统计每周学习记录'));
  assert.equal(peeled, head);
  assert.deepEqual(
    run('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)'], repo)
      .split('\n')
      .filter(Boolean)
      .sort(),
    ['refs/heads/master', 'refs/tags/v1.2.3'],
  );
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version, '1.2.3');
  assert.equal(run('git', ['status', '--porcelain'], repo), '');
});

test('release refuses a version-only commit before changing files or refs', async (t) => {
  const { bodyFile, remote, repo } = await makeFixture(t);
  const before = run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo);
  const result = spawnSync(
    process.execPath,
    [releaseScript, '1.2.3', '--summary', '按本地日历统计每周学习记录', '--body-file', bodyFile],
    { cwd: repo, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /暂存区没有实际改动，拒绝只提交版本号/);
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version, '1.2.2');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo), before);
  assert.equal(run('git', ['tag', '--list', 'v1.2.3'], repo), '');
  assert.equal(run('git', ['status', '--porcelain'], repo), '');
});

test('release refuses edits made after staging before changing files or refs', async (t) => {
  const { bodyFile, remote, repo } = await makeFixture(t);
  await writeFile(join(repo, 'feature.txt'), 'validated change\n');
  run('git', ['add', '--', 'feature.txt'], repo);
  await writeFile(join(repo, 'feature.txt'), 'validated change plus an unstaged edit\n');
  const before = run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo);
  const result = spawnSync(
    process.execPath,
    [releaseScript, '1.2.3', '--summary', '按本地日历统计每周学习记录', '--body-file', bodyFile],
    { cwd: repo, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /未暂存或未跟踪文件/);
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version, '1.2.2');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo), before);
  assert.equal(run('git', ['tag', '--list', 'v1.2.3'], repo), '');
  assert.equal(run('git', ['status', '--porcelain'], repo), 'AM feature.txt');
});

test('release refuses untracked files without adding them to the remote commit', async (t) => {
  const { bodyFile, remote, repo } = await makeFixture(t);
  await writeFile(join(repo, 'feature.txt'), 'validated change\n');
  await writeFile(join(repo, 'private-notes.txt'), 'keep outside the release\n');
  run('git', ['add', '--', 'feature.txt'], repo);
  const before = run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo);
  const result = spawnSync(
    process.execPath,
    [releaseScript, '1.2.3', '--summary', '按本地日历统计每周学习记录', '--body-file', bodyFile],
    { cwd: repo, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /未暂存或未跟踪文件/);
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version, '1.2.2');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo), before);
  assert.equal(run('git', ['tag', '--list', 'v1.2.3'], repo), '');
  assert.equal(
    await readFile(join(repo, 'private-notes.txt'), 'utf8'),
    'keep outside the release\n',
  );
  assert.equal(run('git', ['status', '--porcelain'], repo), 'A  feature.txt\n?? private-notes.txt');
});

test('release only runs on master', async (t) => {
  const { bodyFile, remote, repo } = await makeFixture(t);
  await writeFile(join(repo, 'feature.txt'), 'validated change\n');
  run('git', ['add', '--', 'feature.txt'], repo);
  run('git', ['switch', '-c', 'release-candidate'], repo);
  const before = run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo);
  const result = spawnSync(
    process.execPath,
    [releaseScript, '1.2.3', '--summary', '按本地日历统计每周学习记录', '--body-file', bodyFile],
    { cwd: repo, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /只允许在 master 分支执行/);
  assert.equal(JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version, '1.2.2');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/master'], repo), before);
  assert.equal(
    run(
      'git',
      ['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/release-candidate'],
      repo,
    ),
    '',
  );
  assert.equal(run('git', ['tag', '--list', 'v1.2.3'], repo), '');
});
