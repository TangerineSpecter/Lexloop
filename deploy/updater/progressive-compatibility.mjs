import { compareVersions } from './core.mjs';

export const PROGRESSIVE_RECOVERY_MIN_VERSION = '1.27.166';
// Cast to text: the query is also valid before INVALIDATED exists in the enum.
export const INVALIDATED_PLAN_EXISTS_SQL = `SELECT EXISTS (SELECT 1 FROM "StudyPlan" WHERE "status"::text = 'INVALIDATED')`;
export function assertProgressiveCompatibility(version, readExists) {
  if (compareVersions(version, PROGRESSIVE_RECOVERY_MIN_VERSION) >= 0) return;
  const result = readExists();
  if (result !== 'f')
    throw new Error(
      result === 't'
        ? '数据库已有 INVALIDATED 学习计划，禁止启动不支持该状态的旧版本；关闭恢复开关不能解除此限制。'
        : '无法核实学习计划恢复兼容性，未启动旧版本。',
    );
}
