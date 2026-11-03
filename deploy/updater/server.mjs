#!/usr/bin/env node
import {
  assertProgressiveCompatibility,
  INVALIDATED_PLAN_EXISTS_SQL,
} from './progressive-compatibility.mjs';

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
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
import {
  assertSupplementCompatibility,
  SUPPLEMENT_EXISTS_SQL,
} from './supplement-compatibility.mjs';
import { RemoteBackups } from './backup.mjs';
import { evaluateUpdate, parseStableVersion, selectLatestRelease } from './core.mjs';
import { classifyRepositoryFetchError, retryRepositoryFetch } from './check-retry.mjs';
import { connect as connectSocket } from 'node:net';

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

const remoteBackups = new RemoteBackups(config);
const AUTO_UPDATE_DEFAULT_INTERVAL_HOURS = 24;
const AUTO_UPDATE_MIN_INTERVAL_HOURS = 6;
const AUTO_UPDATE_MAX_INTERVAL_HOURS = 168;

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
  if (activeJob.trigger === 'automatic') {
    state.autoUpdate.lastUpdateAt ??= activeJob.startedAt;
    state.autoUpdate.lastUpdateResult = 'failed';
    state.autoUpdate.lastUpdateError = 'updater 在自动更新过程中重启；请检查更新任务状态。';
    state.autoUpdate.lastCheckResult = 'update_available';
  }
  persist();
  activeJob = null;
} else if (state.autoUpdate.lastUpdateResult === 'running') {
  state.autoUpdate.lastUpdateResult = 'failed';
  state.autoUpdate.lastUpdateError = 'updater 重启后未找到自动更新任务；请检查更新任务记录。';
  state.autoUpdate.lastCheckResult = 'update_available';
  persist();
}
if (state.autoUpdate.lastCheckResult === 'checking') {
  state.autoUpdate.lastCheckResult = 'check_failed';
  state.autoUpdate.lastCheckErrorCode = 'UPDATER_CHECK_INTERRUPTED';
  state.autoUpdate.lastCheckAt ??= new Date().toISOString();
  persist();
}

function loadState() {
  try {
    const saved = JSON.parse(readFileSync(config.stateFile, 'utf8'));
    // install.sh can repair/reinstall a release without going through runUpdate.
    // Its validated production environment is the identity of the running release.
    if (initialDeployment.sha !== 'unknown' && saved.deployment?.sha !== initialDeployment.sha) {
      saved.deployment = initialDeployment;
      saved.latest = null;
      saved.checkedAt = null;
      saved.checkError = null;
      saved.checkErrorCode = null;
      saved.checkAttemptId = null;
      saved.checkAttemptedAt = null;
      saved.checkFinishedAt = null;
      saved.checkAttempts = 0;
      saved.checkInProgress = false;
    }

    saved.checkAttemptId ??= null;
    saved.checkAttemptedAt ??= saved.checkedAt ?? null;
    saved.checkFinishedAt ??= saved.checkedAt ?? null;
    saved.checkAttempts ??= saved.checkedAt ? 1 : 0;
    saved.checkErrorCode ??= null;
    saved.checkInProgress ??= false;
    saved.autoUpdate = normalizeAutoUpdate(saved.autoUpdate);
    if (saved.checkError && !saved.checkErrorCode) {
      if (String(saved.checkError).startsWith('应用已更新，但更新服务刷新失败：')) {
        saved.checkErrorCode = 'UPDATER_REFRESH_FAILED';
        saved.checkError = '应用已更新，但更新服务刷新失败；请检查 updater 日志。';
      } else {
        const previousAttemptAt = saved.checkedAt;
        const classified = classifyRepositoryFetchError(saved.checkError, saved.checkAttempts || 1);
        saved.checkErrorCode = classified.code;
        saved.checkError = classified.message;
        saved.checkedAt = null;
        saved.checkAttemptedAt = saved.checkAttemptedAt ?? previousAttemptAt;
        saved.checkFinishedAt = saved.checkFinishedAt ?? previousAttemptAt;
        saved.checkAttemptId ??= randomUUID();
      }
    }
    if (saved.checkInProgress) {
      saved.checkInProgress = false;
      saved.checkErrorCode = 'UPDATER_CHECK_INTERRUPTED';
      saved.checkError = '更新检查因 updater 重启而中断；当前保留上次成功检查结果。';
      saved.checkAttemptId ??= randomUUID();
      saved.checkFinishedAt = new Date().toISOString();
    }
    return saved;
  } catch {
    return {
      deployment: initialDeployment,
      latest: null,
      checkedAt: null,
      checkError: null,
      checkErrorCode: null,
      checkAttemptId: null,
      checkAttemptedAt: null,
      checkFinishedAt: null,
      checkAttempts: 0,
      checkInProgress: false,
      autoUpdate: defaultAutoUpdate(),
      job: null,
      history: [],
    };
  }
}

