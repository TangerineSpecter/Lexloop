'use client';

import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { findLocalEnglishVoice } from '../lib/english-audio';
import { readSession, request, requestBlob } from '../lib/api';
import styles from './english-audio-controls.module.css';

let activePlayback: { owner: symbol; stop: () => void } | null = null;

function activatePlayback(owner: symbol, stop: () => void) {
  if (activePlayback && activePlayback.owner !== owner) activePlayback.stop();
  activePlayback = { owner, stop };
}

function releasePlayback(owner: symbol) {
  if (activePlayback?.owner === owner) activePlayback = null;
}

function ownsPlayback(owner: symbol) {
  return activePlayback?.owner === owner;
}

export function createEnglishUtterance(text: string, rate = 1) {
  if (
    typeof window === 'undefined' ||
    !('speechSynthesis' in window) ||
    typeof window.SpeechSynthesisUtterance !== 'function'
  ) {
    return 'unsupported' as const;
  }
  const voice = findLocalEnglishVoice(window.speechSynthesis.getVoices());
  if (!voice) return 'no-voice' as const;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice.lang || 'en-US';
  utterance.rate = rate;
  utterance.voice = voice;
  return utterance;
}

export function speakEnglish(text: string, rate = 1) {
  const utterance = createEnglishUtterance(text, rate);
  if (typeof utterance === 'string') return utterance;
  const owner = Symbol('direct-english-speech');
  const stop = () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    releasePlayback(owner);
  };
  activatePlayback(owner, stop);
  window.speechSynthesis.cancel();
  utterance.onend = () => releasePlayback(owner);
  utterance.onerror = () => releasePlayback(owner);
  window.speechSynthesis.speak(utterance);
  return 'played' as const;
}

