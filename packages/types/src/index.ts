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
  today?: boolean;
}

export interface RankingRow { word: string; count?: number; rate?: number }

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
  rankings: { accuracy: RankingRow[]; errorRate: RankingRow[]; unfamiliar: RankingRow[]; reviews: RankingRow[] };
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
export interface CareerRecommendation { title: string; reason: string; target: CareerActionTarget }
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
    skills: Array<{ code: string; title: string; level: CefrLevel; score: number; evidenceCount: number }>;
  };
  insights: { strengths: string[]; risks: string[]; recommendations: CareerRecommendation[] };
  aiAnalysis: { status: 'none' | 'ready' | 'stale'; generatedAt: string | null; content: CareerAiAnalysis | null };
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

export type LearningHistoryItem = LearningHistoryPlanItem | LearningHistoryAssessmentItem | LearningHistoryScenarioItem;
export interface LearningHistoryResponse {
  items: LearningHistoryItem[];
  hasMore: boolean;
  totals: { records: number; plans: number; words: number; questions: number; correctQuestions: number; assessments: number; scenarios: number };
}
