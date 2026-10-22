'use client';
import { useState } from 'react';
import type { LabLessonView } from '@lexloop/types';
import styles from './lab.module.css';

export function LessonQuiz({
  lesson,
  busy,
  onSubmit,
}: {
  lesson: LabLessonView;
  busy: boolean;
  onSubmit: (answers: number[]) => void;
}) {
  const questions = lesson.content?.questions ?? [];
  const [draft, setDraft] = useState<number[]>(() => questions.map(() => -1));
  const submitted = Boolean(lesson.submittedAt);
  const answers = lesson.answers ?? draft;
  return (
    <section
      className={styles.card}
      aria-label={lesson.kind === 'READING' ? '读后小测' : '语法练习'}
    >
      <h3>{lesson.kind === 'READING' ? '读后小测' : '换个语境再试一次'}</h3>
      <p className={styles.meta}>完成后交卷，查看答案与解析。每份练习保存一次成绩。</p>
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
          onSubmit(draft);
        }}
      >
        {questions.map((question, index) => (
          <fieldset className={styles.question} key={question.id} disabled={submitted || busy}>
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
                    onChange={() =>
                      setDraft((current) => {
                        const next = [...current];
                        next[index] = choice;
                        return next;
                      })
                    }
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
            disabled={busy || draft.length !== questions.length || draft.some((value) => value < 0)}
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
