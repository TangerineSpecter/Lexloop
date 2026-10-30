'use client';
import { useEffect, useState } from 'react';
import type { GrammarEvidence, LabKind } from '@lexloop/types';
import { request, userFacingError, type Session } from '../../lib/api';
import { useLabLessons } from './use-lab-lessons';
import { LabLesson } from './lab-lesson';
import styles from './lab.module.css';
import { StyledSelect } from '../styled-select';

export function LearningPanel({
  session,
  kind,
  selected,
  onChooseWords,
}: {
  session: Session;
  kind: LabKind;
  selected: string[];
  onChooseWords: () => void;
}) {
  const lab = useLabLessons(session, kind);
  const [level, setLevel] = useState('B1');
  const [evidence, setEvidence] = useState<GrammarEvidence[] | null>(null);
  const [evidenceError, setEvidenceError] = useState('');
  const [evidenceRound, setEvidenceRound] = useState(0);
  useEffect(() => {
    if (kind !== 'GRAMMAR') return;
    let active = true;
    setEvidenceError('');
    request<GrammarEvidence[]>('/learning-lab/grammar-evidence', {}, session.accessToken)
      .then((value) => {
        if (active) setEvidence(value);
      })
      .catch((err) => {
        if (active) setEvidenceError(userFacingError(err));
      });
    return () => {
      active = false;
    };
  }, [session.accessToken, kind, evidenceRound, lab.lesson?.submittedAt]);
  const generating = lab.lesson?.status === 'QUEUED' || lab.lesson?.status === 'PROCESSING';
  return (
    <section>
      <header className={styles.head}>
        <div>
          <small className={styles.eyebrow}>
            {kind === 'READING' ? 'READ YOUR WORDS' : 'PRACTICE WITH EVIDENCE'}
          </small>
          <h2>{kind === 'READING' ? '在短文里，再遇见生词' : '从表达中的问题，练起'}</h2>
        </div>
        <span>
          {kind === 'READING'
            ? `已选 ${selected.length}/6 个词`
            : evidence
              ? `最近 30 天 · ${evidence.length} 条批改线索`
              : '正在读取学习线索…'}
        </span>
        <div className={styles.actions}>
          {kind === 'READING' && (
            <button className={styles.button} onClick={onChooseWords}>
              选择生词
            </button>
          )}
          <button
            className={styles.primary}
            disabled={
              lab.busy ||
              generating ||
              (kind === 'READING' && !selected.length) ||
              (kind === 'GRAMMAR' && !evidence)
            }
            onClick={() => void lab.create(kind === 'READING' ? selected : [], level)}
          >
            {lab.busy
              ? '处理中…'
              : generating
                ? '正在生成…'
                : kind === 'READING'
                  ? '生成精读短文'
                  : evidence?.length
                    ? '分析并生成语法专项'
                    : '开始基础自测'}
          </button>
        </div>
      </header>
      {kind === 'READING' ? (
        <>
          <p className={styles.meta}>
            选择 1–6
            个收藏词生成短文，逐句查看译文和讲解，再完成读后小测。生成使用首页已选择的阅读材料模型。
          </p>
          <label className={styles.levelControl}>
            阅读难度
            <StyledSelect
              value={level}
              label="阅读难度"
              onChange={setLevel}
              options={[
                { value: 'A2', label: 'A2 · 简单日常' },
                { value: 'B1', label: 'B1 · 日常进阶' },
                { value: 'B2', label: 'B2 · 丰富表达' },
              ]}
            />
          </label>
          {!selected.length && !lab.lesson && (
            <div className={styles.empty}>
              <h3>先选几个想重逢的词</h3>
              <p>在生词本中勾选词汇，再来生成你的精读短文。</p>
              <button className={styles.button} onClick={onChooseWords}>
                前往生词本
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className={styles.meta}>
            结合近期每日输出、旅行场景纠错和语法错题，整理讲解与变式题。生成使用已选择的模型；没有批改线索时提供不依赖
            AI 的基础自测。
          </p>
          {evidenceError && (
            <p role="alert" className={styles.notice}>
              {evidenceError}
              <button
                className={styles.button}
                onClick={() => setEvidenceRound((value) => value + 1)}
              >
                重新读取线索
              </button>
            </p>
          )}
          {evidence && !evidence.length && (
            <p className={styles.notice}>
              目前没有足够的批改线索，先用基础自测找找容易卡住的地方。也可以先完成一次
              <a href="/dashboard/practice?tab=output">每日输出</a>。
            </p>
          )}
        </>
      )}
      {lab.error && (
        <p className={styles.notice} role="alert">
          {lab.error}
          <button className={styles.button} onClick={lab.resume}>
            刷新记录
          </button>
        </p>
      )}
      {lab.lesson && (
        <LabLesson
          session={session}
          lesson={lab.lesson}
          busy={lab.busy}
          pollPaused={lab.pollPaused}
          onResume={lab.resume}
          onSubmit={(answers) => void lab.submit(answers)}
        />
      )}
      <section className={styles.history} aria-label="学习历史">
        <header className={styles.head}>
          <h2>{kind === 'READING' ? '精读记录' : '语法专项记录'}</h2>
          <span>离开后也能继续</span>
          <button className={styles.button} onClick={lab.resume}>
            刷新
          </button>
        </header>
        {lab.historyError && (
          <p className={styles.notice} role="alert">
            {lab.historyError}
            <button className={styles.button} onClick={lab.reloadHistory}>
              重试读取历史
            </button>
          </p>
        )}
        {lab.historyLoading ? (
          <p role="status">正在读取历史…</p>
        ) : lab.historyError ? (
          <p className={styles.meta} role="status">
            暂时无法确认当前页的练习记录；重试成功后再判断是否有记录。
          </p>
        ) : !lab.history?.items.length ? (
          <p className={styles.meta}>第一份练习会保存在这里。</p>
        ) : (
          lab.history.items.map((item) => (
            <button
              key={item.id}
              className={styles.button}
              aria-current={item.id === lab.lesson?.id ? 'true' : undefined}
              onClick={() => lab.open(item)}
            >
              {new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ·{' '}
              {item.content?.title ?? (item.status === 'FAILED' ? '生成失败' : '正在生成')} ·{' '}
              {item.submittedAt
                ? `${item.score} 分`
                : item.status === 'READY'
                  ? '待完成'
                  : item.status === 'FAILED'
                    ? '可重新生成'
                    : '处理中'}
            </button>
          ))
        )}
        <nav className={styles.pager} aria-label="练习记录分页">
          <button
            className={styles.button}
            disabled={lab.historyLoading || lab.page <= 1}
            onClick={() => lab.setPage(lab.page - 1)}
          >
            上一页
          </button>
          <span>第 {lab.page} 页</span>
          <button
            className={styles.button}
            disabled={lab.historyLoading || Boolean(lab.historyError) || !lab.history?.hasMore}
            onClick={() => lab.setPage(lab.page + 1)}
          >
            下一页
          </button>
        </nav>
      </section>
    </section>
  );
}
