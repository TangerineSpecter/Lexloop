import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';
import { TtsAudioStore } from '../src/modules/tts/tts-audio-store';

const roots: string[] = [];

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexloop-tts-store-'));
  roots.push(root);
  return new TtsAudioStore({ get: () => root } as unknown as ConfigService);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TtsAudioStore', () => {
  it('writes atomically under a private directory and reads only generated object names', async () => {
    const store = await storeFixture();
    const bytes = Buffer.alloc(128, 0x53);
    const name = await store.write(bytes);

    expect(name).toMatch(/^[a-f0-9]{32}\.mp3$/);
    expect(await store.exists(name)).toBe(true);
    expect(await store.read(name)).toEqual(bytes);
    if (process.platform !== 'win32') {
      const directory = await stat(roots.at(-1)!);
      const file = await stat(join(roots.at(-1)!, name));
      expect(directory.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o600);
    }
    await expect(store.read('../outside.mp3')).rejects.toThrow('Invalid TTS object name');
  });

  it('treats a missing cache object as rebuildable and removes it safely', async () => {
    const store = await storeFixture();
    const name = await store.write(Buffer.alloc(128, 0x49));
    await store.remove(name);
    expect(await store.exists(name)).toBe(false);
    expect(await store.read(name)).toBeNull();
    await store.remove(name);
  });

  it('scans only old generated audio and temporary files in bounded safe names', async () => {
    const store = await storeFixture();
    const oldAudio = await store.write(Buffer.alloc(128, 0x6a));
    const recentAudio = await store.write(Buffer.alloc(128, 0x6b));
    const oldTemporary = `${'b'.repeat(32)}.mp3.${'c'.repeat(32)}.tmp`;
    const unrelated = 'keep-this-file.txt';
    await writeFile(join(roots.at(-1)!, oldTemporary), 'partial');
    await writeFile(join(roots.at(-1)!, unrelated), 'unrelated');
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(join(roots.at(-1)!, oldAudio), oldTime, oldTime);
    await utimes(join(roots.at(-1)!, oldTemporary), oldTime, oldTime);

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const firstBatch = await store.takeOldObjectCandidates(cutoff);
    expect(firstBatch).toEqual(expect.arrayContaining([oldAudio, oldTemporary]));
    expect(firstBatch).not.toContain(recentAudio);
    expect(firstBatch).not.toContain(unrelated);

    await store.removeOldCandidate(oldAudio);
    await store.removeOldCandidate(oldTemporary);
    await expect(stat(join(roots.at(-1)!, oldAudio))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(roots.at(-1)!, oldTemporary))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.exists(recentAudio)).toBe(true);
    await expect(store.removeOldCandidate('../outside.mp3')).rejects.toThrow(
      'Invalid TTS cleanup object name',
    );
  });
});
