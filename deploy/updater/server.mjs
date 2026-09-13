#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateUpdate, parseStableVersion, selectLatestRelease } from './core.mjs';

const config = {
  socket: process.env.UPDATER_SOCKET ?? '/run/lexloop/updater.sock',
  stateFile: process.env.UPDATER_STATE_FILE ?? '/state/update-state.json',
  repository: process.env.REPOSITORY_URL ?? 'https://github.com/TangerineSpecter/Lexloop.git',
  trustedBranch: process.env.TRUSTED_BRANCH ?? 'master',
  bareRepository: process.env.BARE_REPOSITORY ?? '/opt/lexloop/source/repo.git',
  releasesDir: process.env.RELEASES_DIR ?? '/opt/lexloop/releases',
  backupsDir: process.env.BACKUPS_DIR ?? '/opt/lexloop/backups',
  productionEnv: process.env.PRODUCTION_ENV ?? '/opt/lexloop/config/production.env',
  projectName: process.env.COMPOSE_PROJECT_NAME ?? 'lexloop',
  githubRepository: process.env.GITHUB_REPOSITORY ?? 'TangerineSpecter/Lexloop',
};

const initialDeployment = {
  version: process.env.APP_VERSION ?? 'development',
  sha: process.env.APP_COMMIT_SHA ?? 'unknown',
  imageTag: process.env.LEXLOOP_IMAGE_TAG ?? 'initial',
  releasePath: process.env.CURRENT_RELEASE_PATH ?? '',
};

let state = loadState();
let activeJob = state.job && !['SUCCEEDED', 'FAILED'].includes(state.job.stage) ? state.job : null;
if (activeJob) {
  activeJob.stage = 'FAILED';
  activeJob.message = 'updater 曾在任务执行期间重启，请检查应用状态后重试。';
  activeJob.finishedAt = new Date().toISOString();
  recordHistory(activeJob);
  persist();
  activeJob = null;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(config.stateFile, 'utf8'));
  } catch {
    return {
      deployment: initialDeployment,
      latest: null,
      checkedAt: null,
      checkError: null,
      job: null,
      history: [],
    };
  }
}

function persist() {
  mkdirSync(dirname(config.stateFile), { recursive: true });
  const temporary = `${config.stateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, config.stateFile);
}

function recordHistory(job) {
  state.history = (state.history ?? []).filter((item) => item.id !== job.id);
  state.history.unshift({ ...job });
  state.history = state.history.slice(0, 50);
}

function sanitize(value) {
  return String(value)
    .replace(/(password|secret|token|authorization)(\s*[=:]\s*)\S+/gi, '$1$2[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 600);
}

function appendLog(job, value) {
  job.logs.push(`${new Date().toISOString()} ${sanitize(value)}`);
  job.logs = job.logs.slice(-80);
  state.job = job;
  persist();
}

function updateStage(job, stage, message) {
  job.stage = stage;
  job.message = message;
  appendLog(job, message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      sanitize(result.stderr || result.stdout || result.error?.message || `${command} 执行失败`),
    );
  }
  return result.stdout.trim();
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => {
      output = `${output}${chunk}`.slice(-20_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(sanitize(output || `${command} 执行失败 (${code})`)));
    });
  });
}

function git(args) {
  return run('git', ['--git-dir', config.bareRepository, ...args]);
}

function ensureRepository() {
  if (!existsSync(config.bareRepository)) throw new Error('部署仓库尚未初始化');
  const remote = git(['remote', 'get-url', 'origin']);
  if (remote !== config.repository) throw new Error('部署仓库地址与受信任仓库不一致');
}

function fetchRepository() {
  ensureRepository();
  git([
    'fetch',
    '--prune',
    'origin',
    `+refs/heads/${config.trustedBranch}:refs/remotes/origin/${config.trustedBranch}`,
    '+refs/tags/v*:refs/tags/v*',
  ]);
}

function gitExitZero(args) {
  const result = spawnSync('git', ['--git-dir', config.bareRepository, ...args], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function packageVersionAt(sha, path) {
  return JSON.parse(git(['show', `${sha}:${path}`])).version;
}

function discoverLatest() {
  fetchRepository();
  const tags = git(['for-each-ref', '--format=%(refname:short)', 'refs/tags/v*'])
    .split('\n')
    .filter(Boolean);
  const candidates = [];
  for (const tag of tags) {
    const parsed = parseStableVersion(tag);
    const annotated = git(['cat-file', '-t', `refs/tags/${tag}`]) === 'tag';
    if (!parsed || !annotated) continue;
    const sha = git(['rev-list', '-n', '1', tag]);
    if (
      !gitExitZero([
        'merge-base',
        '--is-ancestor',
        sha,
        `refs/remotes/origin/${config.trustedBranch}`,
      ])
    ) {
      continue;
    }
    const packagePaths = [
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'apps/worker/package.json',
      'packages/types/package.json',
    ];
    if (!packagePaths.every((path) => packageVersionAt(sha, path) === parsed.version)) continue;
    candidates.push({
      tag,
      version: parsed.version,
      sha,
      annotated,
      compareUrl: `https://github.com/${config.githubRepository}/compare/${state.deployment.sha}...${sha}`,
    });
  }
  return selectLatestRelease(candidates);
}