function defaultAutoUpdate() {
  return {
    enabled: false,
    intervalHours: AUTO_UPDATE_DEFAULT_INTERVAL_HOURS,
    lastCheckAt: null,
    nextCheckAt: null,
    lastCheckResult: 'never',
    lastCheckErrorCode: null,
    lastUpdateAt: null,
    lastUpdateResult: 'never',
    lastUpdateError: null,
  };
}

function normalizeAutoUpdate(value) {
  const fallback = defaultAutoUpdate();
  if (!value || typeof value !== 'object') return fallback;
  const intervalHours = Number.isInteger(value.intervalHours)
    ? value.intervalHours
    : AUTO_UPDATE_DEFAULT_INTERVAL_HOURS;
  const validInterval =
    intervalHours >= AUTO_UPDATE_MIN_INTERVAL_HOURS &&
    intervalHours <= AUTO_UPDATE_MAX_INTERVAL_HOURS;
  const checkResults = new Set([
    'never',
    'scheduled',
    'checking',
    'up_to_date',
    'update_available',
    'check_failed',
    'updating',
  ]);
  const updateResults = new Set(['never', 'running', 'succeeded', 'failed']);
  const enabled = value.enabled === true && validInterval;
  const persistedNextCheck =
    typeof value.nextCheckAt === 'string' && !Number.isNaN(Date.parse(value.nextCheckAt))
      ? value.nextCheckAt
      : null;
  return {
    ...fallback,
    enabled,
    intervalHours: validInterval ? intervalHours : AUTO_UPDATE_DEFAULT_INTERVAL_HOURS,
    lastCheckAt: typeof value.lastCheckAt === 'string' ? value.lastCheckAt : null,
    nextCheckAt: enabled
      ? (persistedNextCheck ?? new Date(Date.now() + intervalHours * 60 * 60_000).toISOString())
      : null,
    lastCheckResult: checkResults.has(value.lastCheckResult) ? value.lastCheckResult : 'never',
    lastCheckErrorCode:
      typeof value.lastCheckErrorCode === 'string' &&
      /^[A-Z0-9_]{1,64}$/.test(value.lastCheckErrorCode)
        ? value.lastCheckErrorCode
        : null,
    lastUpdateAt: typeof value.lastUpdateAt === 'string' ? value.lastUpdateAt : null,
    lastUpdateResult: updateResults.has(value.lastUpdateResult) ? value.lastUpdateResult : 'never',
    lastUpdateError:
      typeof value.lastUpdateError === 'string' && value.lastUpdateError.length <= 180
        ? value.lastUpdateError
        : null,
  };
}

function persist() {
  persistState(state);
}

