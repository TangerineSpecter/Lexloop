#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PACKAGE_FILES = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/worker/package.json',
  'packages/types/package.json',
];

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  console.error(`\n发布失败：${message}`);
  process.exit(1);
}

function git(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.error) fail(`无法执行 git：${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? result.stderr.trim() : '';
    fail(`git ${args.join(' ')} 执行失败${detail ? `：${detail}` : ''}`);
  }

  return capture ? result.stdout.trim() : result.status;
}

function showHelp() {
  console.log(`用法：pnpm release <版本号>

示例：
  pnpm release 1.2.0
  pnpm release v1.2.0-beta.1

脚本会同步所有 workspace package.json 的版本号，将当前工作区改动提交为
chore(release): v<版本号>，推送当前分支，然后创建对应的 v<版本号> tag。
当指定版本与当前项目版本相同时，会把远端同名 tag 强制移动到新提交。`);
}

const input = process.argv[2];
if (!input || input === '--help' || input === '-h') {
  showHelp();
  process.exit(input ? 0 : 1);
}
if (process.argv.length > 3) fail('只接受一个版本号参数。');

const version = input.startsWith('v') ? input.slice(1) : input;
if (!SEMVER_PATTERN.test(version)) {
  fail(`“${input}”不是有效的 SemVer 版本号，例如 1.2.0 或 1.2.0-beta.1。`);
}

if (git(['rev-parse', '--is-inside-work-tree'], { capture: true, allowFailure: true }) !== 'true') {
  fail('请在 Git 仓库中执行此脚本。');
}

const branch = git(['branch', '--show-current'], { capture: true });
if (!branch) fail('当前处于 detached HEAD，请先切换到要发布的分支。');

git(['remote', 'get-url', '--push', 'origin'], { capture: true });

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
  const markerPath = git(['rev-parse', '--git-path', marker], { capture: true });
  if (existsSync(markerPath))
    fail(`仓库仍处于 ${marker.replace('_HEAD', '').toLowerCase()} 流程中，请先完成或取消。`);
}
for (const marker of ['rebase-merge', 'rebase-apply']) {
  const markerPath = git(['rev-parse', '--git-path', marker], { capture: true });
  if (existsSync(markerPath)) fail('仓库仍处于 rebase 流程中，请先完成或取消。');
}

git(['diff', '--check']);
git(['diff', '--cached', '--check']);

const manifests = PACKAGE_FILES.map((path) => {
  const source = readFileSync(path, 'utf8');
  return { path, source, data: JSON.parse(source) };
});
const packageVersions = [...new Set(manifests.map(({ data }) => data.version).filter(Boolean))];
if (packageVersions.length !== 1) {
  fail(`workspace 版本号不一致：${packageVersions.join('、') || '未设置'}。请先统一后再发布。`);
}

const currentVersion = packageVersions[0];
const tag = `v${version}`;
const sameVersion = currentVersion === version;

console.log(`\n准备发布 ${tag}（当前版本 ${currentVersion}，分支 ${branch}）`);
console.log('正在同步远端分支状态…');
const remoteBranch = git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
  capture: true,
});
if (remoteBranch) {
  git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (
    git(['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, 'HEAD'], {
      allowFailure: true,
    }) !== 0
  ) {
    fail(`本地 ${branch} 落后于远端或已产生分叉，请先同步远端改动。`);
  }
} else {
  console.log(`远端尚无 ${branch} 分支，将在本次发布中创建。`);
}

const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { capture: true });
if (remoteTag && !sameVersion) {
  fail(`远端已存在 ${tag}，但当前项目版本是 ${currentVersion}；为避免覆盖历史版本，已停止发布。`);
}

for (const manifest of manifests) {
  let nextSource;
  if (manifest.data.version) {
    nextSource = manifest.source.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  } else {
    nextSource = manifest.source.replace(
      /("name"\s*:\s*"[^"]+",\r?\n)/,
      `$1  "version": "${version}",\n`,
    );
  }
  if (nextSource === manifest.source && manifest.data.version !== version) {
    fail(`无法更新 ${manifest.path} 中的版本号。`);
  }
  writeFileSync(manifest.path, nextSource);
}

git(['add', '--all']);
const hasStagedChanges = git(['diff', '--cached', '--quiet'], { allowFailure: true }) !== 0;
if (hasStagedChanges) {
  console.log('正在提交当前工作区改动与版本号…');
  git(['commit', '-m', `chore(release): ${tag}`]);
} else {
  console.log('工作区没有新改动，将使用当前提交发布。');
}

console.log(`正在推送 ${branch}…`);
git(['push', 'origin', `HEAD:refs/heads/${branch}`]);

console.log(`${sameVersion ? '正在移动' : '正在创建'} ${tag}…`);
git(['tag', '--force', '--annotate', tag, '--message', `Release ${tag}`, 'HEAD']);
git(['push', 'origin', `refs/tags/${tag}`, '--force']);

console.log(
  `\n发布完成：${tag} 已指向 ${git(['rev-parse', '--short', 'HEAD'], { capture: true })}`,
);
