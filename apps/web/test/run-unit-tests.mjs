#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const testFiles = readdirSync(testDirectory, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith('.test.mjs') &&
      !entry.name.endsWith('.browser.test.mjs'),
  )
  .map((entry) => `test/${entry.name}`)
  .sort();

if (testFiles.length === 0) {
  console.error(`未找到 Web 单元测试：${testDirectory}`);
  process.exit(1);
}

console.log(`运行 ${testFiles.length} 个 Web 单元测试文件（浏览器测试由 standalone 入口运行）。`);

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  cwd: resolve(testDirectory, '..'),
  stdio: 'inherit',
});

if (result.error) {
  console.error(`无法启动 Web 单元测试：${result.error.message}`);
  process.exitCode = 1;
} else if (result.signal) {
  console.error(`Web 单元测试被信号 ${result.signal} 中断。`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
