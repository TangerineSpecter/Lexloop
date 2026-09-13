import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SystemUpdateJob, SystemUpdateStatus } from '@lexloop/types';
import { request } from 'node:http';
import { AuthService } from '../auth/auth.service';

type Actor = { sub: string; email: string };

@Injectable()
export class SystemUpdateService {
  private readonly socketPath = process.env.UPDATER_SOCKET ?? '/run/lexloop/updater.sock';
  private readonly recentApply = new Map<string, number>();

  constructor(private readonly auth: AuthService) {}

  async status(): Promise<SystemUpdateStatus> {
    try {
      return await this.call<SystemUpdateStatus>('GET', '/status');
    } catch {
      return this.unavailableStatus();
    }
  }

  async check(): Promise<SystemUpdateStatus> {
    return this.call<SystemUpdateStatus>('POST', '/check', this.buildIdentity());
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

  private buildIdentity() {
    return {
      currentVersion: process.env.APP_VERSION ?? 'development',
      currentSha: process.env.APP_COMMIT_SHA ?? 'unknown',
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
          timeout: 15_000,
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
