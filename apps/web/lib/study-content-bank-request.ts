export type StudyContentBankRequestIdentity = {
  sequence: number;
  userId: string;
  accessToken: string;
};

export function isCurrentStudyContentBankRequest(
  request: StudyContentBankRequestIdentity,
  current: StudyContentBankRequestIdentity,
) {
  return (
    request.sequence === current.sequence &&
    request.userId === current.userId &&
    request.accessToken === current.accessToken
  );
}
