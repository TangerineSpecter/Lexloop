'use client';

import { useEffect, useState } from 'react';
import { Volume2 } from 'lucide-react';
import styles from './english-audio-controls.module.css';

export function EnglishAudioControls({ text, context }: { text: string; context: string }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [playingRate, setPlayingRate] = useState<number | null>(null);

  useEffect(() => {
    setSupported(
      'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    );
    setPlayingRate(null);

    return () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, [text]);

  function play(rate: number) {
    if (!supported) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = rate;
    const voices = window.speechSynthesis.getVoices();
    const englishVoice =
      voices.find((voice) => voice.lang.toLowerCase() === 'en-us') ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith('en-'));
    if (englishVoice) utterance.voice = englishVoice;
    utterance.onend = () => setPlayingRate(null);
    utterance.onerror = () => setPlayingRate(null);

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setPlayingRate(rate);
  }

  function stop() {
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
        {playingRate === null ? '' : playingRate < 1 ? '正在慢速播放' : '正在播放'}
      </span>
    </div>
  );
}
