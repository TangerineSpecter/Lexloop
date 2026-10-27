'use client';

import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import styles from './english-audio-controls.module.css';

function findEnglishVoice(voices: SpeechSynthesisVoice[]) {
  return (
    voices.find((voice) => voice.lang.toLowerCase() === 'en-us') ??
    voices.find((voice) => voice.lang.toLowerCase() === 'en') ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith('en-')) ??
    null
  );
}

export function EnglishAudioControls({ text, context }: { text: string; context: string }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [playingRate, setPlayingRate] = useState<number | null>(null);
  const [englishVoiceUnavailable, setEnglishVoiceUnavailable] = useState(false);
  const playbackId = useRef(0);

  useEffect(() => {
    setSupported(
      'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    );
    setPlayingRate(null);
    setEnglishVoiceUnavailable(false);
    const synthesis = 'speechSynthesis' in window ? window.speechSynthesis : null;
    const handleVoicesChanged = () => {
      if (synthesis && findEnglishVoice(synthesis.getVoices())) {
        setEnglishVoiceUnavailable(false);
      }
    };
    synthesis?.addEventListener?.('voiceschanged', handleVoicesChanged);

    return () => {
      playbackId.current += 1;
      synthesis?.removeEventListener?.('voiceschanged', handleVoicesChanged);
      synthesis?.cancel();
    };
  }, [text]);

  function play(rate: number) {
    if (!supported) return;

    const voice = findEnglishVoice(window.speechSynthesis.getVoices());
    if (!voice) {
      playbackId.current += 1;
      window.speechSynthesis.cancel();
      setPlayingRate(null);
      setEnglishVoiceUnavailable(true);
      return;
    }

    setEnglishVoiceUnavailable(false);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = rate;
    utterance.voice = voice;
    const currentPlaybackId = ++playbackId.current;
    const finishPlayback = () => {
      if (playbackId.current === currentPlaybackId) setPlayingRate(null);
    };
    utterance.onend = finishPlayback;
    utterance.onerror = finishPlayback;

    window.speechSynthesis.cancel();
    setPlayingRate(rate);
    window.speechSynthesis.speak(utterance);
  }

  function stop() {
    playbackId.current += 1;
    window.speechSynthesis.cancel();
    setPlayingRate(null);
  }

  if (supported === null) return null;
  if (!supported)
    return <p className={styles.unavailable}>当前浏览器不支持语音播放，可直接阅读原文。</p>;

  return (
    <div className={styles.controls} role="group" aria-label={`${context}语音播放`}>
      <button
        className={styles.button}
        type="button"
        onClick={() => play(1)}
        aria-label={`按正常速度播放${context}`}
      >
        <Volume2 aria-hidden="true" size={18} />
        正常速度
      </button>
      <button
        className={styles.button}
        type="button"
        onClick={() => play(0.8)}
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
      <span className={styles.status} aria-live="polite">
        {playingRate === null
          ? englishVoiceUnavailable
            ? '当前没有可用的英语语音；可稍后重试或直接阅读原句。'
            : ''
          : playingRate < 1
            ? '正在慢速播放'
            : '正在播放'}
      </span>
    </div>
  );
}
