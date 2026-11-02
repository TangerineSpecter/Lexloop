import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { isSafeSystemLogFieldPath } from '../../common/system-log-diagnostic';

export type SystemLogSource = 'api' | 'worker';
export type SystemLogSeverity = 'error' | 'info';

export type SystemLogInput = {
  source: SystemLogSource;
  severity?: SystemLogSeverity;
  kind: string;
  code: string;
  reason: string;
  status?: number;
  upstreamStatus?: number;
  param?: string;
  method?: string;
  route?: string;
  phase?: string;
  fieldPath?: string;
  attemptsMade?: number;
  maxAttempts?: number;
  at?: Date;
};

export type SystemLogEvent = Omit<SystemLogInput, 'at'> & {
  severity: SystemLogSeverity;
  at: string;
  day: string;
  epoch: number;
  fingerprint: string;
};

export type SystemLogState = { epoch: number; clearedAt: string | null };
export type SystemLogWriteResult = 'written' | 'dropped' | 'unavailable';

const RETENTION_DAYS = 14;
const MAX_LOG_BYTES_PER_SOURCE = 49 * 1024 * 1024;
const MAX_HEALTH_BYTES_PER_SOURCE = 1 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024;
const LOG_FILE_PATTERN = /^system-log-(api|worker)-(\d+)-(\d{4}-\d{2}-\d{2})-e(\d+)\.jsonl$/;
const HEALTH_FILE_PATTERN =
  /^system-log-health-(api|worker)-(\d+)-(\d{4}-\d{2}-\d{2})-e(\d+)\.json$/;
const pendingWrites = new Map<string, Promise<SystemLogWriteResult>>();
const pendingClears = new Map<string, Promise<SystemLogState>>();
const processDrops = new Map<string, { count: number; reason: string }>();
const SAFE_REASONS = new Set([
  '每日内容后台任务失败；用户内容和任务标识未记录。',
  '每日内容队列连接发生错误；原始错误详情已隐藏。',
  '输出批改后台任务失败；学习者输入和任务标识未记录。',
  '输出批改队列连接发生错误；原始错误详情已隐藏。',
  '精读语法后台任务失败；学习者输入和任务标识未记录。',
  '精读语法队列连接发生错误；原始错误详情已隐藏。',
  '后台任务服务启动失败；原始错误详情已隐藏。',
  '模型供应商未完成请求；原始响应正文已隐藏。',
  '模型供应商连接失败；地址和凭据未记录。',
  '模型接口已响应，但响应正文不是有效 JSON；原始内容已隐藏。',
  '模型接口已响应，但未包含预期的结构化字段；原始内容已隐藏。',
  '模型返回的学习材料未通过内容校验；原始内容和词条已隐藏。',
  '学习材料已校验，但学习计划保存失败；内部异常详情已隐藏。',
  '学习计划生成失败；原始异常详情已隐藏。',
  '个别题目未通过校验，已达到本次局部修复上限；原始内容和词条已隐藏。',
  '个别题目已通过有限局部修复；题目内容未写入日志。',
  '该计划复用了符合词目、模式、题型和当前熟悉度条件的公共材料；未记录题目内容。',
  '匹配词目没有来源可确认的公共材料；未记录词条或题目。',
  '匹配材料只有停用版本；未记录词条或题目。',
  '匹配材料对应题目均已答对；未记录词条或题目。',
  '候选公共材料未通过内容校验或达到候选上限；未记录材料内容。',
  '公共材料正由其他请求准备；未记录词条或题目。',
  '等待同一公共材料超过时限；已停止发起重复模型请求。',
  '同一公共材料近期生成失败；处于短暂冷却期，未发起重复模型请求。',
  '公共材料生成协同租约失效；已停止本次后续模型请求。',
  '应用记录了一条错误；原始详情已隐藏。',
  '接口已接受请求，但没有返回可解析的结构化生成结果。',
  '接口返回了非 JSON 错误响应；请检查 API 地址是否指向兼容接口。',
  '模型认证未通过，请检查已保存的 API Key 和供应商权限。',
  '接口或模型路由未找到，请检查 API 地址与模型配置。',
  '供应商处理请求超时。',
  '请求被限流或额度策略拒绝。',
  '供应商暂时无法处理请求。',
  '供应商未接受本次请求，请核对模型名称和请求参数。',
  '更新仓库检查失败；原始 Git 输出已隐藏。',
]);

