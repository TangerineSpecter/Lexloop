'use client';

import { useId, useState } from 'react';
import { request, userFacingError, type Session } from '../../lib/api';
import { parsePersonalVocabularyTsv } from '../../lib/personal-vocabulary-import';
import styles from './lab.module.css';

type ImportResult = { imported: number; restored: number; duplicates: number };

export function PersonalVocabularyImport({
  session,
  onImported,
}: {
  session: Session;
  onImported: () => void;
}) {
  const id = useId();
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const preview = parsePersonalVocabularyTsv(source);

  async function importRows(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !preview.items.length || preview.errors.length) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request<ImportResult>(
        '/vocabulary/personal/items/import',
        {
          method: 'POST',
          body: JSON.stringify({ items: preview.items }),
        },
        session.accessToken,
      );
      setSource('');
      setMessage(
        `已加入 ${result.imported} 个新词，恢复 ${result.restored} 个原词条；表内重复 ${preview.duplicates} 项、已有词条 ${result.duplicates} 项已跳过。新词加入复习；已有词条的释义和进度保留。`,
      );
      onImported();
    } catch (error) {
      setMessage(userFacingError(error, '导入失败。原文仍保留，可检查后重试。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={styles.collect} data-personal-vocabulary-import>
      <summary>＋ 批量导入自己的词表</summary>
      <form onSubmit={(event) => void importRows(event)} className={styles.form}>
        <label htmlFor={`${id}-tsv`}>
          粘贴制表符分隔的词表
          <span className={styles.meta}>
            每行：英文表达、中文释义、可选例句。最多 40 行；不会上传文件。
          </span>
          <textarea
            id={`${id}-tsv`}
            data-import-vocabulary-input
            disabled={busy}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setMessage('');
            }}
            placeholder={'look forward to\t期待\tI look forward to the weekend.\nnotice\t注意到'}
            rows={5}
            maxLength={57_000}
            spellCheck={false}
            aria-describedby={`${id}-help`}
          />
        </label>
        <p id={`${id}-help`} className={styles.meta}>
          可从电子表格复制两列或三列；仅在本页预览，不会调用 AI 或覆盖已有释义和复习记录。
        </p>
        {source.trim() && (
          <div className={styles.importPreview} data-import-vocabulary-preview aria-live="polite">
            <strong>
              预览：{preview.rowCount} 行，识别 {preview.items.length} 个不同词条
            </strong>
            {preview.duplicates > 0 && <span> · 表内重复 {preview.duplicates} 项将跳过</span>}
            {preview.errors.length > 0 && (
              <ul>
                {preview.errors.map((error, index) => (
                  <li key={`${error.line}-${index}`}>
                    {error.line ? `第 ${error.line} 行：` : ''}
                    {error.message}
                  </li>
                ))}
              </ul>
            )}
            {preview.items.length > 0 && (
              <p>
                {preview.items
                  .slice(0, 6)
                  .map((item) => item.text)
                  .join('、')}
                {preview.items.length > 6 ? '…' : ''}
              </p>
            )}
          </div>
        )}
        <button
          className={styles.primary}
          data-import-vocabulary-submit
          disabled={busy || !preview.items.length || preview.errors.length > 0}
        >
          {busy ? '正在安全导入…' : `导入 ${preview.items.length} 个词条`}
        </button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
