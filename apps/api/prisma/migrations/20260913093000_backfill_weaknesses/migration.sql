WITH mistake_groups AS (
  SELECT
    "userId",
    "bookWordId",
    "questionType",
    COUNT(*) FILTER (WHERE NOT "isCorrect")::INTEGER AS "wrongCount",
    MAX("createdAt") FILTER (WHERE NOT "isCorrect") AS "lastWrongAt",
    MAX("createdAt") AS "lastAttemptAt"
  FROM "WordReviewAttempt"
  WHERE "questionType" IS NOT NULL
  GROUP BY "userId", "bookWordId", "questionType"
  HAVING COUNT(*) FILTER (WHERE NOT "isCorrect") > 0
), with_streak AS (
  SELECT
    groups.*,
    COUNT(attempts."id") FILTER (
      WHERE attempts."isCorrect" AND attempts."createdAt" > groups."lastWrongAt"
    )::INTEGER AS "consecutiveCorrect"
  FROM mistake_groups groups
  LEFT JOIN "WordReviewAttempt" attempts
    ON attempts."userId" = groups."userId"
    AND attempts."bookWordId" = groups."bookWordId"
    AND attempts."questionType" = groups."questionType"
  GROUP BY groups."userId", groups."bookWordId", groups."questionType", groups."wrongCount", groups."lastWrongAt", groups."lastAttemptAt"
)
INSERT INTO "WeaknessSignal" (
  "id", "userId", "bookWordId", "questionType", "status", "wrongCount",
  "consecutiveCorrect", "lastWrongAt", "lastAttemptAt", "resolvedAt", "createdAt", "updatedAt"
)
SELECT
  'weak_' || md5("userId" || ':' || "bookWordId" || ':' || "questionType"),
  "userId", "bookWordId", "questionType",
  CASE WHEN "consecutiveCorrect" >= 2 THEN 'RESOLVED'::"WeaknessStatus" ELSE 'ACTIVE'::"WeaknessStatus" END,
  "wrongCount", "consecutiveCorrect", "lastWrongAt", "lastAttemptAt",
  CASE WHEN "consecutiveCorrect" >= 2 THEN "lastAttemptAt" ELSE NULL END,
  "lastWrongAt", CURRENT_TIMESTAMP
FROM with_streak
ON CONFLICT ("userId", "bookWordId", "questionType") DO NOTHING;