export function EnglishAudioControls({
  text,
  context,
  compact = false,
  dataAttribute,
  buttonLabel,
  autoPlayRequest,
}: {
  text: string;
  context: string;
  compact?: boolean;
  dataAttribute?: string;
  buttonLabel?: string;
  autoPlayRequest?: number;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [playingRate, setPlayingRate] = useState<number | null>(null);
  const [englishVoiceUnavailable, setEnglishVoiceUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    rate: number;
    missing: boolean;
    text: string;
    userId: string;
    interactionId: number;
  } | null>(null);
  const [message, setMessage] = useState('');
  const playbackId = useRef(0);
  const interactionId = useRef(0);
  const playbackOwner = useRef(Symbol('english-audio-controls'));
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const autoPlayRequestRef = useRef<number | null>(null);

  useEffect(() => {
    interactionId.current += 1;
    setBusy(false);
    setSupported(
      'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    );
    setPlayingRate(null);
    setEnglishVoiceUnavailable(false);
    setConfirmation(null);
    setMessage('');
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    const synthesis = 'speechSynthesis' in window ? window.speechSynthesis : null;
    const handleVoicesChanged = () => {
      if (synthesis && findLocalEnglishVoice(synthesis.getVoices())) {
        setEnglishVoiceUnavailable(false);
      }
    };
    synthesis?.addEventListener?.('voiceschanged', handleVoicesChanged);

    return () => {
      interactionId.current += 1;
      playbackId.current += 1;
      synthesis?.removeEventListener?.('voiceschanged', handleVoicesChanged);
      if (ownsPlayback(playbackOwner.current)) synthesis?.cancel();
      audioRef.current?.pause();
      audioRef.current = null;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      releasePlayback(playbackOwner.current);
    };
  }, [text]);

  function currentUserMatches(userId: string) {
    try {
      return readSession()?.user.id === userId;
    } catch {
      return false;
    }
  }

  async function playRemote(
    audioId: string,
    rate: number,
    userId: string,
    token: string,
    interaction: number,
  ) {
    const blob = await requestBlob(`/tts/audio/${encodeURIComponent(audioId)}`, {}, token);
    if (
      !currentUserMatches(userId) ||
      interactionId.current !== interaction ||
      !ownsPlayback(playbackOwner.current)
    )
      return;
    const url = URL.createObjectURL(blob);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;
    const audio = new Audio(url);
    audio.playbackRate = rate;
    audioRef.current = audio;
    const playback = ++playbackId.current;
    audio.onended = () => {
      if (playbackId.current === playback) {
        setPlayingRate(null);
        releasePlayback(playbackOwner.current);
      }
      if (audioRef.current === audio) audioRef.current = null;
      if (objectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        objectUrlRef.current = null;
      }
    };
    audio.onerror = () => {
      if (playbackId.current === playback) {
        setPlayingRate(null);
        setMessage('音频已取得，但浏览器无法播放；可以改用浏览器本地朗读。');
        releasePlayback(playbackOwner.current);
      }
      if (objectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        objectUrlRef.current = null;
      }
      if (audioRef.current === audio) audioRef.current = null;
    };
    try {
      await audio.play();
    } catch {
      if (objectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        objectUrlRef.current = null;
      }
      if (audioRef.current === audio) audioRef.current = null;
      if (playbackId.current === playback) releasePlayback(playbackOwner.current);
      throw new Error('音频已取得，但浏览器无法播放；可以改用浏览器本地朗读。');
    }
    if (
      currentUserMatches(userId) &&
      playbackId.current === playback &&
      ownsPlayback(playbackOwner.current)
    ) {
      setPlayingRate(rate);
    }
  }

  function playLocal(rate: number, cancelCurrent = true) {
    activatePlayback(playbackOwner.current, stop);
    if (!supported) {
      setMessage('当前浏览器不支持本地语音朗读。');
      releasePlayback(playbackOwner.current);
      return;
    }

    const utterance = createEnglishUtterance(text, rate);
    if (utterance === 'unsupported') {
      setMessage('当前浏览器不支持本地语音朗读。');
      releasePlayback(playbackOwner.current);
      return;
    }
    if (utterance === 'no-voice') {
      playbackId.current += 1;
      setPlayingRate(null);
      setEnglishVoiceUnavailable(true);
      releasePlayback(playbackOwner.current);
      return;
    }

    setEnglishVoiceUnavailable(false);
    setMessage('');
    const currentPlaybackId = ++playbackId.current;
    const finishPlayback = () => {
      if (playbackId.current === currentPlaybackId) {
        setPlayingRate(null);
        releasePlayback(playbackOwner.current);
      }
    };
    utterance.onend = finishPlayback;
    utterance.onerror = finishPlayback;

    if (cancelCurrent && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setPlayingRate(rate);
    window.speechSynthesis.speak(utterance);
  }

  async function play(rate: number) {
    if (busy) return;
    stop();
    const interaction = ++interactionId.current;
    activatePlayback(playbackOwner.current, stop);
    const requestedText = text;
    setConfirmation(null);
    setMessage('');
    let session;
    try {
      session = readSession();
    } catch {
      session = null;
    }
    if (!session) {
      playLocal(rate, false);
      return;
    }
    setBusy(true);
    try {
      const lookup = await request<{
        state: 'disabled' | 'miss' | 'missing' | 'hit';
        audioId?: string;
      }>(
        '/tts/audio/lookup',
        { method: 'POST', body: JSON.stringify({ text: requestedText }) },
        session.accessToken,
      );
      if (
        !currentUserMatches(session.user.id) ||
        interactionId.current !== interaction ||
        !ownsPlayback(playbackOwner.current)
      )
        return;
      if (lookup.state === 'disabled') {
        playLocal(rate, false);
      } else if (lookup.state === 'hit' && lookup.audioId) {
        await playRemote(lookup.audioId, rate, session.user.id, session.accessToken, interaction);
      } else {
        setConfirmation({
          rate,
          missing: lookup.state === 'missing',
          text: requestedText,
          userId: session.user.id,
          interactionId: interaction,
        });
      }
    } catch (error) {
      if (currentUserMatches(session.user.id) && interactionId.current === interaction) {
        setMessage(error instanceof Error ? error.message : '语音服务暂时不可用。');
      }
    } finally {
      if (interactionId.current === interaction) setBusy(false);
    }
  }

  async function confirmGenerate() {
    if (!confirmation || busy) return;
    let session;
    try {
      session = readSession();
    } catch {
      session = null;
    }
    if (!session || session.user.id !== confirmation.userId) {
      setMessage('登录状态已变化，请重新点击播放。');
      setConfirmation(null);
      return;
    }
    const pending = confirmation;
    if (pending.interactionId !== interactionId.current) {
      setConfirmation(null);
      return;
    }
    setBusy(true);
    setConfirmation(null);
    setMessage('正在生成语音；这可能需要一些时间。');
    try {
      const result = await request<{ audioId: string; cache: 'generated' | 'reused' }>(
        '/tts/audio/generate',
        { method: 'POST', body: JSON.stringify({ text: pending.text, consent: true }) },
        session.accessToken,
      );
      if (
        !currentUserMatches(session.user.id) ||
        interactionId.current !== pending.interactionId ||
        !ownsPlayback(playbackOwner.current)
      )
        return;
      await playRemote(
        result.audioId,
        pending.rate,
        session.user.id,
        session.accessToken,
        pending.interactionId,
      );
      setMessage('');
    } catch (error) {
      if (currentUserMatches(session.user.id) && interactionId.current === pending.interactionId) {
        setMessage(error instanceof Error ? error.message : '语音生成失败；可以稍后手动重试。');
      }
    } finally {
      if (interactionId.current === pending.interactionId) setBusy(false);
    }
  }

  useEffect(() => {
    if (autoPlayRequest === undefined || autoPlayRequestRef.current === autoPlayRequest) {
      return;
    }
    autoPlayRequestRef.current = autoPlayRequest;
    void play(1);
  }, [autoPlayRequest, text]);

  function stop() {
    interactionId.current += 1;
    playbackId.current += 1;
    if (ownsPlayback(playbackOwner.current) && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setPlayingRate(null);
    setBusy(false);
    setConfirmation(null);
    releasePlayback(playbackOwner.current);
  }

  return (
    <div
      className={`${styles.controls} ${compact ? styles.compact : ''}`}
      role="group"
      aria-label={`${context}语音播放`}
    >
      {compact ? (
        <button
          className={styles.button}
          type="button"
          onClick={() => void play(1)}
          disabled={busy}
          aria-label={buttonLabel ?? `播放${context}发音`}
          title={buttonLabel ?? `播放${context}发音`}
          {...(dataAttribute ? { [dataAttribute]: '' } : {})}
        >
          <Volume2 aria-hidden="true" size={18} />
        </button>
      ) : (
        <>
          <button
            className={styles.button}
            type="button"
            onClick={() => void play(1)}
            disabled={busy}
            aria-label={`按正常速度播放${context}`}
          >
            <Volume2 aria-hidden="true" size={18} />
            正常速度
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={() => void play(0.8)}
            disabled={busy}
            aria-label={`慢速播放${context}`}
          >
            慢速 0.8×
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={stop}
            disabled={playingRate === null}
            aria-label={`停止播放${context}`}
          >
            停止
          </button>
        </>
      )}
      <span className={styles.status} aria-live="polite">
        {busy
          ? '正在读取或准备语音…'
          : playingRate === null
            ? englishVoiceUnavailable
              ? '浏览器没有提供标记为本地服务的英语语音；可稍后重试或直接阅读原句。'
              : ''
            : playingRate < 1
              ? '正在慢速播放'
              : '正在播放'}
      </span>
      {confirmation && (
        <div className={styles.confirmation} role="group" aria-label={`确认生成${context}语音`}>
          <p>
            {confirmation.missing ? '原有缓存文件已丢失。' : '尚无这段文本的语音缓存。'}
            {' 首次生成会把文本发送给 MiniMax，可能产生费用。'}
          </p>
          <button type="button" className={styles.button} onClick={() => void confirmGenerate()}>
            确认生成并播放
          </button>
          <button type="button" className={styles.button} onClick={() => setConfirmation(null)}>
            取消
          </button>
        </div>
      )}
      {message && (
        <span className={styles.status} role="status">
          {message}
          {!/正在生成语音|不支持本地语音|没有提供标记为本地服务的英语语音/.test(message) && (
            <button type="button" className={styles.fallback} onClick={() => playLocal(1)}>
              改用浏览器朗读
            </button>
          )}
        </span>
      )}
    </div>
  );
}
