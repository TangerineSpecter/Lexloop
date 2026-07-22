import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return { name: 'Lexloop 词环', short_name: '词环', description: '英语闭环学习', start_url: '/', display: 'standalone', background_color: '#f5f0e7', theme_color: '#16352a' };
}
