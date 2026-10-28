export type StudySequenceWordStatus = { completed?: boolean };

export function studyGroupCompletion(
  groups: ReadonlyArray<ReadonlyArray<StudySequenceWordStatus>>,
) {
  const completedGroups = groups.map(
    (group) => group.length > 0 && group.every((word) => word.completed),
  );
  return {
    completedGroups,
    currentGroupIndex: completedGroups.findIndex((completed) => !completed),
  };
}
