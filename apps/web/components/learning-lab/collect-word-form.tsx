'use client';

import { useId, useState } from 'react';
import type { NotebookSource } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import styles from './lab.module.css';

type CollectWordProps = {
  session: Session;
  sourceType: NotebookSource;
  source: string;
  example?: string;
  text?: string;
  meaning?: string;
  onSaved?: () => void;
};

export function CollectWordForm(props: CollectWordProps) {
  const context = JSON.stringify([
    props.sourceType,
    props.source,
    props.example,
    props.text,
    props.meaning,
  ]);
  return <CollectWordFields key={context} {...props} />;
}

function CollectWordFields({
  session,
  sourceType,
  source,
  example = '',
  text = '',
  meaning = '',
  onSaved,
}: CollectWordProps) {
  const id = useId();
  const [word, setWord] = useState(text);
  const [definition, setDefinition] = useState(meaning);
  const [sentence, setSentence] = useState(example.slice(0, 800));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await request(
        '/vocabulary/personal/items',
        {
          method: 'POST',
          body: JSON.stringify({
            text: word.trim(),
            type: /\s/.test(word.trim()) ? 'PHRASE' : 'WORD',
            meaning: definition.trim(),
            example: sentence.trim(),
            sourceScenario: source.slice(0, 160),
            sourceType,
          }),
        },
        session.accessToken,
      );
      setMessage('已收藏。新词已加入复习；重复收藏保留原句与学习状态。');
      onSaved?.();
    } catch (error) {
      setMessage(userFacingError(error, '收藏失败'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className={styles.collect}>
      <summary>＋ 收藏单词或短语到生词本</summary>
      <form onSubmit={(event) => void save(event)} className={styles.form}>
        <label htmlFor={`${id}-word`}>
          英文单词或短语
          <input
            id={`${id}-word`}
            required
            maxLength={120}
            value={word}
            onChange={(event) => setWord(event.target.value)}
            placeholder="例如：look forward to"
          />
        </label>
        <label htmlFor={`${id}-meaning`}>
          语境中的词义
          <input
            id={`${id}-meaning`}
            required
            maxLength={500}
            value={definition}
            onChange={(event) => setDefinition(event.target.value)}
            placeholder="记下这一次遇到的意思"
          />
        </label>
        <label htmlFor={`${id}-example`}>
          原句或例句
          <textarea
            id={`${id}-example`}
            required
            maxLength={800}
            rows={3}
            value={sentence}
            onChange={(event) => setSentence(event.target.value)}
          />
        </label>
        <button className={styles.primary} disabled={busy}>
          {busy ? '正在收藏…' : '收藏并加入复习'}
        </button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
