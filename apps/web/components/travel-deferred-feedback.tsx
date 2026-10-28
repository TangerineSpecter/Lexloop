import { Sparkles } from 'lucide-react';
import styles from './travel-deferred-feedback.module.css';

export type DeferredLanguageFeedback = {
  type: string;
  original: string;
  natural: string;
  explanation: string;
};

const typeLabel: Record<string, string> = {
  grammar: '语法',
  collocation: '搭配',
  naturalness: '自然表达',
  politeness: '礼貌语气',
};

export function TravelDeferredFeedback({ items }: { items: DeferredLanguageFeedback[] }) {
  if (!items.length) return null;

  return (
    <details className={`${styles.feedback} travel-deferred-feedback`}>
      <summary>
        <Sparkles size={14} aria-hidden="true" />
        本轮补充语言提示 · {items.length} 条（选读）
      </summary>
      <div className={styles.list} data-feedback-list>
        {items.map((item, index) => (
          <article className={styles.item} key={`${item.type}-${index}`}>
            <small>{typeLabel[item.type] ?? '表达建议'}</small>
            <p className={styles.original}>
              <span>你的说法</span>
              {item.original}
            </p>
            <p className={styles.natural}>
              <span>可以这样说</span>
              <strong>{item.natural}</strong>
            </p>
            <p className={styles.explanation}>{item.explanation}</p>
          </article>
        ))}
      </div>
    </details>
  );
}
