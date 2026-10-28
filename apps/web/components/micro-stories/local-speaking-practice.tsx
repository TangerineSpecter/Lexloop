'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, Trash2 } from 'lucide-react';
import styles from './micro-stories.module.css';

const MAX_RECORDING_MS = 30_000;

type RecordingStatus = 'idle' | 'requesting' | 'recording' | 'ready' | 'unsupported' | 'error';

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    if (track.readyState !== 'ended') track.stop();
  });
}

export function LocalSpeakingPractice({ storyKey }: { storyKey: string }) {
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [message, setMessage] = useState('录音只暂存在当前页面，不会上传或用于评分。');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const objectUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const attemptRef = useRef(0);
  const discardRef = useRef(false);
  const stopReasonRef = useRef<'manual' | 'limit'>('manual');
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const timerAttemptRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  function clearTimers(attemptId?: number) {
    if (attemptId !== undefined && timerAttemptRef.current !== attemptId) return;
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
    timerAttemptRef.current = null;
  }

  function releaseStream(stream: MediaStream) {
    stopTracks(stream);
    if (streamRef.current === stream) streamRef.current = null;
  }

  function removeAudio() {
    audioRef.current?.pause();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setAudioUrl(null);
  }

  useEffect(() => {
    mountedRef.current = true;
    const canRecord =
      Boolean(navigator.mediaDevices?.getUserMedia) && typeof window.MediaRecorder === 'function';
    setSupported(canRecord);
    if (!canRecord) {
      setStatus('unsupported');
      setMessage('当前浏览器不支持本地录音。仍可使用上方英语播放和文字复述。');
    }
    const releasePageResources = () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      discardRef.current = true;
      clearTimers();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // The browser may already have stopped the recorder while leaving the page.
        }
      }
      const stream = streamRef.current;
      streamRef.current = null;
      stopTracks(stream);
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };
    const handlePageHide = () => releasePageResources();
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      mountedRef.current = true;
      chunksRef.current = [];
      setAudioUrl(null);
      setElapsedSeconds(0);
      setStatus(canRecord ? 'idle' : 'unsupported');
      setMessage(
        canRecord
          ? '录音只暂存在当前页面，不会上传或用于评分。'
          : '当前浏览器不支持本地录音。仍可使用上方英语播放和文字复述。',
      );
    };
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      releasePageResources();
    };
  }, []);

  async function startRecording() {
    if (status === 'requesting' || status === 'recording') return;
    removeAudio();
    chunksRef.current = [];
    discardRef.current = false;
    stopReasonRef.current = 'manual';
    setElapsedSeconds(0);
    setStatus('requesting');
    setMessage('正在请求麦克风；允许后即可开始录音。');
    const attemptId = ++attemptRef.current;
    let stream: MediaStream | null = null;

    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== 'function') {
        setSupported(false);
        setStatus('unsupported');
        setMessage('当前浏览器不支持本地录音。仍可使用上方英语播放和文字复述。');
        return;
      }

      const activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream = activeStream;
      if (!mountedRef.current || attemptRef.current !== attemptId) {
        stopTracks(activeStream);
        return;
      }

      if (activeStream.getAudioTracks().length === 0) throw new Error('麦克风没有提供音轨');
      const recorder = new MediaRecorder(activeStream);
      streamRef.current = activeStream;
      recorderRef.current = recorder;
      const startedAt = Date.now();
      recorder.addEventListener('dataavailable', (event: BlobEvent) => {
        if (attemptRef.current === attemptId && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });
      recorder.addEventListener('error', () => {
        const isCurrentAttempt = attemptRef.current === attemptId;
        if (isCurrentAttempt) {
          discardRef.current = true;
          chunksRef.current = [];
          attemptRef.current += 1;
          clearTimers(attemptId);
        }
        releaseStream(activeStream);
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (!isCurrentAttempt || !mountedRef.current) return;
        setStatus('error');
        setMessage('录音失败了。检查麦克风后可以重试；录音没有上传。');
      });
      recorder.addEventListener('stop', () => {
        releaseStream(activeStream);
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (!mountedRef.current || attemptRef.current !== attemptId || discardRef.current) return;
        clearTimers(attemptId);

        const audio = new Blob(chunksRef.current, {
          type: recorder.mimeType || chunksRef.current[0]?.type || 'application/octet-stream',
        });
        chunksRef.current = [];
        if (!audio.size) {
          setStatus('error');
          setMessage('没有收到录音数据。可以检查麦克风后重试。');
          return;
        }

        let nextUrl: string;
        try {
          nextUrl = URL.createObjectURL(audio);
        } catch {
          setStatus('error');
          setMessage('浏览器暂时无法准备录音回放，请重试。录音没有上传。');
          return;
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = nextUrl;
        setAudioUrl(nextUrl);
        setStatus('ready');
        setMessage(
          stopReasonRef.current === 'limit'
            ? '已到 30 秒上限，录音已停止，可以回放。'
            : '录音已就绪，可以回放并和原句对比。',
        );
      });

      recorder.start();
      setStatus('recording');
      setMessage('正在录音。读完后停止，再听听自己的表达。');
      timerAttemptRef.current = attemptId;
      intervalRef.current = window.setInterval(() => {
        setElapsedSeconds(Math.min(30, Math.floor((Date.now() - startedAt) / 1000)));
      }, 1000);
      timeoutRef.current = window.setTimeout(() => {
        if (attemptRef.current !== attemptId || recorder.state === 'inactive') return;
        stopReasonRef.current = 'limit';
        try {
          recorder.stop();
        } catch {
          // Keep the recording available for manual retry if the browser rejects stop.
          discardRef.current = true;
          chunksRef.current = [];
          clearTimers(attemptId);
          attemptRef.current += 1;
          releaseStream(activeStream);
          if (recorderRef.current === recorder) recorderRef.current = null;
          setStatus('error');
          setMessage('浏览器无法结束这次录音，请取消后重试。');
        }
      }, MAX_RECORDING_MS);
    } catch (cause) {
      if (stream) {
        stopTracks(stream);
        if (attemptRef.current === attemptId) {
          if (streamRef.current === stream) streamRef.current = null;
          recorderRef.current = null;
          clearTimers(attemptId);
        }
      }
      if (!mountedRef.current || attemptRef.current !== attemptId) return;
      const permissionDenied =
        cause instanceof DOMException &&
        (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      setStatus('error');
      setMessage(
        permissionDenied
          ? '没有获得麦克风权限。可在浏览器设置中允许后重试；不会上传录音。'
          : '无法开始录音。请检查麦克风是否可用后重试。',
      );
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    stopReasonRef.current = 'manual';
    clearTimers(attemptRef.current);
    try {
      recorder.stop();
    } catch {
      discardRef.current = true;
      attemptRef.current += 1;
      if (streamRef.current) releaseStream(streamRef.current);
      recorderRef.current = null;
      setStatus('error');
      setMessage('浏览器无法结束这次录音，请取消后重试。');
    }
  }

  function cancelRecording() {
    attemptRef.current += 1;
    discardRef.current = true;
    clearTimers();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Tracks below are still released if the browser already ended recording.
      }
    }
    const stream = streamRef.current;
    streamRef.current = null;
    stopTracks(stream);
    chunksRef.current = [];
    removeAudio();
    setStatus('idle');
    setElapsedSeconds(0);
    setMessage('已取消录音。');
  }

  return (
    <section
      className={styles.speakingPractice}
      data-local-speaking-practice
      aria-labelledby={`${storyKey}-speaking-title`}
    >
      <div className={styles.speakingHeading}>
        <h3 id={`${storyKey}-speaking-title`}>可选口语跟读</h3>
        <p>先听一遍，再录下自己的表达；回放时对照原句找出不同。</p>
      </div>
      <div className={styles.speakingActions}>
        {status !== 'unsupported' && (
          <button
            className={styles.secondary}
            type="button"
            data-local-speech-action="start"
            aria-label={status === 'error' ? '重新尝试录制口语练习' : '开始录制口语练习'}
            disabled={status === 'requesting' || status === 'recording' || supported === false}
            onClick={() => void startRecording()}
          >
            <Mic aria-hidden="true" size={17} />
            {status === 'requesting'
              ? '等待麦克风权限…'
              : status === 'recording'
                ? `录音中 ${elapsedSeconds} / 30 秒`
                : status === 'ready'
                  ? '重新录音'
                  : status === 'error'
                    ? '重试录音'
                    : '开始录音'}
          </button>
        )}
        {(status === 'requesting' || status === 'recording') && (
          <button
            className={styles.secondary}
            type="button"
            data-local-speech-action={status === 'recording' ? 'stop' : 'cancel'}
            onClick={status === 'recording' ? stopRecording : cancelRecording}
          >
            {status === 'recording' ? '停止并试听' : '取消'}
          </button>
        )}
        {status === 'recording' && (
          <button
            className={styles.secondary}
            type="button"
            data-local-speech-action="cancel"
            onClick={cancelRecording}
          >
            取消录音
          </button>
        )}
        {status === 'ready' && (
          <button
            className={styles.secondary}
            type="button"
            data-local-speech-action="delete"
            onClick={() => {
              attemptRef.current += 1;
              discardRef.current = true;
              chunksRef.current = [];
              removeAudio();
              setElapsedSeconds(0);
              setStatus('idle');
              setMessage('已删除本次录音。');
            }}
          >
            <Trash2 aria-hidden="true" size={17} />
            删除录音
          </button>
        )}
      </div>
      {audioUrl && (
        <audio
          ref={audioRef}
          className={styles.speakingAudio}
          src={audioUrl}
          controls
          preload="none"
          aria-label="回放我的英语复述"
        />
      )}
      <p className={styles.speakingStatus} role={status === 'error' ? 'alert' : 'status'}>
        {status === 'unsupported' && !supported
          ? '当前浏览器不支持本地录音。仍可使用上方英语播放和文字复述。'
          : message}
      </p>
    </section>
  );
}
