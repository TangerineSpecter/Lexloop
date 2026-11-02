import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  RemoteBackupStatus,
  SystemAutoUpdateStatus,
  SystemUpdateJob,
  SystemUpdateStatus,
} from '@lexloop/types';
import { request } from 'node:http';
import { AuthService } from '../auth/auth.service';

import type { BackupSettingsDto } from './system-backup.dto';

type Actor = { sub: string; email: string };

const SAFE_CHECK_ERRORS: Record<string, string> = {
  GIT_TLS_INTERRUPTED: 'GitHub TLS 连接中断；已有限重试，远端版本尚未确认。',
  GIT_FETCH_TIMEOUT: '连接 GitHub 超时；已有限重试，远端版本尚未确认。',
  GIT_NETWORK_INTERRUPTED: '与 GitHub 的网络连接中断；已有限重试，远端版本尚未确认。',
  GIT_AUTH_FAILED: '读取受信任 GitHub 仓库时认证或权限不足；未自动重试。',
  GIT_REPOSITORY_UNAVAILABLE: '无法读取已配置的受信任仓库；未自动重试。',
  GIT_FETCH_FAILED: '读取受信任仓库失败；未自动重试。',
  GIT_CHECK_TIMEOUT: '更新检查超过总时限；远端版本尚未确认。',
  UPDATER_CHECK_INTERRUPTED: '更新检查因 updater 重启而中断；当前保留上次成功检查结果。',
  UPDATER_REFRESH_FAILED: '应用已更新，但更新服务刷新失败；请检查 updater 日志。',
};

@Injectable()
export class SystemUpdateService {
  private readonly socketPath = process.env.UPDATER_SOCKET ?? '/run/lexloop/updater.sock';
  private readonly recentApply = new Map<string, number>();

  constructor(private readonly auth: AuthService) {}

  async status(): Promise<SystemUpdateStatus> {
    try {
      return this.safeStatus(await this.call<SystemUpdateStatus>('GET', '/status'));
    } catch {
      return this.unavailableStatus();
    }
  }

  async check(): Promise<SystemUpdateStatus> {
    return this.safeStatus(
      await this.call<SystemUpdateStatus>('POST', '/check', this.buildIdentity()),
    );
  }

  async autoUpdateStatus(): Promise<SystemAutoUpdateStatus> {
    try {
      return await this.call<SystemAutoUpdateStatus>('GET', '/auto-update');
    } catch {
      return {
        available: false,
        enabled: false,
        intervalHours: 24,
        lastCheckAt: null,
        nextCheckAt: null,
        lastCheckResult: 'never',
        lastCheckErrorCode: null,
        lastUpdateAt: null,
        lastUpdateResult: 'never',
        lastUpdateError: null,
      };
    }
  }

  saveAutoUpdate(settings: { enabled: boolean; intervalHours: number }) {
    return this.call<SystemAutoUpdateStatus>('POST', '/auto-update', settings);
  }

  async apply(actor: Actor, input: { targetVersion: string; targetSha: string; password: string }) {
    const lastAttempt = this.recentApply.get(actor.sub) ?? 0;
    if (Date.now() - lastAttempt < 60_000) {
      throw new HttpException('更新请求过于频繁，请一分钟后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.auth.verifyPassword(actor.sub, input.password);
    this.recentApply.set(actor.sub, Date.now());
    try {
      return await this.call<{ jobId: string; stage: string }>('POST', '/apply', {
        ...this.buildIdentity(),
        targetVersion: input.targetVersion,
        targetSha: input.targetSha,
        actorId: actor.sub,
        actorEmail: actor.email,
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw error;
    }
  }

  job(id: string): Promise<SystemUpdateJob> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ConflictException('更新任务 ID 无效');
    return this.call<SystemUpdateJob>('GET', `/jobs/${encodeURIComponent(id)}`);
  }

  async backupStatus() {
    try {
      return await this.call<RemoteBackupStatus>('GET', '/backups');
    } catch {
      return { available: false, settings: null, error: '备份服务未连接，请部署新版运维服务。' };
    }
  }

  async saveBackup(actorId: string, input: BackupSettingsDto) {
    await this.auth.verifyPassword(actorId, input.password);
    const { password, ...settings } = input;
    return this.call<RemoteBackupStatus>('POST', '/backups/config', settings);
  }

  async runBackup(actorId: string, password: string) {
    await this.auth.verifyPassword(actorId, password);
    return this.call<RemoteBackupStatus>('POST', '/backups/run');
  }

  private buildIdentity() {
    return {
      currentVersion: process.env.APP_VERSION ?? 'development',
      currentSha: process.env.APP_COMMIT_SHA ?? 'unknown',
    };
  }

  private safeStatus(status: SystemUpdateStatus): SystemUpdateStatus {
    if (!status.error || !status.updaterAvailable) return status;
    const code = status.checkErrorCode;
    if (code && SAFE_CHECK_ERRORS[code]) {
      return { ...status, error: SAFE_CHECK_ERRORS[code] };
    }
    if (status.error.startsWith('应用已更新，但更新服务刷新失败')) {
      return {
        ...status,
        checkErrorCode: 'UPDATER_REFRESH_FAILED',
        error: SAFE_CHECK_ERRORS.UPDATER_REFRESH_FAILED,
      };
    }
    // Older updater releases could return raw Git stderr. Never pass that text to the UI.
    return {
      ...status,
      checkErrorCode: code ?? 'GIT_FETCH_FAILED',
      latest: null,
      updateAvailable: false,
      sameVersionRevision: false,
      checkedAt: null,
      checkAttemptedAt: status.checkAttemptedAt ?? status.checkedAt,
      checkFinishedAt: status.checkFinishedAt ?? status.checkedAt,
      error: '更新检查失败，旧版服务未保存成功检查结果；远端版本尚未确认。',
    };
  }

  private unavailableStatus(): SystemUpdateStatus {
    return {
      ...this.buildIdentity(),
      updaterAvailable: false,
      error: '更新服务未运行；本地开发环境可忽略此提示。',
      latest: null,
      updateAvailable: false,
      sameVersionRevision: false,
      checkedAt: null,
      checkInProgress: false,
      checkAttemptId: null,
      checkAttemptedAt: null,
      checkFinishedAt: null,
      checkAttempts: 0,
      checkErrorCode: null,
      job: null,
    };
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          timeout: path === '/check' ? 75_000 : 15_000,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : undefined,
        },
        (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (raw += chunk));
          response.on('end', () => {
            let parsed: { message?: string } = {};
            try {
              parsed = raw ? (JSON.parse(raw) as { message?: string }) : {};
            } catch {
              return reject(new ServiceUnavailableException('更新服务返回了无效响应'));
            }
            if ((response.statusCode ?? 500) >= 400) {
              if (response.statusCode === 400)
                return reject(new BadRequestException(parsed.message));
              if (response.statusCode === 409) return reject(new ConflictException(parsed.message));
              return reject(
                new ServiceUnavailableException(parsed.message ?? '更新服务暂时不可用，请稍后再试'),
              );
            }
            resolve(parsed as T);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('updater timeout')));
      req.on('error', () =>
        reject(new ServiceUnavailableException('更新服务暂时不可用，请稍后再试')),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }
}
