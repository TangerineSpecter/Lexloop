import { compareVersions } from './core.mjs';

export const SUPPLEMENT_MIN_VERSION = '1.27.157';
// json conversion also works before the additive isSupplement migration.
export const SUPPLEMENT_EXISTS_SQL = `SELECT EXISTS (SELECT 1 FROM "VocabularyBook" b WHERE to_jsonb(b)->>'isSupplement' = 'true')`;
export function assertSupplementCompatibility(version, readExists) {
  if (compareVersions(version, SUPPLEMENT_MIN_VERSION) >= 0) return;
  const result = readExists();
  if (result !== 'f')
    throw new Error(
      result === 't'
        ? '数据库已创建补充词书，禁止启动不支持该数据的旧版本；暂停词书不能解除此限制。'
        : '无法核实补充词书兼容性，未启动旧版本。',
    );
}
