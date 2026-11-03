// Reviewed source batch: data/vocabulary-corrections/2026-11-03.
// Derived data: Wiktionary contributors, CC BY-SA 4.0; see /vocabulary-sources.
// Keep the batch identity immutable; publish future corrections as new batches.
export const VOCABULARY_CORRECTION_BATCH = 'daily-2026-11-03-v1';
export const VOCABULARY_CORRECTION_SOURCE = '通用/日常生活单词.xlsx';
export const VOCABULARY_CORRECTIONS = [
  { word: 'backache', meaning: 'n. 背疼' },
  { word: 'moped', meaning: 'n. 摩托自行车', ukPhonetic: 'ˈməʊ.pɛd', usPhonetic: 'ˈmoʊ.pɛd' },
  { word: 'crate', meaning: 'n. 板条箱' },
  { word: 'brownie', meaning: 'n. 布朗尼', ukPhonetic: 'ˈbɹaʊni', usPhonetic: 'ˈbɹaʊni' },
  { word: 'ceramics', meaning: 'n. 陶瓷' },
  { word: 'espresso', meaning: 'n. 浓缩咖啡', ukPhonetic: 'ɛˈspɹɛsəʊ', usPhonetic: 'ɛˈspɹɛsoʊ' },
] as const;