function currentStatus() {
  const latest = state.latest;
  const current = state.deployment ?? initialDeployment;
  const isDescendant = latest
    ? current.sha === 'unknown' ||
      (gitExitZero(['cat-file', '-e', `${current.sha}^{commit}`]) &&
        gitExitZero(['merge-base', '--is-ancestor', current.sha, latest.sha]))
    : false;
  const evaluation = evaluateUpdate(current.version, current.sha, latest, isDescendant);
  return {
    currentVersion: current.version,
    currentSha: current.sha,
    updaterAvailable: true,
    error: state.checkError,
    latest,
    ...evaluation,
    checkedAt: state.checkedAt,
    job: state.job,
  };
}

function performCheck() {
  try {
    state.latest = discoverLatest();
    state.checkedAt = new Date().toISOString();
    state.checkError = null;
  } catch (error) {
    state.latest = null;
    state.checkedAt = new Date().toISOString();
    state.checkError = sanitize(error instanceof Error ? error.message : error);
  }
  persist();
  return currentStatus();
}

function composeArgs(releasePath) {
  return [
    'compose',
    '--project-name',
    config.projectName,
    '--env-file',
    config.productionEnv,
    '--file',
    join(releasePath, 'deploy/compose.prod.yml'),
  ];
}

function releaseEnvironment(deployment) {
  return {
    LEXLOOP_IMAGE_TAG: deployment.imageTag,
    APP_VERSION: deployment.version,
    APP_COMMIT_SHA: deployment.sha,
    APP_BUILD_TIME: new Date().toISOString(),
  };
}

function saveProductionDeployment(deployment) {
  let source = readFileSync(config.productionEnv, 'utf8');
  const values = {
    APP_VERSION: deployment.version,
    APP_COMMIT_SHA: deployment.sha,
    APP_BUILD_TIME: new Date().toISOString(),
    LEXLOOP_IMAGE_TAG: deployment.imageTag,
    CURRENT_RELEASE_PATH: deployment.releasePath,
  };
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    source = pattern.test(source)
      ? source.replace(pattern, line)
      : `${source.trimEnd()}\n${line}\n`;
  }
  const temporary = `${config.productionEnv}.tmp`;
  writeFileSync(temporary, source, { mode: 0o600 });
  renameSync(temporary, config.productionEnv);
}

function createBackup(job) {
  mkdirSync(config.backupsDir, { recursive: true });
  const path = join(
    config.backupsDir,
    `pre-update-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`,
  );
  const output = openSync(path, 'wx', 0o600);
  const result = spawnSync(
    'docker',
    [
      'exec',
      'lexloop-postgres',
      'pg_dump',
      '-U',
      process.env.POSTGRES_USER ?? 'lexloop',
      '-d',
      process.env.POSTGRES_DB ?? 'lexloop',
      '-Fc',
    ],
    { stdio: ['ignore', output, 'pipe'], encoding: 'utf8' },
  );
  closeSync(output);
  if (result.status !== 0) throw new Error(sanitize(result.stderr || '数据库备份失败'));
  appendLog(job, `数据库备份完成：${path}`);
}

