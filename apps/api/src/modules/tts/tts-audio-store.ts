import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Dir } from 'node:fs';
import { chmod, mkdir, opendir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const OBJECT_NAME_PATTERN = /^[a-f0-9]{32}\.mp3$/;
const TEMP_OBJECT_NAME_PATTERN = /^[a-f0-9]{32}\.mp3\.[a-f0-9]{32}\.tmp$/;
const MAX_AUDIO_FILE_BYTES = 12 * 1024 * 1024;
const MAX_ORPHAN_SCAN_ENTRIES = 2_000;

@Injectable()
export class TtsAudioStore {
  private readonly root: string;
  private sweepDirectory: Dir | null = null;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('LEXLOOP_TTS_AUDIO_DIR') ?? 'var/tts-audio');
  }

  async write(bytes: Buffer): Promise<string> {
    const objectName = `${randomUUID().replace(/-/g, '')}.mp3`;
    const destination = this.pathFor(objectName);
    const temporary = `${destination}.${randomUUID().replace(/-/g, '')}.tmp`;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(dirname(destination), 0o700);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      return objectName;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(objectName: string): Promise<Buffer | null> {
    const path = this.pathFor(objectName);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_AUDIO_FILE_BYTES) return null;
      return await readFile(path);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async exists(objectName: string): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(objectName));
      return info.isFile() && info.size > 0 && info.size <= MAX_AUDIO_FILE_BYTES;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  async remove(objectName: string) {
    await rm(this.pathFor(objectName), { force: true });
  }

  async takeOldObjectCandidates(cutoff: Date) {
    if (!this.sweepDirectory) {
      try {
        this.sweepDirectory = await opendir(this.root);
      } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
      }
    }

    const candidates: string[] = [];
    try {
      for (let scanned = 0; scanned < MAX_ORPHAN_SCAN_ENTRIES; scanned += 1) {
        const entry = await this.sweepDirectory.read();
        if (!entry) {
          await this.closeSweepDirectory();
          break;
        }
        if (
          !entry.isFile() ||
          (!OBJECT_NAME_PATTERN.test(entry.name) && !TEMP_OBJECT_NAME_PATTERN.test(entry.name))
        ) {
          continue;
        }
        try {
          const info = await stat(resolve(this.root, entry.name));
          if (info.isFile() && info.mtime < cutoff) candidates.push(entry.name);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      return candidates;
    } catch (error) {
      await this.closeSweepDirectory().catch(() => undefined);
      throw error;
    }
  }

  async removeOldCandidate(objectName: string) {
    if (!OBJECT_NAME_PATTERN.test(objectName) && !TEMP_OBJECT_NAME_PATTERN.test(objectName)) {
      throw new Error('Invalid TTS cleanup object name');
    }
    await rm(resolve(this.root, objectName), { force: true });
  }

  async closeSweepDirectory() {
    const directory = this.sweepDirectory;
    this.sweepDirectory = null;
    await directory?.close();
  }

  private pathFor(objectName: string) {
    if (!OBJECT_NAME_PATTERN.test(objectName)) throw new Error('Invalid TTS object name');
    return resolve(this.root, objectName);
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
