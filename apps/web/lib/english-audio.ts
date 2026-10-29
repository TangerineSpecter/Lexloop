export function findLocalEnglishVoice(voices: readonly SpeechSynthesisVoice[]) {
  const localEnglishVoices = voices.filter(
    (voice) => voice.localService === true && /^en(?:-|$)/i.test(voice.lang),
  );

  return (
    localEnglishVoices.find((voice) => voice.lang.toLowerCase() === 'en-us') ??
    localEnglishVoices.find((voice) => voice.lang.toLowerCase() === 'en') ??
    localEnglishVoices.find((voice) => voice.lang.toLowerCase().startsWith('en-')) ??
    null
  );
}
