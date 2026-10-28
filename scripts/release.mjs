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
  console.log(`用法：node scripts/release.mjs <版本号> --summary "中文功能摘要" --body-file <说明文件>

示例：
  node scripts/release.mjs 1.2.0 --summary "修复复习日期边界" --body-file /tmp/lexloop-release.md
  node scripts/release.mjs v1.2.0-beta.1 --summary "新增语境复习" --body-file /tmp/lexloop-release.md

说明文件必须包含“主要改动：”“兼容边界：”和“测试结果：”三段。
运行前请先暂存本次验收通过的实际改动。脚本要求在 master 上执行，并拒绝未暂存或未跟踪文件。
脚本只会额外暂存五个 workspace 版本清单，不会自动加入其他工作区文件。
脚本会把摘要和说明写入提交标题、提交正文和注释 tag，再推送 master。
远端或本地已存在同名 tag 时会停止，避免覆盖版本历史。`);
}

const args = process.argv.slice(2);
const input = args[0];
if (!input || input === '--help' || input === '-h') {
  showHelp();
  process.exit(input ? 0 : 1);
}

let summary = '';
let bodyFile = '';
for (let index = 1; index < args.length; index += 1) {
  const option = args[index];
  const value = args[index + 1];
  if (option === '--summary' && value) {
    summary = value.trim();
    index += 1;
  } else if (option === '--body-file' && value) {
    bodyFile = value;
    index += 1;
  } else {
    fail(`未知或缺少参数值：${option}`);
  }
}
if (!summary || /[\r\n]/.test(summary) || !/\p{Script=Han}/u.test(summary))
  fail('必须提供一行中文功能摘要。');
if (summary.length > 60) fail('提交摘要不能超过 60 个字符。');
if (!bodyFile) fail('必须通过 --body-file 提供发布说明文件。');

let releaseBody;
try {
  releaseBody = readFileSync(bodyFile, 'utf8').trim();
} catch (error) {
  fail(`无法读取发布说明文件：${error instanceof Error ? error.message : String(error)}`);
}
for (const section of ['主要改动', '兼容边界', '测试结果']) {
  if (!new RegExp(`^${section}[：:]`, 'm').test(releaseBody))
    fail(`发布说明必须包含“${section}：”段落。`);
}

const version = input.startsWith('v') ? input.slice(1) : input;
if (!SEMVER_PATTERN.test(version)) {
  fail(`“${input}”不是有效的 SemVer 版本号，例如 1.2.0 或 1.2.0-beta.1。`);
}

if (git(['rev-parse', '--is-inside-work-tree'], { capture: true, allowFailure: true }) !== 'true') {
  fail('请在 Git 仓库中执行此脚本。');
}

const branch = git(['branch', '--show-current'], { capture: true });
if (!branch) fail('当前处于 detached HEAD，请先切换到要发布的分支。');
if (branch !== 'master') fail('版本发布只允许在 master 分支执行。');

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

const statusRows = git(['status', '--porcelain=v1', '--untracked-files=all'], { capture: true })
  .split(/\r?\n/)
  .filter(Boolean);
if (statusRows.some((row) => row.slice(0, 2) === '??' || row[1] !== ' ')) {
  fail('发现未暂存或未跟踪文件；请先审查并明确暂存本次改动，脚本不会自动加入它们。');
}
const stagedPaths = git(['diff', '--cached', '--name-only'], { capture: true })
  .split(/\r?\n/)
  .filter(Boolean);
if (!stagedPaths.some((path) => !PACKAGE_FILES.includes(path))) {
  fail('暂存区没有实际改动，拒绝只提交版本号；请先暂存并验收本次代码或文档改动。');
}

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
if (remoteTag) {
  fail(`远端已存在 ${tag}；请先核对标签指向，脚本不会覆盖版本历史。`);
}
if (
  git(['show-ref', '--tags', '--verify', `refs/tags/${tag}`], {
    capture: true,
    allowFailure: true,
  })
) {
  fail(`本地已存在 ${tag}；请先核对标签指向，脚本不会覆盖版本历史。`);
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

git(['add', '--', ...PACKAGE_FILES]);
const hasStagedChanges = git(['diff', '--cached', '--quiet'], { allowFailure: true }) !== 0;
if (hasStagedChanges) {
  console.log('正在提交当前工作区改动与版本号…');
  git(['commit', '-m', `chore(release): ${tag} — ${summary}`, '-m', releaseBody]);
} else {
  fail('工作区没有待发布改动；为避免版本提交只剩摘要，请先准备并验收本次改动。');
}

console.log(`正在推送 ${branch}…`);
git(['push', 'origin', `HEAD:refs/heads/${branch}`]);

console.log(`正在创建 ${tag}…`);
git([
  'tag',
  '--annotate',
  tag,
  '--message',
  `Release ${tag} — ${summary}`,
  '--message',
  releaseBody,
  'HEAD',
]);
git(['push', 'origin', `refs/tags/${tag}`]);

console.log(
  `\n发布完成：${tag} 已指向 ${git(['rev-parse', '--short', 'HEAD'], { capture: true })}`,
);
