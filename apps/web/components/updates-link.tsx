import styles from './updates-link.module.css';

export function UpdatesLink() {
  // A normal link deliberately avoids route prefetching on the learning page.
  return (
    <a className={styles.link} href="/updates">
      更新记录
    </a>
  );
}
