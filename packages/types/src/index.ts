export type * from './practice';
export type UserRole = 'USER' | 'ADMIN';

export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
  displayName: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export type SystemUpdateStage =
  | 'IDLE'
  | 'CHECKING'
  | 'BUILDING'
  | 'BACKING_UP'
  | 'MIGRATING'
  | 'DEPLOYING'
  | 'VERIFYING'
  | 'SUCCEEDED'
  | 'FAILED';

export interface SystemUpdateRelease {
  version: string;
  sha: string;
  tag: string;
  compareUrl: string | null;
}

export interface SystemUpdateJob {
  id: string;
  stage: SystemUpdateStage;
  message: string;
  targetVersion: string;
  targetSha: string;
  actorId: string;
  actorEmail: string;
  startedAt: string;
  finishedAt: string | null;
  logs: string[];
}

export interface SystemUpdateStatus {
  currentVersion: string;
  currentSha: string;
  updaterAvailable: boolean;
  error: string | null;
  latest: SystemUpdateRelease | null;
  updateAvailable: boolean;
  sameVersionRevision: boolean;
  checkedAt: string | null;
  job: SystemUpdateJob | null;
}

export type StatisticsRange = '7d' | '30d' | '365d';
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';
export type ProfileConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PeriodActivityDay {
  label: string;
  words: number;
  questions: number;
  studySeconds: number;
  scenarios: number;
  assessments: number;
  practiceSessions?: number;
  today?: boolean;
}

export interface RankingRow {
  word: string;
  count?: number;
  rate?: number;
}

export interface PeriodStatistics {
  activeDays: number;
  activity: PeriodActivityDay[];
  chart: Array<{ label: string; words: number; completed: boolean; today?: boolean }>;
  currentStreak: number;
  learnedWords: number;
  masteredWords: number;
  newWords: number;
  reviewWords: number;
  attemptCount: number;
  accuracy: number;
  averageResponseMs: number;
  studySeconds: number;
  completedPlans: number;
  completedScenarios: number;
  completedAssessments: number;
  summary: string;
  suggestion: string;
  versusPrevious: number;
  rankings: {
    accuracy: RankingRow[];
    errorRate: RankingRow[];
    unfamiliar: RankingRow[];
    reviews: RankingRow[];
  };
}

export interface AbilityDimensions {
  vocabulary: number;
  grammar: number;
  sentenceBuilding: number;
  taskCompletion: number;
  naturalness: number;
  pronunciation: number | null;
  listening: number | null;
  fluency: number | null;
}

export interface AbilitySnapshot {
  id: string;
  source: 'ASSESSMENT' | 'SCENARIO' | 'BACKFILLED_BASELINE';
  level: CefrLevel;
  confidence: ProfileConfidence;
  provisional: boolean;
  dimensions: Omit<AbilityDimensions, 'pronunciation' | 'listening' | 'fluency'>;
  recordedAt: string;
  backfilled: boolean;
}

export type CareerActionTarget = 'assessment' | 'review' | 'mistakes' | 'travel' | 'study';
export interface CareerRecommendation {
  title: string;
  reason: string;
  target: CareerActionTarget;
}
export interface CareerAiAnalysis {
  headline: string;
  summary: string;
  strengths: string[];
  focusAreas: string[];
  weeklyPlan: Array<{ action: string; target: CareerActionTarget; reason: string }>;
}

export interface CareerStatistics {
  generatedAt: string;
  overview: {
    startedAt: string;
    activeDays: number;
    totalQuestions: number;
    studySeconds: number;
    completedPlans: number;
    learnedWords: number;
    masteredWords: number;
    completedScenarios: number;
  };
  profile: {
    level: CefrLevel;
    confidence: ProfileConfidence;
    provisional: boolean;
    assessedAt: string | null;
    dimensions: AbilityDimensions;
  };
  growth: AbilitySnapshot[];
  memory: {
    learningWords: number;
    reviewingWords: number;
    dueWords: number;
    overdueWords: number;
    masteryRate: number;
  };
  quality: {
    accuracy: number;
    averageResponseMs: number;
    activeWeaknesses: number;
    resolvedWeaknesses: number;
    strongestQuestionType: string | null;
    weakestQuestionType: string | null;
  };
  practice: {
    successRate: number;
    categoriesExperienced: number;
    totalCategories: number;
    categories: Array<{ category: string; count: number; successRate: number }>;
    skills: Array<{
      code: string;
      title: string;
      level: CefrLevel;
      score: number;
      evidenceCount: number;
    }>;
  };
  insights: { strengths: string[]; risks: string[]; recommendations: CareerRecommendation[] };
  aiAnalysis: {
    status: 'none' | 'ready' | 'stale';
    generatedAt: string | null;
    content: CareerAiAnalysis | null;
  };
}

export type AdventureClassKey = 'warrior' | 'mage' | 'ranger' | 'cleric';
export type AdventureChallengeType =
  'CHOICE' | 'SPELLING' | 'SENTENCE_ORDER' | 'MATCHING' | 'FREE_RESPONSE';