export function systemLogDirectory(): string {
  return process.env.LEXLOOP_LOG_DIR || resolve(process.cwd(), 'var', 'system-logs');
}

export function systemLogTimeZone(): string {
  const configured = process.env.APP_TIMEZONE || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en', { timeZone: configured });
    return configured;
  } catch {
    return 'Asia/Shanghai';
  }
}

export function systemLogDay(date: Date): string {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: systemLogTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    values.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function shiftSystemLogDay(day: string, amount: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + amount)).toISOString().slice(0, 10);
}

export async function readSystemLogState(
  directory = systemLogDirectory(),
): Promise<SystemLogState> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(`${directory}/system-log-state.json`, 'utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('epoch' in parsed) ||
      typeof parsed.epoch !== 'number' ||
      !Number.isSafeInteger(parsed.epoch) ||
      parsed.epoch < 0 ||
      !('clearedAt' in parsed) ||
      (parsed.clearedAt !== null && typeof parsed.clearedAt !== 'string')
    ) {
      throw new Error('Invalid system log state');
    }
    return { epoch: parsed.epoch, clearedAt: parsed.clearedAt as string | null };
  } catch (error) {
    if (isMissingFile(error)) return { epoch: 0, clearedAt: null };
    throw new Error('System log state is unavailable');
  }
}

export function appendSystemLogEvent(input: SystemLogInput): Promise<SystemLogWriteResult> {
  const directory = systemLogDirectory();
  const queueKey = `${directory}:${input.source}`;
  const prior = pendingWrites.get(queueKey) ?? Promise.resolve('written' as const);
  const current = prior
    .catch(() => 'unavailable' as const)
    .then(() => appendOneSystemLogEvent(input, directory))
    .catch(() => 'unavailable' as const);
  pendingWrites.set(queueKey, current);
  void current.finally(() => {
    if (pendingWrites.get(queueKey) === current) pendingWrites.delete(queueKey);
  });
  return current;
}

export async function readSystemLogEvents(
  from: string,
  to: string,
): Promise<{
  events: SystemLogEvent[];
  state: SystemLogState;
  usedBytes: number;
  droppedEvents: number;
  unreadableFiles: number;
}> {
  const events: SystemLogEvent[] = [];
  const summary = await scanSystemLogEvents(from, to, (event) => events.push(event));
  return { ...summary, events };
}

