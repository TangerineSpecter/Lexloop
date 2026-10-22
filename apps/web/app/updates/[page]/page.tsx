import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReleaseHistory } from '../release-history';
import { releasePageCount } from '../releases';

export const metadata: Metadata = { title: '历史更新 · 词环' };
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return Array.from({ length: releasePageCount }, (_, index) => ({ page: String(index + 1) }));
}

export default async function OlderUpdatesPage({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!/^[1-9]\d*$/.test(page)) notFound();
  return <ReleaseHistory page={Number(page)} />;
}
