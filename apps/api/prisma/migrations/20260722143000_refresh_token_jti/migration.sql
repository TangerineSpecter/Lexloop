ALTER TABLE "RefreshToken" ADD COLUMN "tokenId" TEXT;

UPDATE "RefreshToken" SET "tokenId" = "id" WHERE "tokenId" IS NULL;

ALTER TABLE "RefreshToken" ALTER COLUMN "tokenId" SET NOT NULL;
CREATE UNIQUE INDEX "RefreshToken_tokenId_key" ON "RefreshToken"("tokenId");