export async function scanSystemLogEvents(
  from: string,
  to: string,
  onEvent: (event: SystemLogEvent) => void,
): Promise<{
  state: SystemLogState;
  usedBytes: number;
  droppedEvents: number;
  unreadableFiles: number;
}> {
  const directory = systemLogDirectory();
  const state = await readSystemLogState(directory);
  const names = await readdir(directory).catch((error) =>
    isMissingFile(error) ? [] : Promise.reject(error),
  );
  const files = names
    .map((name) => ({ name, match: LOG_FILE_PATTERN.exec(name) }))
    .filter(
      (item): item is { name: string; match: RegExpExecArray } =>
        item.match !== null &&
        Number(item.match[4]) === state.epoch &&
        item.match[3] >= from &&
        item.match[3] <= to,
    );
  let unreadableFiles = 0;
  let usedBytes = 0;
  let droppedEvents = 0;
  const logFiles = names
    .map((name) => ({ name, match: LOG_FILE_PATTERN.exec(name) ?? HEALTH_FILE_PATTERN.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null);
  for (const file of logFiles) {
    try {
      usedBytes += (await stat(`${directory}/${file.name}`)).size;
    } catch {
      unreadableFiles += 1;
    }
  }
  for (const file of files) {
    try {
      const lines = createInterface({
        input: createReadStream(`${directory}/${file.name}`),
        crlfDelay: Infinity,
      });
      try {
        for await (const line of lines) {
          if (!line) continue;
          try {
            const event: unknown = JSON.parse(line);
            const safeEvent = parseSystemLogEvent(event, state.epoch, from, to);
            if (safeEvent) onEvent(safeEvent);
            else unreadableFiles += 1;
          } catch {
            unreadableFiles += 1;
          }
        }
      } finally {
        lines.close();
      }
    } catch {
      unreadableFiles += 1;
    }
  }
  for (const name of names) {
    const match = HEALTH_FILE_PATTERN.exec(name);
    if (!match || Number(match[4]) !== state.epoch) continue;
    try {
      const health: unknown = JSON.parse(await readFile(`${directory}/${name}`, 'utf8'));
      if (typeof health === 'object' && health !== null && 'droppedEvents' in health) {
        const count = (health as { droppedEvents?: unknown }).droppedEvents;
        if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
          droppedEvents += count;
      }
    } catch {
      unreadableFiles += 1;
    }
  }
  return { state, usedBytes, droppedEvents, unreadableFiles };
}

export function clearSystemLogFiles(directory = systemLogDirectory()): Promise<SystemLogState> {
  const pending = pendingClears.get(directory) ?? Promise.resolve({ epoch: -1, clearedAt: null });
  const current = pending
    .catch(() => ({ epoch: -1, clearedAt: null }))
    .then(async () => {
      const before = await readSystemLogState(directory);
      const next: SystemLogState = { epoch: before.epoch + 1, clearedAt: new Date().toISOString() };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temp = `${directory}/system-log-state-${process.pid}-${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, `${directory}/system-log-state.json`);
      const names = await readdir(directory);
      await Promise.all(
        names
          .map((name) => ({
            name,
            match: LOG_FILE_PATTERN.exec(name) ?? HEALTH_FILE_PATTERN.exec(name),
          }))
          .filter((item) => item.match && Number(item.match[4]) < next.epoch)
          .map(({ name }) => unlink(`${directory}/${name}`).catch(() => undefined)),
      );
      return next;
    });
  pendingClears.set(directory, current);
  void current.then(
    () => {
      if (pendingClears.get(directory) === current) pendingClears.delete(directory);
    },
    () => {
      if (pendingClears.get(directory) === current) pendingClears.delete(directory);
    },
  );
  return current;
}

export async function pruneSystemLogRetention() {
  const directory = systemLogDirectory();
  const today = systemLogDay(new Date());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await Promise.all([
    pruneExpiredFiles(directory, 'api', today),
    pruneExpiredFiles(directory, 'worker', today),
  ]);
}

async function appendOneSystemLogEvent(
  input: SystemLogInput,
  directory: string,
): Promise<SystemLogWriteResult> {
  const at = (input.at ?? new Date()).toISOString();
  const day = systemLogDay(new Date(at));
  const state = await readSystemLogState(directory);
  const event = sanitizeEvent(input, at, day, state.epoch);
  const line = `${JSON.stringify(event)}\n`;
  const lineBytes = Buffer.byteLength(line);
  const dropKey = `${directory}:${input.source}:${process.pid}:${day}:${state.epoch}`;
  if (lineBytes > MAX_EVENT_BYTES) {
    await noteDrop(directory, input.source, day, state.epoch, dropKey, 'single_event_limit');
    return 'dropped';
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await pruneExpiredFiles(directory, input.source, day);
  const existingBytes = await sourceLogBytes(directory, input.source);
  if (existingBytes + lineBytes > MAX_LOG_BYTES_PER_SOURCE) {
    await noteDrop(directory, input.source, day, state.epoch, dropKey, 'source_capacity_limit');
    return 'dropped';
  }
  const filename = `${directory}/system-log-${input.source}-${process.pid}-${day}-e${state.epoch}.jsonl`;
  await appendFile(filename, line, { encoding: 'utf8', mode: 0o600 });
  const after = await readSystemLogState(directory);
  if (after.epoch !== state.epoch) await unlink(filename).catch(() => undefined);
  return 'written';
}

function sanitizeEvent(
  input: SystemLogInput,
  at: string,
  day: string,
  epoch: number,
): SystemLogEvent {
  const kind = safeIdentifier(input.kind, 'application.error');
  const code = safeIdentifier(input.code, 'APPLICATION_ERROR');
  const severity: SystemLogSeverity = input.severity === 'info' ? 'info' : 'error';
  const route = safeRoute(input.route);
  const method = input.method && /^[A-Z]{3,8}$/.test(input.method) ? input.method : undefined;
  const param =
    input.param && /^[A-Za-z0-9_.:/-]{1,80}$/.test(input.param) ? input.param : undefined;
  const status = safeStatus(input.status);
  const upstreamStatus = safeStatus(input.upstreamStatus);
  const reason = safeReason(input.reason);
  const phase =
    input.phase &&
    [
      'retry',
      'final',
      'provider_request',
      'response_parse',
      'content_parse',
      'content_validation',
      'plan_persistence',
      'internal',
    ].includes(input.phase)
      ? input.phase
      : undefined;
  const fieldPath =
    input.fieldPath && isSafeSystemLogFieldPath(input.fieldPath) ? input.fieldPath : undefined;
  const attemptsMade = safeCount(input.attemptsMade);
  const maxAttempts = safeCount(input.maxAttempts);
  const fingerprintFields: unknown[] = [input.source, kind, code, method ?? null, route ?? null];
  if (severity === 'info') fingerprintFields.push(severity);
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintFields)).digest('hex');
  return {
    at,
    day,
    epoch,
    fingerprint,
    source: input.source,
    severity,
    kind,
    code,
    ...(status ? { status } : {}),
    ...(upstreamStatus ? { upstreamStatus } : {}),
    ...(param ? { param } : {}),
    ...(method ? { method } : {}),
    ...(route ? { route } : {}),
    ...(phase ? { phase } : {}),
    ...(fieldPath ? { fieldPath } : {}),
    ...(attemptsMade !== undefined ? { attemptsMade } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    reason,
  };
}

function safeIdentifier(value: string, fallback: string): string {
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(normalized) ? normalized : fallback;
}

function safeRoute(value?: string): string | undefined {
  if (!value || value.length > 160) return undefined;
  const route = value.split('?')[0];
  return /^\/[A-Za-z0-9_.:/{}-]*$/.test(route) ? route : undefined;
}

function safeReason(value: string): string {
  const reason = value.trim();
  if (SAFE_REASONS.has(reason)) return reason;
  if (/^服务器处理请求失败（HTTP [1-5]\d\d）；原始异常详情已隐藏。$/.test(reason)) return reason;
  if (/^测试请求超过 \d{1,3} 秒，未收到接口响应。$/.test(reason)) return reason;
  if (/^未收到接口响应；请检查 API 地址、TLS 证书或网络连接。$/.test(reason)) return reason;
  if (/^供应商错误响应过长，已隐藏原文。$/.test(reason)) return reason;
  if (/^接口返回了非 JSON 错误响应；请检查 API 地址是否指向兼容接口。$/.test(reason)) return reason;
  if (/^模型认证未通过，请检查已保存的 API Key 和供应商权限。$/.test(reason)) return reason;
  if (/^接口或模型路由未找到，请检查 API 地址与模型配置。$/.test(reason)) return reason;
  if (/^供应商处理请求超时。$/.test(reason)) return reason;
  if (/^请求被限流或额度策略拒绝。$/.test(reason)) return reason;
  if (/^供应商暂时无法处理请求。$/.test(reason)) return reason;
  if (/^供应商未接受本次请求，请核对模型名称和请求参数。$/.test(reason)) return reason;
  return '应用记录了一条错误；原始详情已隐藏。';
}

function safeStatus(value?: number): number | undefined {
  return Number.isInteger(value) && value! >= 100 && value! <= 599 ? value : undefined;
}

function safeCount(value?: number): number | undefined {
  return Number.isSafeInteger(value) && value! >= 0 && value! <= 1_000_000 ? value : undefined;
}

function parseSystemLogEvent(
  value: unknown,
  epoch: number,
  from: string,
  to: string,
): SystemLogEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const event = value as Partial<SystemLogEvent>;
  if (
    event.epoch !== epoch ||
    (event.source !== 'api' && event.source !== 'worker') ||
    typeof event.at !== 'string' ||
    !Number.isFinite(Date.parse(event.at)) ||
    typeof event.day !== 'string' ||
    event.day < from ||
    event.day > to ||
    systemLogDay(new Date(event.at)) !== event.day ||
    typeof event.kind !== 'string' ||
    typeof event.code !== 'string' ||
    typeof event.fingerprint !== 'string'
  ) {
    return undefined;
  }
  const safeEvent = sanitizeEvent(
    {
      source: event.source,
      severity: event.severity === 'info' ? 'info' : 'error',
      kind: event.kind,
      code: event.code,
      reason: typeof event.reason === 'string' ? event.reason : '',
      status: event.status,
      upstreamStatus: event.upstreamStatus,
      param: event.param,
      method: event.method,
      route: event.route,
      phase: event.phase,
      fieldPath: event.fieldPath,
      attemptsMade: event.attemptsMade,
      maxAttempts: event.maxAttempts,
    },
    new Date(event.at).toISOString(),
    event.day,
    epoch,
  );
  return safeEvent.fingerprint === event.fingerprint ? safeEvent : undefined;
}

async function pruneExpiredFiles(directory: string, source: SystemLogSource, today: string) {
  const cutoff = shiftSystemLogDay(today, -(RETENTION_DAYS - 1));
  const names = await readdir(directory);
  await Promise.all(
    names
      .map((name) => ({
        name,
        match: LOG_FILE_PATTERN.exec(name) ?? HEALTH_FILE_PATTERN.exec(name),
      }))
      .filter((item) => item.match?.[1] === source && (item.match?.[3] ?? today) < cutoff)
      .map(({ name }) => unlink(`${directory}/${name}`).catch(() => undefined)),
  );
}

async function sourceLogBytes(directory: string, source: SystemLogSource): Promise<number> {
  const names = await readdir(directory);
  const files = names.filter((name) => {
    const match = LOG_FILE_PATTERN.exec(name) ?? HEALTH_FILE_PATTERN.exec(name);
    return match?.[1] === source;
  });
  const sizes = await Promise.all(
    files.map((name) =>
      stat(`${directory}/${name}`)
        .then((item) => item.size)
        .catch(() => 0),
    ),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function noteDrop(
  directory: string,
  source: SystemLogSource,
  day: string,
  epoch: number,
  key: string,
  reason: string,
) {
  const previous = processDrops.get(key) ?? { count: 0, reason };
  const next = { count: previous.count + 1, reason };
  processDrops.set(key, next);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const filename = `${directory}/system-log-health-${source}-${process.pid}-${day}-e${epoch}.json`;
    const existing = await readFile(filename, 'utf8').catch(() => '');
    let persistedCount = 0;
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed === 'object' && parsed !== null && 'droppedEvents' in parsed) {
        const value = (parsed as { droppedEvents?: unknown }).droppedEvents;
        if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
          persistedCount = value;
      }
    } catch {
      // A damaged health counter is replaced with the current process count.
    }
    const count = Math.max(next.count, persistedCount + 1);
    const healthBytes = await healthFileBytes(directory, source);
    const record = JSON.stringify({
      source,
      processId: process.pid,
      day,
      epoch,
      droppedEvents: count,
      reason,
      updatedAt: new Date().toISOString(),
    });
    const recordBytes = Buffer.byteLength(record);
    const previousSize = Buffer.byteLength(existing);
    if (healthBytes - previousSize + recordBytes > MAX_HEALTH_BYTES_PER_SOURCE) return;
    const temp = `${filename}.${Date.now()}.tmp`;
    await writeFile(temp, record, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, filename);
    const activeState = await readSystemLogState(directory);
    if (activeState.epoch !== epoch) await unlink(filename).catch(() => undefined);
  } catch {
    // Logging health failures must never recurse into the application logger.
  }
}

async function healthFileBytes(directory: string, source: SystemLogSource): Promise<number> {
  const names = await readdir(directory);
  const files = names.filter((name) => HEALTH_FILE_PATTERN.exec(name)?.[1] === source);
  const sizes = await Promise.all(
    files.map((name) =>
      stat(`${directory}/${name}`)
        .then((item) => item.size)
        .catch(() => 0),
    ),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
