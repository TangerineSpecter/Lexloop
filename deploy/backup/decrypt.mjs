#!/usr/bin/env node
// Standalone recovery utility; no application dependencies or original server required.
import { createDecipheriv, scryptSync } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  openSync,
  closeSync,
  readSync,
  statSync,
  renameSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export async function decryptBackup(source, target, passphrase) {
  if (existsSync(target) || existsSync(`${target}.partial`))
    throw new Error('输出文件已存在，请选择新的文件名');
  const size = statSync(source).size;
  if (size < 52) throw new Error('备份文件不完整');
  const fd = openSync(source, 'r');
  const header = Buffer.alloc(36);
  const tag = Buffer.alloc(16);
  try {
    readSync(fd, header, 0, 36, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  if (header.subarray(0, 8).toString() !== 'LXBACK01') throw new Error('不支持的备份格式');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    scryptSync(passphrase, header.subarray(8, 24), 32),
    header.subarray(24, 36),
  );
  cipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(source, { start: 36, end: size - 17 }),
      cipher,
      createWriteStream(`${target}.partial`, { flags: 'wx', mode: 0o600 }),
    );
    renameSync(`${target}.partial`, target);
  } catch (error) {
    rmSync(`${target}.partial`, { force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) {
    console.error(
      '用法：node deploy/backup/decrypt.mjs 备份.lxbackup 输出.tar.gz（从标准输入读取口令）',
    );
    process.exitCode = 1;
  } else {
    try {
      const passphrase = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
      await decryptBackup(source, target, passphrase);
      console.log('备份已解密并通过完整性校验。请在安全目录解压并按部署文档恢复。');
    } catch {
      console.error('解密失败：请检查文件、口令和输出目录；未生成可用的恢复文件。');
      process.exitCode = 1;
    }
  }
}