function persistState(value) {
  mkdirSync(dirname(config.stateFile), { recursive: true });
  const temporary = `${config.stateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
      timeout: options.timeout,
      killSignal: 'SIGKILL',
    });
    const abortChild = () => child.kill('SIGKILL');
    if (options.signal?.aborted) abortChild();
    else options.signal?.addEventListener('abort', abortChild, { once: true });
    let output = '';
    const collect = (chunk) => {
      output = `${output}${chunk}`.slice(-20_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abortChild);
      if (code === 0) resolve(output.trim());
      else if (options.timeout && signal === 'SIGKILL') {
        reject(new Error(`${command} timed out after ${options.timeout} ms`));
      } else reject(new Error(sanitize(output || `${command} 执行失败 (${code})`)));
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

async function fetchRepository() {
  ensureRepository();
  return retryRepositoryFetch(({ timeoutMs, signal }) =>
    runAsync(
      'git',
      [
        '--git-dir',
        config.bareRepository,
        'fetch',
        '--prune',
        'origin',
        `+refs/heads/${config.trustedBranch}:refs/remotes/origin/${config.trustedBranch}`,
        '+refs/tags/v*:refs/tags/v*',
      ],
      { timeout: timeoutMs, signal },
    ),
  );
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

async function discoverLatest() {
  const fetch = await fetchRepository();
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
  return { latest: selectLatestRelease(candidates), attempts: fetch.attempts };
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
    checkErrorCode: state.checkErrorCode ?? null,
    checkAttemptId: state.checkAttemptId ?? null,
    checkAttemptedAt: state.checkAttemptedAt ?? null,
    checkFinishedAt: state.checkFinishedAt ?? null,
    checkAttempts: state.checkAttempts ?? 0,
    checkInProgress: state.checkInProgress ?? false,
    latest,
    ...evaluation,
    checkedAt: state.checkedAt,
    job: state.job,
  };
}

function currentAutoUpdateStatus() {
  return { available: true, ...state.autoUpdate };
}

function saveAutoUpdate(input) {
  if (
    typeof input.enabled !== 'boolean' ||
    !Number.isInteger(input.intervalHours) ||
    input.intervalHours < AUTO_UPDATE_MIN_INTERVAL_HOURS ||
    input.intervalHours > AUTO_UPDATE_MAX_INTERVAL_HOURS
  ) {
    return null;
  }
  const previous = state.autoUpdate;
  const changed =
    previous.enabled !== input.enabled || previous.intervalHours !== input.intervalHours;
  const next = {
    ...previous,
    enabled: input.enabled,
    intervalHours: input.intervalHours,
    nextCheckAt: input.enabled
      ? changed || !previous.nextCheckAt
        ? new Date(Date.now() + input.intervalHours * 60 * 60_000).toISOString()
        : previous.nextCheckAt
      : null,
    ...(changed && input.enabled ? { lastCheckResult: 'scheduled', lastCheckErrorCode: null } : {}),
  };
  state.autoUpdate = next;
  try {
    persist();
  } catch (error) {
    state.autoUpdate = previous;
    throw error;
  }
  return currentAutoUpdateStatus();
}

let pendingCheck = null;
function performCheck() {
  if (pendingCheck) return pendingCheck;
  pendingCheck = (async () => {
    state.checkAttemptId = randomUUID();
    state.checkAttemptedAt = new Date().toISOString();
    state.checkFinishedAt = null;
    state.checkAttempts = 0;
    state.checkInProgress = true;
    state.checkError = null;
    state.checkErrorCode = null;
    persist();
    try {
      const result = await discoverLatest();
      state.latest = result.latest;
      state.checkAttempts = result.attempts;
      state.checkError = null;
      state.checkErrorCode = null;
      state.checkedAt = new Date().toISOString();
    } catch (error) {
      const classified = classifyRepositoryFetchError(error, error?.attempts ?? 1);
      state.checkError = classified.message;
      state.checkErrorCode = classified.code;
      state.checkAttempts = classified.attempts;
    } finally {
      state.checkInProgress = false;
      state.checkFinishedAt = new Date().toISOString();
      persist();
    }
    return currentStatus();
  })().finally(() => {
    pendingCheck = null;
  });
  return pendingCheck;
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
        if (health.version === target.version && health.commitSha === target.sha) {
          await runAsync('curl', [
            '--fail',
            '--silent',
            '--output',
            '/dev/null',
            '--max-time',
            '3',
            'http://gateway/',
          ]);
          return;
        }
      } catch {
        // The gateway can become reachable before the new API is ready.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  appendLog(job, '新版本健康检查超时。');
  throw new Error('新版本在 60 秒内未通过健康检查');
}

async function scheduleUpdaterRefresh(releasePath, env) {
  // Replacing this container kills every process inside it, including a detached
  // compose child. Let a separate, short-lived container finish the replacement.
  const args = [
    'run',
    '--detach',
    '--rm',
    '--name',
    `lexloop-updater-refresh-${env.APP_COMMIT_SHA.slice(0, 12)}`,
    '--volume',
    '/var/run/docker.sock:/var/run/docker.sock',
    '--volume',
    '/opt/lexloop:/opt/lexloop',
    '--env-file',
    config.productionEnv,
    '--entrypoint',
    'docker',
    `lexloop-updater:${env.LEXLOOP_IMAGE_TAG}`,
    'compose',
    '--project-name',
    'lexloop-ops',
    '--env-file',
    config.productionEnv,
    '--file',
    join(releasePath, 'deploy/compose.ops.yml'),
    'up',
    '--detach',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '90',
    'updater',
  ];
  await runAsync('docker', args, { env });
}

async function fenceSupplementVersion(version, releasePath, env) {
  // Stop writers before the compatibility read; an enabled API must not create
  // its first supplement between the check and starting an older image.
  await runAsync('docker', [...composeArgs(releasePath), 'stop', 'api', 'worker'], { env });
  const readExists = (sql) =>
    run('docker', [
      'exec',
      'lexloop-postgres',
      'psql',
      '-U',
      process.env.POSTGRES_USER ?? 'lexloop',
      '-d',
      process.env.POSTGRES_DB ?? 'lexloop',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]);
  assertSupplementCompatibility(version, () => readExists(SUPPLEMENT_EXISTS_SQL));
  assertProgressiveCompatibility(version, () => readExists(INVALIDATED_PLAN_EXISTS_SQL));
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
    const status = await performCheck();
    if (status.error || status.checkInProgress || !status.checkedAt) {
      throw new Error('无法完成更新前的远端检查，未启动安装。');
    }
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
    await runAsync(
      'docker',
      [
        'compose',
        '--project-name',
        'lexloop-ops',
        '--env-file',
        config.productionEnv,
        '--file',
        join(releasePath, 'deploy/compose.ops.yml'),
        'build',
        'updater',
      ],
      { env },
    );

    updateStage(job, 'BACKING_UP', '正在创建更新前数据库备份…');
    createBackup(job);

    switched = true; // Stopping writers also requires recovery if migration fails.
    await fenceSupplementVersion(target.version, releasePath, env);
    updateStage(job, 'MIGRATING', '正在执行数据库迁移…');
    await runAsync('docker', [...composeArgs(releasePath), 'run', '--rm', 'migrate'], { env });

    updateStage(job, 'DEPLOYING', '正在切换 Web、API 与 Worker…');
    // Compose can partially replace containers before reporting a failed dependency.
    switched = true;
    await runAsync(
      'docker',
      [
        ...composeArgs(releasePath),
        'up',
        '--detach',
        '--no-build',
        '--wait',
        '--wait-timeout',
        '180',
        'postgres',
        'redis',
        'web',
        'api',
        'worker',
        'gateway',
      ],
      { env },
    );

    updateStage(job, 'VERIFYING', '正在验证首页、API 版本和容器状态…');
    await verifyDeployment(target, job);

    saveProductionDeployment(deployment);
    state.deployment = deployment;
    job.stage = 'SUCCEEDED';
    job.message = `已更新到 v${target.version} (${target.sha.slice(0, 12)})`;
    job.finishedAt = new Date().toISOString();
    if (job.trigger === 'automatic') {
      state.autoUpdate.lastUpdateAt = job.startedAt;
      state.autoUpdate.lastUpdateResult = 'succeeded';
      state.autoUpdate.lastUpdateError = null;
      state.autoUpdate.lastCheckResult = 'update_available';
    }
    appendLog(job, job.message);
    recordHistory(job);
    persist();
    activeJob = null;
    setTimeout(() => {
      void scheduleUpdaterRefresh(releasePath, env).catch((error) => {
        state.checkError = `应用已更新，但更新服务刷新失败：${sanitize(error)}`;
        appendLog(job, state.checkError);
      });
    }, 1_000).unref();
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : error);
    appendLog(job, `更新失败：${message}`);
    if (switched && previous?.releasePath && previous?.imageTag) {
      try {
        await fenceSupplementVersion(previous.version, releasePath, env);
        appendLog(job, '正在恢复上一版应用镜像…');
        await runAsync(
          'docker',
          [
            ...composeArgs(previous.releasePath),
            'up',
            '--detach',
            '--no-build',
            '--wait',
            '--wait-timeout',
            '180',
            'web',
            'api',
            'worker',
            'gateway',
          ],
          { env: releaseEnvironment(previous) },
        );
        state.deployment = previous;
        saveProductionDeployment(previous);
        appendLog(job, '上一版应用镜像已恢复；数据库不会自动回滚。');
      } catch (rollbackError) {
        appendLog(job, `应用镜像恢复失败：${sanitize(rollbackError)}`);
      }
    }
    job.stage = 'FAILED';
    job.message = message;
    job.finishedAt = new Date().toISOString();
    state.job = job;
    if (job.trigger === 'automatic') {
      state.autoUpdate.lastUpdateAt = job.startedAt;
      state.autoUpdate.lastUpdateResult = 'failed';
      state.autoUpdate.lastUpdateError = '自动更新失败；请检查更新任务记录。';
      state.autoUpdate.lastCheckResult = 'update_available';
    }
    recordHistory(job);
    activeJob = null;
    persist();
  }
}

function createUpdateJob(target, { trigger = 'manual', actorId, actorEmail }) {
  const previousJob = state.job;
  const previousActiveJob = activeJob;
  const previousAutoUpdate = state.autoUpdate;
  const job = {
    id: randomUUID(),
    stage: 'CHECKING',
    message: trigger === 'automatic' ? '自动更新任务已创建' : '更新任务已创建',
    targetVersion: target.version,
    targetSha: target.sha,
    actorId,
    actorEmail,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    trigger,
  };
  activeJob = job;
  state.job = job;
  if (trigger === 'automatic') {
    state.autoUpdate = {
      ...state.autoUpdate,
      lastUpdateAt: job.startedAt,
      lastUpdateResult: 'running',
      lastUpdateError: null,
      lastCheckResult: 'updating',
    };
  }
  try {
    persist();
  } catch (error) {
    state.job = previousJob;
    activeJob = previousActiveJob;
    state.autoUpdate = previousAutoUpdate;
    throw error;
  }
  setImmediate(() => void runUpdate(job, target));
  return job;
}

let automaticUpdateTickInProgress = false;

async function automaticUpdateTick() {
  if (automaticUpdateTickInProgress) return;
  const settings = state.autoUpdate;
  const nextCheck = settings.nextCheckAt ? Date.parse(settings.nextCheckAt) : Number.NaN;
  if (
    !settings.enabled ||
    !Number.isFinite(nextCheck) ||
    Date.now() < nextCheck ||
    activeJob ||
    remoteBackups.state.running ||
    pendingCheck
  ) {
    return;
  }

  automaticUpdateTickInProgress = true;
  try {
    settings.nextCheckAt = new Date(
      Date.now() + settings.intervalHours * 60 * 60_000,
    ).toISOString();
    settings.lastCheckResult = 'checking';
    settings.lastCheckErrorCode = null;
    persist();

    const status = await performCheck();
    const currentSettings = state.autoUpdate;
    currentSettings.lastCheckAt = status.checkFinishedAt ?? new Date().toISOString();
    currentSettings.lastCheckErrorCode = status.checkErrorCode ?? null;
    if (status.error || status.checkInProgress || !status.checkedAt) {
      currentSettings.lastCheckResult = 'check_failed';
      persist();
      return;
    }
    if (!status.updateAvailable || !status.latest) {
      currentSettings.lastCheckResult = 'up_to_date';
      persist();
      return;
    }

    currentSettings.lastCheckResult = 'update_available';
    persist();
    if (!state.autoUpdate.enabled || activeJob || remoteBackups.state.running) return;
    createUpdateJob(status.latest, {
      trigger: 'automatic',
      actorId: 'system-auto-update',
      actorEmail: '自动更新',
    });
  } catch {
    state.autoUpdate.lastCheckAt = new Date().toISOString();
    state.autoUpdate.lastCheckResult = 'check_failed';
    state.autoUpdate.lastCheckErrorCode = 'UPDATER_CHECK_FAILED';
    try {
      persist();
    } catch {
      // Keep the in-memory next check time; an unavailable state disk must not spin checks.
    }
  } finally {
    automaticUpdateTickInProgress = false;
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
    if (request.url === '/backups' && request.method === 'GET') {
      return reply(response, 200, remoteBackups.status());
    }
    if (request.url === '/backups/config' && request.method === 'POST') {
      try {
        return reply(response, 200, remoteBackups.save(await readJson(request)));
      } catch (error) {
        return reply(response, 400, { message: error.message });
      }
    }
    if (request.url === '/backups/run' && request.method === 'POST') {
      if (activeJob || automaticUpdateTickInProgress || pendingCheck)
        return reply(response, 409, { message: '系统正在更新或自动检查更新，请稍后备份' });
      try {
        return reply(response, 202, remoteBackups.start());
      } catch (error) {
        return reply(response, 409, { message: error.message });
      }
    }
    if (request.method === 'GET' && request.url === '/status') {
      return reply(response, 200, currentStatus());
    }
    if (request.method === 'GET' && request.url === '/auto-update') {
      return reply(response, 200, currentAutoUpdateStatus());
    }
    if (request.method === 'POST' && request.url === '/auto-update') {
      const input = await readJson(request);
      if (
        typeof input.enabled !== 'boolean' ||
        !Number.isInteger(input.intervalHours) ||
        input.intervalHours < AUTO_UPDATE_MIN_INTERVAL_HOURS ||
        input.intervalHours > AUTO_UPDATE_MAX_INTERVAL_HOURS
      ) {
        return reply(response, 400, {
          message: `自动更新周期必须是 ${AUTO_UPDATE_MIN_INTERVAL_HOURS} 至 ${AUTO_UPDATE_MAX_INTERVAL_HOURS} 小时的整数，且必须明确选择启用状态。`,
        });
      }
      return reply(response, 200, saveAutoUpdate(input));
    }
    if (request.method === 'POST' && request.url === '/check') {
      if (activeJob || remoteBackups.state.running)
        return reply(response, 409, { message: '系统正在更新或备份，请稍后再检查版本' });
      return reply(response, 200, await performCheck());
    }
    if (request.method === 'GET' && request.url?.startsWith('/jobs/')) {
      const id = request.url.slice('/jobs/'.length);
      return state.job?.id === id
        ? reply(response, 200, state.job)
        : reply(response, 404, { message: '更新任务不存在' });
    }
    if (request.method === 'POST' && request.url === '/apply') {
      if (activeJob || remoteBackups.state.running || pendingCheck || automaticUpdateTickInProgress)
        return reply(response, 409, { message: '已有更新或备份任务正在执行' });
      const input = await readJson(request);
      if (
        activeJob ||
        remoteBackups.state.running ||
        pendingCheck ||
        automaticUpdateTickInProgress
      ) {
        return reply(response, 409, { message: '已有更新或备份任务正在执行' });
      }
      if (
        !parseStableVersion(input.targetVersion ?? '') ||
        !/^[0-9a-f]{40}$/.test(input.targetSha ?? '') ||
        typeof input.actorId !== 'string' ||
        typeof input.actorEmail !== 'string'
      ) {
        return reply(response, 400, { message: '更新请求参数无效' });
      }
      const job = createUpdateJob(
        { version: input.targetVersion, sha: input.targetSha },
        { trigger: 'manual', actorId: input.actorId, actorEmail: input.actorEmail },
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
await prepareSocketPath(config.socket);
server.on('error', (error) => {
  console.error(
    error?.code === 'EADDRINUSE'
      ? 'Lexloop updater 启动失败：已有实例占用更新服务 socket。'
      : `Lexloop updater 启动失败：${sanitize(error)}`,
  );
  process.exitCode = 1;
});
server.listen(config.socket, () => {
  chmodSync(config.socket, 0o660);
  console.log(`Lexloop updater listening on ${config.socket}`);
});

async function prepareSocketPath(socketPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let observed;
    try {
      observed = lstatSync(socketPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!observed.isSocket()) {
      throw new Error('更新服务 socket 路径已存在但不是 Unix socket；未删除该文件。');
    }

    const probe = await new Promise((resolveProbe) => {
      const client = connectSocket(socketPath);
      const timer = setTimeout(() => {
        client.destroy();
        resolveProbe({ connected: false, error: new Error('检查现有 updater socket 超时') });
      }, 500);
      client.once('connect', () => {
        clearTimeout(timer);
        client.destroy();
        resolveProbe({ connected: true });
      });
      client.once('error', (error) => {
        clearTimeout(timer);
        resolveProbe({ connected: false, error });
      });
    });
    if (probe.connected) throw new Error('已有 Lexloop updater 实例正在监听；未接管它的 socket。');
    if (!['ECONNREFUSED', 'ENOENT'].includes(probe.error?.code)) throw probe.error;

    let current;
    try {
      current = lstatSync(socketPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (current.dev !== observed.dev || current.ino !== observed.ino) continue;
    rmSync(socketPath);
    return;
  }
  throw new Error('更新服务 socket 状态持续变化；为避免接管其他实例而停止启动。');
}

const backgroundCheck = () => {
  void performCheck().catch((error) => console.error(sanitize(error)));
};
setInterval(backgroundCheck, 6 * 60 * 60 * 1_000).unref();

setInterval(() => void automaticUpdateTick(), 60_000).unref();
setTimeout(() => void automaticUpdateTick(), 5_000).unref();
setTimeout(backgroundCheck, 5_000).unref();

const scheduleBackup = () => {
  if (!activeJob) void remoteBackups.tick();
};
setInterval(scheduleBackup, 60_000).unref();
setTimeout(scheduleBackup, 10_000).unref();
