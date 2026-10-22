import { notFound } from 'next/navigation';
import { RELEASES, RELEASES_PER_PAGE, releasePageCount } from './releases';
import styles from './updates.module.css';

export function ReleaseHistory({ page = 1 }: { page?: number }) {
  if (!Number.isSafeInteger(page) || page < 1 || page > releasePageCount) notFound();
  const releases = RELEASES.slice((page - 1) * RELEASES_PER_PAGE, page * RELEASES_PER_PAGE);
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="页面导航">
        <a href="/" className={styles.brand}>
          词环 <small>LEXLOOP</small>
        </a>
        <a href="/">返回首页 →</a>
      </nav>
      <div className={styles.content}>
        <header className={styles.heading}>
          <p>WHAT’S NEW</p>
          <h1>更新记录</h1>
          <span>新功能在哪里，怎么用，一眼看明白。</span>
        </header>
        {releases.map((release) => (
          <section
            className={styles.release}
            key={release.version}
            aria-label={`v${release.version} 更新`}
          >
            <header className={styles.releaseHeading}>
              <h2>v{release.version}</h2>
              {release.version === RELEASES[0].version && <span>最新版本</span>}
              {release.date && <time dateTime={release.date}>{release.date}</time>}
            </header>
            <ul className={styles.items}>
              {release.items.map((item) => (
                <li key={item.title}>
                  <h3>{item.title}</h3>
                  <p className={styles.entry}>入口 · {item.entry}</p>
                  <p>{item.usage}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {releasePageCount > 1 && (
          <nav className={styles.pagination} aria-label="更新记录分页">
            {page > 1 ? (
              <a href={page === 2 ? '/updates' : `/updates/${page - 1}`}>← 较新版本</a>
            ) : (
              <span />
            )}
            <span>
              第 {page} / {releasePageCount} 页
            </span>
            {page < releasePageCount ? <a href={`/updates/${page + 1}`}>更早版本 →</a> : <span />}
          </nav>
        )}
      </div>
    </main>
  );
}
