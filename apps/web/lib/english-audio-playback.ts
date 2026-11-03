let activePlayback: { owner: symbol; stop: () => void } | null = null;

export function claimEnglishAudioPlayback(owner: symbol, stop: () => void) {
  if (activePlayback && activePlayback.owner !== owner) activePlayback.stop();
  activePlayback = { owner, stop };
}

export function releaseEnglishAudioPlayback(owner: symbol) {
  if (activePlayback?.owner === owner) activePlayback = null;
}

export function ownsEnglishAudioPlayback(owner: symbol) {
  return activePlayback?.owner === owner;
}
