import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Lexloop · 词环',
  description: '循环往复，持续积累。',
  applicationName: 'Lexloop',
};
export const viewport: Viewport = { themeColor: '#16352a' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><Providers>{children}</Providers></body></html>;
}
