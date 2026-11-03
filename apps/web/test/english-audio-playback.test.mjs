import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimEnglishAudioPlayback,
  ownsEnglishAudioPlayback,
  releaseEnglishAudioPlayback,
} from '../lib/english-audio-playback.ts';

test('a MiniMax connection test takes shared playback ownership and stops learner speech', () => {
  const learner = Symbol('learner speech');
  const connectionTest = Symbol('connection test');
  let learnerStops = 0;
  let connectionStops = 0;

  claimEnglishAudioPlayback(learner, () => {
    learnerStops += 1;
    releaseEnglishAudioPlayback(learner);
  });
  assert.equal(ownsEnglishAudioPlayback(learner), true);

  claimEnglishAudioPlayback(connectionTest, () => {
    connectionStops += 1;
    releaseEnglishAudioPlayback(connectionTest);
  });
  assert.equal(learnerStops, 1);
  assert.equal(ownsEnglishAudioPlayback(learner), false);
  assert.equal(ownsEnglishAudioPlayback(connectionTest), true);

  claimEnglishAudioPlayback(learner, () => {
    learnerStops += 1;
    releaseEnglishAudioPlayback(learner);
  });
  assert.equal(connectionStops, 1);
  assert.equal(ownsEnglishAudioPlayback(connectionTest), false);
  assert.equal(ownsEnglishAudioPlayback(learner), true);
});

test('a stale owner cannot release a newer playback', () => {
  const oldOwner = Symbol('old learner speech');
  const currentOwner = Symbol('current connection test');
  let oldStops = 0;

  claimEnglishAudioPlayback(oldOwner, () => {
    oldStops += 1;
    releaseEnglishAudioPlayback(oldOwner);
  });
  claimEnglishAudioPlayback(currentOwner, () => undefined);
  releaseEnglishAudioPlayback(oldOwner);

  assert.equal(oldStops, 1);
  assert.equal(ownsEnglishAudioPlayback(currentOwner), true);
  releaseEnglishAudioPlayback(currentOwner);
});
