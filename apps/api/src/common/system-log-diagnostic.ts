export const SYSTEM_LOG_DIAGNOSTIC = Symbol.for('lexloop.systemLogDiagnostic');

export type SystemLogDiagnosticPhase =
  | 'provider_request'
  | 'response_parse'
  | 'content_parse'
  | 'content_validation'
  | 'plan_persistence'
  | 'internal';

export type SystemLogDiagnostic = {
  code: string;
  phase: SystemLogDiagnosticPhase;
  fieldPath: string;
  reason: string;
  repairAttempts?: number;
  maxRepairAttempts?: number;
};

const VALID_PHASES = new Set<SystemLogDiagnosticPhase>([
  'provider_request',
  'response_parse',
  'content_parse',
  'content_validation',
  'plan_persistence',
  'internal',
]);
const SAFE_FIELD_PATHS = new Set([
  'request',
  'response.body',
  'choices[0].message.content',
  'studyPlan.generatedContent',
  'studyPlan.generation',
  'public_material_claim',
  'groups',
  'groups[].sentences',
  'groups[].sentences[].english',
  'groups[].questions',
  'groups[].questions[].type',
  'groups[].questions[].prompt',
  'groups[].questions[].explanation',
  'groups[].questions[].options',
  'groups[].questions[].correctAnswers',
  'groups[].questions[].pairs',
]);

const VALID_REASONS = new Set([
  '模型供应商未完成请求；原始响应正文已隐藏。',
  '模型供应商连接失败；地址和凭据未记录。',
  '模型接口已响应，但响应正文不是有效 JSON；原始内容已隐藏。',
  '模型接口已响应，但未包含预期的结构化字段；原始内容已隐藏。',
  '模型返回的学习材料未通过内容校验；原始内容和词条已隐藏。',
  '学习材料已校验，但学习计划保存失败；内部异常详情已隐藏。',
  '学习计划生成失败；原始异常详情已隐藏。',
  '个别题目未通过校验，已达到本次局部修复上限；原始内容和词条已隐藏。',
  '个别题目已通过有限局部修复；题目内容未写入日志。',
  '等待同一公共材料超过时限；已停止发起重复模型请求。',
  '同一公共材料近期生成失败；处于短暂冷却期，未发起重复模型请求。',
  '公共材料生成协同租约失效；已停止本次后续模型请求。',
]);

export function attachSystemLogDiagnostic<T extends Error>(
  error: T,
  diagnostic: SystemLogDiagnostic,
): T {
  Object.defineProperty(error, SYSTEM_LOG_DIAGNOSTIC, {
    configurable: false,
    enumerable: false,
    value: diagnostic,
  });
  return error;
}

export function readSystemLogDiagnostic(value: unknown): SystemLogDiagnostic | undefined {
  if (!(value instanceof Error)) return undefined;
  const candidate = (value as Error & { [SYSTEM_LOG_DIAGNOSTIC]?: unknown })[SYSTEM_LOG_DIAGNOSTIC];
  if (!candidate || typeof candidate !== 'object') return undefined;
  const diagnostic = candidate as Partial<SystemLogDiagnostic>;
  if (
    typeof diagnostic.code !== 'string' ||
    !/^[A-Z0-9_]{1,80}$/.test(diagnostic.code) ||
    !VALID_PHASES.has(diagnostic.phase as SystemLogDiagnosticPhase) ||
    typeof diagnostic.fieldPath !== 'string' ||
    !SAFE_FIELD_PATHS.has(diagnostic.fieldPath) ||
    typeof diagnostic.reason !== 'string' ||
    !VALID_REASONS.has(diagnostic.reason) ||
    (diagnostic.repairAttempts !== undefined &&
      (!Number.isInteger(diagnostic.repairAttempts) ||
        diagnostic.repairAttempts < 0 ||
        diagnostic.repairAttempts > 3)) ||
    (diagnostic.maxRepairAttempts !== undefined && diagnostic.maxRepairAttempts !== 3)
  ) {
    return undefined;
  }
  return diagnostic as SystemLogDiagnostic;
}

export function isSafeSystemLogFieldPath(value: string) {
  return SAFE_FIELD_PATHS.has(value);
}
