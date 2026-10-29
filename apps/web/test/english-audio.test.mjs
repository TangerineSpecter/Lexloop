import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLocalEnglishVoice } from '../lib/english-audio.ts';

test('chooses an English voice marked as a local service', () => {
  const remoteUs = { lang: 'en-US', localService: false };
  const localUk = { lang: 'en-GB', localService: true };
  const localUs = { lang: 'en-US', localService: true };

  assert.equal(findLocalEnglishVoice([remoteUs, localUk]), localUk);
  assert.equal(findLocalEnglishVoice([localUk, localUs]), localUs);
});

test('does not use remote or unclassified English voices as a fallback', () => {
  assert.equal(findLocalEnglishVoice([{ lang: 'en-US', localService: false }]), null);
  assert.equal(findLocalEnglishVoice([{ lang: 'en-US' }]), null);
  assert.equal(findLocalEnglishVoice([{ lang: 'zh-CN', localService: true }]), null);
});
