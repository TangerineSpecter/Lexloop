ALTER TABLE "AiModelConfig"
ADD COLUMN "temperature" DOUBLE PRECISION;

ALTER TABLE "AiModelConfig"
ADD CONSTRAINT "AiModelConfig_temperature_range"
CHECK ("temperature" IS NULL OR ("temperature" >= 0 AND "temperature" <= 2));