async function verifyDeployment(target, job) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync('curl', [
      '--fail',
      '--silent',
      '--max-time',
      '3',
      'http://gateway/api/v1/health',
    ]);
    if (result.status === 0) {
      try {
        const health = JSON.parse(result.stdout.toString());
        if (health.version === target.version && health.commitSha === target.sha) return;
      } catch {
        // The gateway can become reachable before the new API is ready.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  appendLog(job, '新版本健康检查超时。');
  throw new Error('新版本在 60 秒内未通过健康检查');
}

function scheduleUpdaterRefresh(releasePath, env) {
  const args = [
    'compose',
    '--project-name',
    'lexloop-ops',
    '--env-file',
    config.productionEnv,
    '--file',
    join(releasePath, 'deploy/compose.ops.yml'),
    'up',
    '--detach',
    '--build',
    'updater',
  ];
  const child = spawn('docker', args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
}

async function runUpdate(job, target) {
  const previous = { ...state.deployment };
  const imageTag = `${target.version}-${target.sha.slice(0, 12)}`;
  const releasePath = join(config.releasesDir, imageTag);
  const deployment = { version: target.version, sha: target.sha, imageTag, releasePath };
  const env = releaseEnvironment(deployment);
  let switched = false;
  try {
    updateStage(job, 'CHECKING', '正在重新验证版本和提交关系…');
    const status = performCheck();
    if (
      !status.updateAvailable ||
      status.latest?.version !== target.version ||
      status.latest?.sha !== target.sha
    ) {
      throw new Error('目标版本已经变化，请重新检查更新');
    }

    mkdirSync(config.releasesDir, { recursive: true });
    if (!existsSync(releasePath)) {
      git(['worktree', 'add', '--force', '--detach', releasePath, target.sha]);
    }

    updateStage(job, 'BUILDING', '正在校验 Compose 并利用本地缓存构建镜像…');
    await runAsync('docker', [...composeArgs(releasePath), 'config', '--quiet'], { env });
    await runAsync(
      'docker',
      [...composeArgs(releasePath), 'build', 'web', 'api', 'worker', 'migrate'],
      { env },
    );

    updateStage(job, 'BACKING_UP', '正在创建更新前数据库备份…');
    createBackup(job);

    updateStage(job, 'MIGRATING', '正在执行数据库迁移…');
    await runAsync('docker', [...composeArgs(releasePath), 'run', '--rm', 'migrate'], { env });

    updateStage(job, 'DEPLOYING', '正在切换 Web、API 与 Worker…');
    await runAsync(
      'docker',
      [
        ...composeArgs(releasePath),
        'up',
        '--detach',
        '--no-build',
        'postgres',
        'redis',
        'web',
        'api',
        'worker',
        'gateway',
      ],
      { env },
    );
    switched = true;

    updateStage(job, 'VERIFYING', '正在验证首页、API 版本和容器状态…');
    await verifyDeployment(target, job);

    state.deployment = deployment;
    saveProductionDeployment(deployment);
    job.stage = 'SUCCEEDED';
    job.message = `已更新到 v${target.version} (${target.sha.slice(0, 12)})`;
    job.finishedAt = new Date().toISOString();
    appendLog(job, job.message);
    recordHistory(job);
    persist();
    activeJob = null;
    setTimeout(() => scheduleUpdaterRefresh(releasePath, env), 1_000).unref();
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : error);
    appendLog(job, `更新失败：${message}`);
    if (switched && previous?.releasePath && previous?.imageTag) {
      try {
        appendLog(job, '正在恢复上一版应用镜像…');
        await runAsync(
          'docker',
          [
            ...composeArgs(previous.releasePath),
            'up',
            '--detach',
            '--no-build',
            'web',
            'api',
            'worker',
            'gateway',
          ],
          { env: releaseEnvironment(previous) },
        );
        appendLog(job, '上一版应用镜像已恢复；数据库不会自动回滚。');
      } catch (rollbackError) {
        appendLog(job, `应用镜像恢复失败：${sanitize(rollbackError)}`);
      }
    }
    job.stage = 'FAILED';
    job.message = message;
    job.finishedAt = new Date().toISOString();
    state.job = job;
    recordHistory(job);
    activeJob = null;
    persist();
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 65_536) request.destroy();
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求格式无效'));
      }
    });
    request.on('error', reject);
  });
}

function reply(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/status') {
      return reply(response, 200, currentStatus());
    }
    if (request.method === 'POST' && request.url === '/check') {
      return reply(response, 200, performCheck());
    }
    if (request.method === 'GET' && request.url?.startsWith('/jobs/')) {
      const id = request.url.slice('/jobs/'.length);
      return state.job?.id === id
        ? reply(response, 200, state.job)
        : reply(response, 404, { message: '更新任务不存在' });
    }
    if (request.method === 'POST' && request.url === '/apply') {
      if (activeJob) return reply(response, 409, { message: '已有更新任务正在执行' });
      const input = await readJson(request);
      if (
        !parseStableVersion(input.targetVersion ?? '') ||
        !/^[0-9a-f]{40}$/.test(input.targetSha ?? '') ||
        typeof input.actorId !== 'string' ||
        typeof input.actorEmail !== 'string'
      ) {
        return reply(response, 400, { message: '更新请求参数无效' });
      }
      const job = {
        id: randomUUID(),
        stage: 'CHECKING',
        message: '更新任务已创建',
        targetVersion: input.targetVersion,
        targetSha: input.targetSha,
        actorId: input.actorId,
        actorEmail: input.actorEmail,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        logs: [],
      };
      activeJob = job;
      state.job = job;
      persist();
      setImmediate(
        () => void runUpdate(job, { version: input.targetVersion, sha: input.targetSha }),
      );
      return reply(response, 202, { jobId: job.id, stage: job.stage });
    }
    return reply(response, 404, { message: '接口不存在' });
  } catch (error) {
    return reply(response, 503, {
      message: sanitize(error instanceof Error ? error.message : '更新服务暂时不可用'),
    });
  }
});

mkdirSync(dirname(config.socket), { recursive: true });
if (existsSync(config.socket)) rmSync(config.socket);
server.listen(config.socket, () => {
  chmodSync(config.socket, 0o660);
  console.log(`Lexloop updater listening on ${config.socket}`);
});

setInterval(() => performCheck(), 6 * 60 * 60 * 1_000).unref();
setTimeout(() => performCheck(), 5_000).unref();