export type AdventureHitGrade = 'PERFECT' | 'HIT' | 'GRAZE' | 'MISS';
export type AdventureRoomType = 'COMBAT' | 'ELITE' | 'EVENT' | 'CAMP' | 'TREASURE' | 'BOSS';
export type AdventureRunStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'RETREATED';
export type AdventurePracticeFocus = 'BALANCED' | 'RECALL' | 'CONTEXT';
export type AdventureCombatPassiveKey = 'VANGUARD' | 'BURST' | 'STRIKER' | 'SUPPORT';
export type EquipmentSlot = 'WEAPON' | 'ARMOR' | 'ACCESSORY';
export type EquipmentRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';

export interface AdventureCombatPassive {
  key: AdventureCombatPassiveKey;
  title: string;
  description: string;
}

export interface AdventureClassNode {
  id: string;
  key: string;
  name: string;
  description: string;
  combatRole: string;
  tier: number;
  requiredLevel: number;
  parentId: string | null;
  available: boolean;
  current: boolean;
  /** Present on current APIs; omitted by older clients and fixtures. */
  combatPassive?: AdventureCombatPassive | null;
}

export interface AdventureSkill {
  id: string;
  key: string;
  name: string;
  description: string;
  target: 'SELF' | 'ENEMY' | 'ALLY' | 'PARTY';
  cost: number;
  requiredLevel: number;
  unlocked: boolean;
}

export interface AdventureProfile {
  id: string;
  level: number;
  experience: number;
  experienceToNextLevel: number;
  gold: number;
  materials: number;
  skillPoints: number;
  highestFloor: number;
  soundEnabled: boolean;
  currentClass: AdventureClassNode | null;
  availableClasses: AdventureClassNode[];
  skills: AdventureSkill[];
}

export interface DungeonFloorSummary {
  id: string;
  floorNumber: number;
  title: string;
  cefrLevel: CefrLevel;
  targetCount: number;
  exploration: number;
  mastery: number;
  bossUnlocked: boolean;
  completed: boolean;
  locked: boolean;
}

export interface DungeonMap {
  book: { id: string; title: string } | null;
  floors: DungeonFloorSummary[];
}

export interface BattleChallenge {
  id: string;
  type: AdventureChallengeType;
  phase: 'ATTACK' | 'BLOCK';
  prompt: string;
  options?: string[];
  tokens?: string[];
  hint?: string;
  inputPlaceholder?: string;
}

export interface DungeonRoomState {
  id: string;
  position: number;
  type: AdventureRoomType;
  status: 'PENDING' | 'ACTIVE' | 'CLEARED' | 'FAILED' | 'SKIPPED';
  enemyName: string | null;
  enemyHp: number | null;
  enemyMaxHp: number | null;
}

export interface DungeonLastAction {
  challengeType: AdventureChallengeType;
  phase: 'ATTACK' | 'BLOCK';
  prompt: string | null;
  answer: string[];
  score: number;
  grade: AdventureHitGrade;
  damageDealt: number;
  damageReceived: number;
  feedback: {
    correct: boolean;
    message: string;
    answer?: string;
    provisional?: boolean;
    passiveTrigger?: string;
  };
}

export interface DungeonMistakeReviewItem {
  id: string;
  challengeType: AdventureChallengeType;
  phase: 'ATTACK' | 'BLOCK';
  prompt: string;
  answer: string[];
  referenceAnswer: string;
  reviewOutcome: 'BELOW_THRESHOLD' | 'UNJUDGEABLE' | 'LEGACY_UNKNOWN';
  word?: string;
  meaning?: string;
  feedback?: string;
}

export interface DungeonRunState {
  id: string;
  status: AdventureRunStatus;
  durationMinutes: 5 | 10 | 15;
  /** Older saved runs omit this field and are interpreted as BALANCED. */
  practiceFocus?: AdventurePracticeFocus;
  /** Null on legacy runs created before combat passives were snapshotted. */
  combatPassive?: AdventureCombatPassive | null;
  combatRulesVersion?: number;
  currentRoom: number;
  roomCount: number;
  playerHp: number;
  playerMaxHp: number;
  resource: number;
  experienceEarned: number;
  goldEarned: number;
  materialsEarned: number;
  floor: DungeonFloorSummary;
  rooms: DungeonRoomState[];
  loot: InventoryItem[];
  challenge: BattleChallenge | null;
  lastAction: DungeonLastAction | null;
  /** Available only after the run ends; reading it never changes learning records. */
  mistakeReview?: DungeonMistakeReviewItem[];
  /** Older actions without their original prompt/answer snapshot are not reconstructed. */
  unavailableMistakeReviewCount?: number;
  availableSkills: AdventureSkill[];
  canRetreat: boolean;
}

export interface BattleResolution {
  repeated: boolean;
  score: number;
  grade: AdventureHitGrade;
  damageDealt: number;
  damageReceived: number;
  feedback: {
    correct: boolean;
    message: string;
    answer?: string;
    provisional?: boolean;
    passiveTrigger?: string;
  };
  run: DungeonRunState;
  rewards?: { experience: number; gold: number; materials: number; item?: InventoryItem };
}

