'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './micro-stories.module.css';

export type StoryCatalogEntry = {
  key: string;
  series: string;
  part: number;
  level: 'A1' | 'A2' | 'B1';
  completed: boolean;
};

const LEVELS = ['全部', 'A1', 'A2', 'B1'] as const;
type LevelFilter = (typeof LEVELS)[number];

export function MicroStorySelectionDialog({
  open,
  catalog,
  currentKey,
  disabled,
  busy,
  onClose,
  onSelect,
}: {
  open: boolean;
  catalog: StoryCatalogEntry[];
  currentKey: string;
  disabled: boolean;
  busy: boolean;
  onClose: () => void;
  onSelect: (key: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [level, setLevel] = useState<LevelFilter>('全部');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setLevel('全部');
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const stories = catalog.filter(
    (story) => !story.completed && (level === '全部' || story.level === level),
  );

  return (
    <dialog
      ref={dialogRef}
      className={styles.selectionDialog}
      aria-labelledby="micro-story-selection-title"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className={styles.selectionDialogContent}>
        <header className={styles.selectionDialogHeader}>
          <div>
            <p className={styles.selectionEyebrow}>MICRO STORIES</p>
            <h2 id="micro-story-selection-title">选择一段未完成的故事</h2>
          </div>
          <button
            type="button"
            className={styles.secondary}
            onClick={onClose}
            disabled={busy}
            aria-label="关闭故事选择"
          >
            关闭
          </button>
        </header>
        <p className={styles.selectionNote}>
          默认仍按故事顺序继续；这些分组只帮助浏览，不代表正式英语等级测评。
        </p>
        {disabled && (
          <p className={styles.selectionNotice} role="status">
            当前故事已有理解内容。完成本段后再选择其他故事。
          </p>
        )}
        <div className={styles.levelFilters} role="group" aria-label="按练习分组筛选">
          {LEVELS.map((option) => (
            <button
              key={option}
              data-level={option}
              type="button"
              className={level === option ? styles.levelFilterActive : styles.levelFilter}
              aria-pressed={level === option}
              onClick={() => setLevel(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <div className={styles.selectionList}>
          {stories.length ? (
            stories.map((story) => (
              <button
                key={story.key}
                data-story-key={story.key}
                type="button"
                className={styles.storyOption}
                disabled={disabled || busy || story.key === currentKey}
                aria-current={story.key === currentKey ? 'true' : undefined}
                onClick={() => onSelect(story.key)}
              >
                <span>
                  <strong>{story.series}</strong>
                  <small>第 {story.part} 小段</small>
                </span>
                <span className={styles.storyLevel}>{story.level}</span>
              </button>
            ))
          ) : (
            <p className={styles.selectionEmpty} role="status">
              这个分组暂时没有未完成故事。
            </p>
          )}
        </div>
        {busy && (
          <p className={styles.selectionNote} role="status">
            正在切换故事…
          </p>
        )}
        <p className={styles.selectionFooter}>
          已完成的故事会留在“重读已完成故事”中，不会影响学习进度。
        </p>
      </div>
    </dialog>
  );
}
