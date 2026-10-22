import type { Metadata } from 'next';
import { ReleaseHistory } from './release-history';

export const metadata: Metadata = { title: '更新记录 · 词环' };
export const dynamic = 'force-static';

export default function UpdatesPage() {
  return <ReleaseHistory />;
}
