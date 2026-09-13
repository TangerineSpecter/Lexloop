import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const nextConfig: NextConfig = {
  // The Next.js dev-tools bubble is useful for framework debugging, but not for product UI work.
  devIndicators: false,
  output: 'standalone',
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:52101'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
