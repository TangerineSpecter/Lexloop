import type { DailyOutput, OutputFeedback } from '@lexloop/types';
import styles from './practice.module.css';

export function FeedbackCard({
  feedback,
  daily,
  onRewrite,
}: {
  feedback: OutputFeedback;
  daily: DailyOutput;
  onRewrite?: () => void;
}) {
  return (
    <section className={styles.card}>
      <header className={styles.feedbackHead}>
        <div>
          <small>YOUR FEEDBACK</small>
          <h3>这次表达</h3>
        </div>
        <strong>
          {feedback.score}
          <small>/100</small>
        </strong>
      </header>
      <div className={styles.scoreRow}>
        <span>语法 {feedback.grammarScore}</span>
        <span>连贯 {feedback.coherenceScore}</span>
        <span>
          用词 {feedback.words.filter((word) => word.correct).length}/{feedback.words.length}
        </span>
      </div>
      <ul className={styles.wordFeedback}>
        {feedback.words.map((word) => (
          <li key={word.bookWordId}>
            <strong>
              {word.correct ? '✓' : '↺'}{' '}
              {daily.targets.find((target) => target.bookWordId === word.bookWordId)?.word}
            </strong>
            <span>{word.feedback}</span>
          </li>
        ))}
      </ul>
      {feedback.comments.map((comment, index) => (
        <p key={index}>{comment}</p>
      ))}
      <h4>参考表达</h4>
      <p className={styles.example}>{feedback.correctedText}</p>
      {onRewrite && (
        <button className={styles.secondary} onClick={onRewrite}>
          回到原文重写 →
        </button>
      )}
    </section>
  );
}