export interface InventoryItem {
  id: string;
  name: string;
  description: string;
  slot: EquipmentSlot;
  rarity: EquipmentRarity;
  stats: Record<string, number>;
  durability: number;
  equipped: boolean;
  secured: boolean;
}

export interface Inventory {
  items: InventoryItem[];
  equipped: Partial<Record<EquipmentSlot, InventoryItem>>;
}

export interface DailyQuest {
  id: string;
  type: 'DUE_REVIEW' | 'WEAKNESS' | 'FREE_CHALLENGE';
  title: string;
  description: string;
  targetCount: number;
  progress: number;
  reward: { gold: number; materials: number };
  claimedAt: string | null;
  claimable: boolean;
  floorId: string | null;
}

interface LearningHistoryBase {
  id: string;
  occurredAt: string;
}

export interface LearningHistoryPlanItem extends LearningHistoryBase {
  kind: 'PLAN';
  mode: 'group' | 'individual' | 'exam';
  wordCount: number;
  totalQuestions: number;
  correctQuestions: number;
  durationSeconds: number;
  typeStats: Array<{ type: string; total: number; correct: number }>;
  weakWords: string[];
}

export interface LearningHistoryAssessmentItem extends LearningHistoryBase {
  kind: 'ASSESSMENT';
  level: CefrLevel;
  confidence: ProfileConfidence;
  provisional: boolean;
  questionCount: number;
}

export interface LearningHistoryScenarioItem extends LearningHistoryBase {
  kind: 'SCENARIO';
  title: string;
  category: string;
  level: CefrLevel;
  outcome: 'SUCCESS' | 'PARTIAL' | 'INCOMPLETE';
}

export type LearningHistoryItem =
  LearningHistoryPlanItem | LearningHistoryAssessmentItem | LearningHistoryScenarioItem;

export interface VocabularyArchivePage<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface LearningHistoryResponse {
  items: LearningHistoryItem[];
  hasMore: boolean;
  nextCursor: string | null;
  totals: {
    records: number;
    plans: number;
    words: number;
    questions: number;
    correctQuestions: number;
    assessments: number;
    scenarios: number;
  };
}
export type DailySentenceContent = {
  english: string;
  chinese: string;
  level: string;
  focus: string;
  chunks: Array<{ text: string; role: string; phraseType: string; explanation: string }>;
  explanations: Array<{ question: string; answer: string }>;
  pattern: string;
  usage: string;
  example: { english: string; chinese: string };
  learningReason: string;
};
export type DailySentenceItem = {
  id: string;
  dateKey: string;
  content: DailySentenceContent;
  readAt: string | null;
  favorite: boolean;
  difficulty: 'EASY' | 'RIGHT' | 'HARD' | null;
  difficultyTimestampReliable: boolean;
};
export type DailySentenceCurrent = {
  item: DailySentenceItem | null;
  state: 'READY' | 'GENERATING' | 'FAILED' | 'WAITING' | 'MODEL_REQUIRED' | 'DISABLED';
  canRetry: boolean;
};
export type DailySentenceHistory = { items: DailySentenceItem[]; hasMore: boolean };

export interface RemoteBackupSettings {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  hostKey: string;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
}

export interface RemoteBackupStatus {
  configurationError?: string | null;
  available: boolean;
  settings: RemoteBackupSettings | null;
  running?: boolean;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastFile?: string | null;
  error?: string | null;
  stale?: boolean;
}

export type NotebookSource = 'TRAVEL' | 'READING' | 'DAILY_SENTENCE' | 'MANUAL' | 'WORD';
export interface NotebookWord {
  id: string;
  wordId: string;
  text: string;
  type: 'WORD' | 'PHRASE';
  meaning: string | null;
  example: string | null;
  sourceScenario: string | null;
  sourceType: NotebookSource;
  state: string;
  nextReviewAt: string | null;
}
export interface NotebookPage {
  items: NotebookWord[];
  hasMore: boolean;
  total: number;
}
export type LabKind = 'READING' | 'GRAMMAR';
export interface LabQuestion {
  id: string;
  prompt: string;
  options: string[];
  topic?: string;
  correctIndex?: number;
  explanation?: string;
}
export interface GrammarEvidence {
  id: string;
  source: string;
  original: string;
  feedback: string;
  corrected: string;
}
export interface LabContent {
  title: string;
  introduction: string;
  sentences: Array<{ english: string; chinese: string; note: string }>;
  targets: Array<{ id: string; text: string; meaning: string }>;
  topics: Array<{ key: string; title: string; explanation: string; evidenceIds: string[] }>;
  questions: LabQuestion[];
}
export interface LabLessonView {
  id: string;
  kind: LabKind;
  status: 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED';
  content: LabContent | null;
  evidence: GrammarEvidence[];
  answers: number[] | null;
  score: number | null;
  error: string | null;
  createdAt: string;
  submittedAt: string | null;
}
export interface LabHistory {
  items: LabLessonView[];
  hasMore: boolean;
}
