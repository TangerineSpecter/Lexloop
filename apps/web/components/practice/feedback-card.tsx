import type { DailyOutput, OutputFeedback } from '@lexloop/types';
import { findTargetExcerpt } from '../../lib/output-word-evidence';
import styles from './practice.module.css';

export function FeedbackCard({
  feedback,
  daily,
  originalAnswer,
  onRewrite,
}: {
  feedback: OutputFeedback;
  daily: DailyOutput;
  originalAnswer: string;
  onRewrite?: () => void;
}) {
  return (
    <section className={styles.card}>
      <header className={styles.feedbackHead}>
        <div>
          <small>YOUR FEEDBACK</small>
          <h3>这次表达</h3>
        </div>
        <div className={styles.scoreSummary} role="group" aria-label="本次练习参考分">
          <span>练习参考分 · 不代表英语等级</span>
          <strong>
            {feedback.score}
            <small>/100</small>
          </strong>
        </div>
      </header>
      <div className={styles.scoreRow}>
        <span>语法 {feedback.grammarScore}</span>
        <span>连贯 {feedback.coherenceScore}</span>
        <span>
          用词 {feedback.words.filter((word) => word.correct).length}/{feedback.words.length}
        </span>
      </div>
      <details className={styles.scoreExplanation} aria-label="评分构成">
        <summary>分数怎么算？</summary>
        <p>
          目标词使用与用法占 60%（系统核对完整拼写，模型评估语境与搭配），语法占 25%，连贯性占
          15%（由所选模型评估）。这只是本次练习的参考，不是英语等级或正式考试成绩。
        </p>
      </details>
      <ul className={styles.wordFeedback}>
        {feedback.words.map((word) => {
          const target = daily.targets.find((item) => item.bookWordId === word.bookWordId);
          const excerpt = target ? findTargetExcerpt(originalAnswer, target.word) : null;
          return (
            <li key={word.bookWordId} data-target-word={target?.word}>
              <strong>
                {word.correct ? '✓' : '↺'} {target?.word}
              </strong>
              <span>{word.feedback}</span>
              {target && (
                <div className={styles.wordEvidence}>
                  <small>首个完整拼写片段</small>
                  {excerpt ? (
                    <p lang="en" className={styles.answerText}>
                      {excerpt.before}
                      <mark>{excerpt.match}</mark>
                      {excerpt.after}
                    </p>
                  ) : (
                    <p>未找到完全一致的拼写；词形变化或标点写法可能未匹配。</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {feedback.comments.map((comment, index) => (
        <p key={index}>{comment}</p>
      ))}
      <section aria-label="表达对照">
        <h4>回看这道题</h4>
        <p className={styles.historyPrompt}>{daily.prompt}</p>
        <p className={styles.hint}>
          目标词或短语：{daily.targets.map((target) => target.word).join(' · ')}
        </p>
        <div className={styles.comparison}>
          <div>
            <strong>你的原表达</strong>
            <p lang="en" className={styles.answerText}>
              {originalAnswer}
            </p>
          </div>
          <div>
            <strong>参考表达</strong>
            <p lang="en" className={styles.answerText}>
              {feedback.correctedText}
            </p>
          </div>
        </div>
      </section>
      {onRewrite && (
        <button className={styles.secondary} onClick={onRewrite}>
          回到原文重写 →
        </button>
      )}
    </section>
  );
}
