'use client';
import { useEffect, useRef, useState } from 'react';
import type { LabLessonView } from '@lexloop/types';
import {
  clearLearningLabDraft,
  clearLearningLabDraftIfMatches,
  readLearningLabDraft,
  saveLearningLabDraft,
} from '../../lib/learning-lab-drafts';
import styles from './lab.module.css';

export function LessonQuiz({
  lesson,
  userId,
  busy,
  onSubmit,
}: {
  lesson: LabLessonView;
  userId: string;
  busy: boolean;
  onSubmit: (answers: number[]) => void;
}) {
  const questions = lesson.content?.questions ?? [];
  const [draft, setDraft] = useState<number[]>(() => questions.map(() => -1));
  const [draftSnapshotId, setDraftSnapshotId] = useState<string | null>(null);
  const [loadedDraftIdentity, setLoadedDraftIdentity] = useState('');
  const [draftRestored, setDraftRestored] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const submitted = Boolean(lesson.submittedAt);
  const answers = lesson.answers ?? draft;
  const questionSignature = JSON.stringify(
    questions.map(({ id, prompt, options }) => [id, prompt, options]),
  );
  const draftIdentity = JSON.stringify([userId, lesson.id, questionSignature, submitted]);
  const draftReady = loadedDraftIdentity === draftIdentity;
  const hasSelection = draft.some((answer) => answer >= 0);
  const submittedSnapshot = useRef<{ snapshotId: string | null } | null>(null);

  useEffect(() => {
    if (submitted) {
      const submittedAnswers = lesson.answers ?? questions.map(() => -1);
      clearLearningLabDraftIfMatches(
        userId,
        lesson.id,
        questions,
        submittedAnswers,
        submittedSnapshot.current?.snapshotId ?? null,
      );
      submittedSnapshot.current = null;
      setDraft(submittedAnswers);
      setDraftSnapshotId(null);
      setDraftRestored(false);
      setStorageAvailable(true);
      setLoadedDraftIdentity(draftIdentity);
      return;
    }
    const snapshot = readLearningLabDraft(userId, lesson.id, questions);
    setDraft(snapshot.answers);
    setDraftSnapshotId(snapshot.snapshotId);
    setDraftRestored(snapshot.restored);
    setStorageAvailable(snapshot.storageAvailable);
    setLoadedDraftIdentity(draftIdentity);
  }, [draftIdentity]);

  function updateAnswer(index: number, choice: number) {
    const next = [...draft];
    next[index] = choice;
    setDraft(next);
    setDraftRestored(false);
    const saved = saveLearningLabDraft(userId, lesson.id, questions, next);
    setDraftSnapshotId(saved.snapshotId);
    setStorageAvailable(saved.storageAvailable);
  }

  function discardDraft() {
    setStorageAvailable(clearLearningLabDraft(userId, lesson.id));
    setDraft(questions.map(() => -1));
    setDraftSnapshotId(null);
    setDraftRestored(false);
  }

  return (
    <section
      className={styles.card}
      aria-label={lesson.kind === 'READING' ? '读后小测' : '语法练习'}
    >
      <h3>{lesson.kind === 'READING' ? '读后小测' : '换个语境再试一次'}</h3>
      <p className={styles.meta}>完成后交卷，查看答案与解析。每份练习保存一次成绩。</p>
      {!submitted && (
        <>
          <p className={styles.meta}>
            未交卷的选择只保存在此设备，用于恢复这份练习；交卷成功后清除，不同步到其他设备。
          </p>
          {!draftReady ? (
            <p className={styles.meta} role="status">
              正在检查本机练习草稿…
            </p>
          ) : draftRestored ? (
            <p className={styles.meta} role="status">
              已恢复这份练习尚未提交的选择。
            </p>
          ) : null}
          {draftReady && !storageAvailable && (
            <p className={styles.notice} role="status">
              浏览器本机存储不可用；仍可继续作答，但刷新后可能无法恢复选择。
            </p>
          )}
          {draftReady && hasSelection && (
            <button
              type="button"
              className={`${styles.button} quiz-draft-discard`}
              onClick={discardDraft}
            >
              清除本机草稿与选择
            </button>
          )}
        </>
      )}
      {submitted && (
        <p className={styles.notice} role="status">
          本次得分：<strong>{lesson.score} / 100</strong> · 答对{' '}
          {questions.filter((question, index) => question.correctIndex === answers[index]).length}/
          {questions.length} 题
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submittedSnapshot.current = {
            snapshotId: draftSnapshotId,
          };
          onSubmit(draft);
        }}
      >
        {questions.map((question, index) => (
          <fieldset
            className={styles.question}
            key={question.id}
            disabled={submitted || busy || !draftReady}
          >
            <legend>
              {index + 1}. {question.prompt}
            </legend>
            <div className={styles.options}>
              {question.options.map((option, choice) => (
                <label
                  key={choice}
                  className={
                    submitted && choice === question.correctIndex
                      ? styles.correct
                      : submitted && choice === answers[index]
                        ? styles.wrong
                        : undefined
                  }
                >
                  <input
                    type="radio"
                    name={`${lesson.id}-${question.id}`}
                    value={choice}
                    checked={answers[index] === choice}
                    onChange={() => updateAnswer(index, choice)}
                  />
                  <span>
                    {option}
                    {submitted && choice === question.correctIndex ? ' ✓ 正确答案' : ''}
                  </span>
                </label>
              ))}
            </div>
            {submitted && (
              <p>
                {answers[index] === question.correctIndex ? '答对了。' : '这一题需要再巩固。'}
                {question.explanation}
              </p>
            )}
          </fieldset>
        ))}
        {!submitted && (
          <button
            className={styles.primary}
            disabled={
              !draftReady ||
              busy ||
              draft.length !== questions.length ||
              draft.some((value) => value < 0)
            }
          >
            {busy ? '正在交卷…' : '交卷并查看解析'}
          </button>
        )}
        {submitted && (
          <p className={styles.meta}>
            建议隔一段时间重新生成变式练习。得分记录练习表现，不自动标记词汇或语法已掌握。
          </p>
        )}
      </form>
    </section>
  );
}
