'use client';

import type { ReadingWordUseFeedback } from '@lexloop/types';
import { useState, type FormEvent } from 'react';
import type { Session } from '../lib/api';
import { useFormativeFeedbackRequest } from './use-formative-feedback-request';

export type ReadingWordUseTarget = {
  id?: string;
  word: string;
  meaning: string;
};

const wordKey = (word: ReadingWordUseTarget) => word.id ?? word.word;

export function ReadingWordUsePractice({
  id,
  open,
  session,
  words,
}: {
  id: string;
  open: boolean;
  session: Session;
  words: ReadingWordUseTarget[];
}) {
  const [selectedWordKey, setSelectedWordKey] = useState(words[0] ? wordKey(words[0]) : '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedbackByWord, setFeedbackByWord] = useState<
    Record<
      string,
      {
        answer: string;
        word: string;
        meaning: string;
        value: ReadingWordUseFeedback;
      }
    >
  >({});
  const [error, setError] = useState<{
    wordKey: string;
    answer: string;
    message: string;
  } | null>(null);
  const { submitting, submit: submitFeedback } = useFormativeFeedbackRequest({ open });

  const selectedWord = words.find((word) => wordKey(word) === selectedWordKey);
  const answer = drafts[selectedWordKey] ?? '';
  const lastSubmission = feedbackByWord[selectedWordKey] ?? null;
  const visibleFeedback = lastSubmission?.value ?? null;
  const visibleError =
    error?.wordKey === selectedWordKey && error.answer === answer ? error.message : '';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const learnerSentence = answer.trim();
    if (!selectedWord || !learnerSentence || submitting) return;
    const submittedWordKey = selectedWordKey;
    const submittedAnswer = learnerSentence;
    const submittedWord = selectedWord;
    setError(null);
    const result = await submitFeedback<ReadingWordUseFeedback>(
      '/ai/reading-word-use-feedback',
      {
        word: submittedWord.word,
        meaning: submittedWord.meaning,
        learnerSentence: submittedAnswer,
      },
      session.accessToken,
      '造句建议暂时不可用。',
    );
    if (result.status === 'success') {
      setFeedbackByWord((current) => ({
        ...current,
        [submittedWordKey]: {
          answer: submittedAnswer,
          word: submittedWord.word,
          meaning: submittedWord.meaning,
          value: result.feedback,
        },
      }));
    }
    if (result.status === 'error') {
      setError({ wordKey: submittedWordKey, answer: submittedAnswer, message: result.message });
    }
  };

  return (
    <section id={id} className="sentence-word-use-panel" aria-label="使用本组词造句" hidden={!open}>
      <h3>换到自己的语境里用一次</h3>
      <p className="sentence-rewrite-note">
        先选一个本组词，写一句你自己的英文。只有点击提交后，目标词、词义和句子才会发送给当前选择的模型；不会保存、计分或调整复习计划。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor={`${id}-word`}>本组目标词</label>
        <select
          id={`${id}-word`}
          value={selectedWordKey}
          disabled={submitting}
          onChange={(event) => setSelectedWordKey(event.target.value)}
        >
          {words.map((word) => (
            <option key={wordKey(word)} value={wordKey(word)}>
              {word.word}
            </option>
          ))}
        </select>
        {!selectedWord && (
          <p className="sentence-rewrite-error" role="status">
            当前学习组没有可用的目标词，暂时无法造句。
          </p>
        )}
        {selectedWord && (
          <details className="word-use-meaning-hint">
            <summary id={`${id}-meaning-hint`}>需要时查看词义提示</summary>
            <small>{selectedWord.meaning}</small>
          </details>
        )}
        <label htmlFor={`${id}-answer`}>你的英文句子</label>
        <textarea
          id={`${id}-answer`}
          aria-label="使用目标词造句"
          maxLength={1200}
          value={answer}
          disabled={submitting}
          onChange={(event) =>
            setDrafts((current) => ({ ...current, [selectedWordKey]: event.target.value }))
          }
          placeholder="写一句与你自己的生活或想法有关的英文。"
        />
        <div className="sentence-rewrite-actions">
          <button type="submit" disabled={!selectedWord || !answer.trim() || submitting}>
            {submitting ? '正在整理建议…' : '提交并查看建议'}
          </button>
          <span>{answer.length}/1200</span>
        </div>
      </form>
      {visibleError && (
        <p className="sentence-rewrite-error" role="alert">
          {visibleError} {visibleFeedback ? '上次成功的反馈仍保留。' : ''}草稿保留，可检查后重试。
        </p>
      )}
      {submitting && (
        <p className="word-use-loading" role="status" aria-live="polite">
          {visibleFeedback ? '正在更新建议…' : '正在整理建议…'}
        </p>
      )}
      {visibleFeedback && (
        <section className="sentence-rewrite-feedback" aria-label="造句参考反馈" aria-live="polite">
          <div className="sentence-feedback-submission">
            <strong>这条建议对应的已提交内容</strong>
            <p>
              <b lang="en">{lastSubmission?.word}</b>
              <span> · {lastSubmission?.meaning}</span>
            </p>
            <blockquote lang="en">{lastSubmission?.answer}</blockquote>
          </div>
          <h4>造句参考反馈</h4>
          <dl>
            <div>
              <dt>词语使用</dt>
              <dd>{visibleFeedback.wordUse}</dd>
            </div>
            <div>
              <dt>意思</dt>
              <dd>{visibleFeedback.meaning}</dd>
            </div>
            <div>
              <dt>语法</dt>
              <dd>{visibleFeedback.grammar}</dd>
            </div>
            <div>
              <dt>自然度</dt>
              <dd>{visibleFeedback.naturalness}</dd>
            </div>
            {visibleFeedback.alternative && (
              <div>
                <dt>参考表达</dt>
                <dd lang="en">{visibleFeedback.alternative}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </section>
  );
}
