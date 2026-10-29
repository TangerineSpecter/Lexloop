CREATE INDEX "StudyPlan_userId_status_completedAt_id_idx"
ON "StudyPlan"("userId", "status", "completedAt", "id");

CREATE INDEX "AssessmentAttempt_userId_status_completedAt_id_idx"
ON "AssessmentAttempt"("userId", "status", "completedAt", "id");
