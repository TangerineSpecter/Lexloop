// Structural checks only: these cannot judge meaning, inference quality, originality or CEFR.
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function progressiveSentenceIssue(sentences: readonly { english: string }[]) {
  const seen = new Set<string>();
  for (const { english } of sentences) {
    if (!/[A-Za-z]/.test(english) || /[\u3400-\u9fff]/u.test(english)) {
      return 'STUDY_PROGRESSIVE_SENTENCE_LANGUAGE_INVALID';
    }
    // Protect common titles and dotted acronyms before sentence segmentation.
    // Do not treat decimal points or semicolons as sentence boundaries ourselves.
    const protectedText = english
      .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\.(?=\s+[A-Z])/g, (text) =>
        text.replace('.', '\uE000'),
      )
      .replace(/\b(?:[A-Za-z]\.){2,}/g, (text) => text.replaceAll('.', '\uE000'));
    const segments = [...sentenceSegmenter.segment(protectedText)].filter((segment) =>
      /[A-Za-z]/.test(segment.segment),
    );
    if (segments.length !== 1) return 'STUDY_PROGRESSIVE_SENTENCE_BOUNDARY_INVALID';
    const normalized = english
      .normalize('NFC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (seen.has(normalized)) return 'STUDY_PROGRESSIVE_SENTENCES_DUPLICATE';
    seen.add(normalized);
  }
  return null;
}
