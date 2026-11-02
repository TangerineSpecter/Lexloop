import {
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  type ExceptionFilter,
  type ArgumentsHost,
} from '@nestjs/common';
import { SystemLogService } from './system-log.service';
import { readSystemLogDiagnostic } from '../../common/system-log-diagnostic';

type FilterRequest = {
  method?: string;
  routeOptions?: { url?: string };
};
type FilterReply = {
  status(code: number): { send(payload: unknown): unknown };
};

@Catch()
@Injectable()
export class SystemLogExceptionFilter implements ExceptionFilter {
  constructor(private readonly logs: SystemLogService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<FilterRequest>();
    const response = http.getResponse<FilterReply>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) {
      const diagnostic = readSystemLogDiagnostic(exception);
      const providerDetails =
        exception instanceof HttpException
          ? safeProviderDetails(exception.getResponse())
          : undefined;
      void this.logs.record({
        source: 'api',
        kind: 'http.exception',
        code: providerDetails?.code ?? diagnostic?.code ?? `HTTP_${status}`,
        status,
        ...(providerDetails?.upstreamStatus
          ? { upstreamStatus: providerDetails.upstreamStatus }
          : {}),
        ...(providerDetails?.param ? { param: providerDetails.param } : {}),
        ...(request.method && /^[A-Z]{3,8}$/.test(request.method)
          ? { method: request.method }
          : {}),
        ...(request.routeOptions?.url ? { route: request.routeOptions.url } : {}),
        ...(diagnostic ? { phase: diagnostic.phase, fieldPath: diagnostic.fieldPath } : {}),
        ...(diagnostic?.repairAttempts !== undefined
          ? {
              attemptsMade: diagnostic.repairAttempts,
              maxAttempts: diagnostic.maxRepairAttempts ?? 3,
            }
          : {}),
        reason: providerDetails
          ? (diagnostic?.reason ?? '模型供应商未完成请求；原始响应正文已隐藏。')
          : diagnostic
            ? diagnostic.reason
            : `服务器处理请求失败（HTTP ${status}）；原始异常详情已隐藏。`,
      });
    }

    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };
    return response.status(status).send(body);
  }
}

function safeProviderDetails(
  response: string | object,
): { upstreamStatus: number; code?: string; param?: string } | undefined {
  const message =
    typeof response === 'string'
      ? response
      : typeof response === 'object' && response !== null && 'message' in response
        ? (response as { message?: unknown }).message
        : undefined;
  if (typeof message !== 'string') return undefined;
  const status = /上游 HTTP (\d{3})/.exec(message)?.[1];
  if (!status) return undefined;
  const code = /code: ([A-Za-z0-9_.:/-]{1,80})/.exec(message)?.[1];
  const param = /param: ([A-Za-z0-9_.:/-]{1,80})/.exec(message)?.[1];
  return {
    upstreamStatus: Number(status),
    ...(code ? { code: `UPSTREAM_${code}` } : {}),
    ...(param ? { param } : {}),
  };
}
