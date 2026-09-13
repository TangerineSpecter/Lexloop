const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(value) {
  const normalized = value.startsWith('v') ? value.slice(1) : value;
  const match = STABLE_SEMVER.exec(normalized);
  return match ? { version: normalized, parts: match.slice(1, 4).map(Number) } : null;
}

export function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new Error('只能比较稳定 SemVer 版本');
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  }
  return 0;
}

export function selectLatestRelease(releases) {
  return (
    releases
      .filter((item) => item.annotated && parseStableVersion(item.tag))
      .sort((left, right) => compareVersions(right.tag, left.tag))[0] ?? null
  );
}

export function evaluateUpdate(currentVersion, currentSha, latest, isDescendant) {
  if (!latest) return { updateAvailable: false, sameVersionRevision: false };
  const comparison = parseStableVersion(currentVersion)
    ? compareVersions(latest.version, currentVersion)
    : 1;
  const sameVersionRevision = comparison === 0 && latest.sha !== currentSha;
  return {
    updateAvailable: (comparison > 0 || sameVersionRevision) && isDescendant,
    sameVersionRevision,
  };
}
