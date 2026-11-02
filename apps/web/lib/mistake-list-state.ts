export type MistakeStatus = 'active' | 'ignored' | 'resolved';

export type MistakeListState = {
  status: MistakeStatus;
  questionType: string;
  search: string;
  page: number;
};

export const DEFAULT_MISTAKE_LIST_STATE: MistakeListState = {
  status: 'active',
  questionType: '',
  search: '',
  page: 1,
};
