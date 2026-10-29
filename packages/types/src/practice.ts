export type PracticeTab = 'output' | 'confusion' | 'weekly';
export type OutputTarget = { bookWordId: string; word: string; meaning: string };
export type OutputFeedback = {
  score: number;
  grammarScore: number;
  coherenceScore: number;
  correctedText: string;
  comments: string[];
  words: Array<{ bookWordId: string; used: boolean; correct: boolean; feedback: string }>;
};
export type ReadingSentenceRewriteFeedback = {
  meaning: string;
  grammar: string;
  naturalness: string;
  alternative: string | null;
};
export type ReadingWordUseFeedback = {
  wordUse: string;
  meaning: string;
  grammar: string;
  naturalness: string;
  alternative: string | null;
};
export type OutputSubmissionView = {
  id: string;
  clientRequestId: string;
  answer: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  feedback: OutputFeedback | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};
export type OutputHistoryItem = OutputSubmissionView & {
  date: string;
  prompt: string;
  targets: OutputTarget[];
};
export type DailyOutput = {
  id: string;
  date: string;
  prompt: string;
  targets: OutputTarget[];
  remaining: number;
  submissions: OutputSubmissionView[];
};
export type ContrastWord = { word: string; meaning: string; rule: string; example: string };
export type ContrastGroup = {
  id: string;
  title: string;
  note: string;
  words: ContrastWord[];
  questions: Array<{ id: string; sentence: string; options: string[] }>;
  recommendation: string;
  practiced: boolean;
};
export type ContrastResult = {
  id: string;
  groupId: string;
  correctCount: number;
  total: number;
  results: Array<{
    questionId: string;
    selected: string;
    answer: string;
    correct: boolean;
    explanation: string;
  }>;
};
export type WeeklyPrescription = {
  weekStart: string;
  weekEnd: string;
  evidenceStart: string;
  evidenceEnd: string;
  summary: {
    attempts: number;
    accuracy: number | null;
    dueReviews: number;
    weaknesses: number;
    outputs: number;
    contrasts: number;
    activeDays: number;
  };
  actions: Array<{
    id: string;
    title: string;
    reason: string;
    instruction: string;
    minutes: number;
    href: string;
  }>;
};
