ARG NODE_IMAGE=node:22.14.0-bookworm-slim
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/types/package.json packages/types/package.json
RUN --mount=type=cache,id=lexloop-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
ARG APP_VERSION=development
ARG APP_COMMIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
ENV APP_BUILD_TIME=$APP_BUILD_TIME
RUN pnpm --filter @lexloop/api prisma:generate && \
    pnpm --filter @lexloop/web build && \
    pnpm --filter @lexloop/api build && \
    pnpm --filter @lexloop/worker build

FROM ${NODE_IMAGE} AS web
ARG APP_VERSION
ARG APP_COMMIT_SHA
ARG APP_BUILD_TIME
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
ENV APP_BUILD_TIME=$APP_BUILD_TIME
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$APP_COMMIT_SHA \
      org.opencontainers.image.created=$APP_BUILD_TIME
WORKDIR /app
COPY --from=build /workspace/apps/web/.next/standalone ./
COPY --from=build /workspace/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM ${NODE_IMAGE} AS api
ARG APP_VERSION
ARG APP_COMMIT_SHA
ARG APP_BUILD_TIME
ENV NODE_ENV=production
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
ENV APP_BUILD_TIME=$APP_BUILD_TIME
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$APP_COMMIT_SHA \
      org.opencontainers.image.created=$APP_BUILD_TIME
WORKDIR /workspace/apps/api
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/apps/api/node_modules ./node_modules
COPY --from=build /workspace/apps/api/dist ./dist
COPY --from=build /workspace/apps/api/package.json ./package.json
EXPOSE 52101
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS worker
ARG APP_VERSION
ARG APP_COMMIT_SHA
ARG APP_BUILD_TIME
ENV NODE_ENV=production
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
ENV APP_BUILD_TIME=$APP_BUILD_TIME
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$APP_COMMIT_SHA \
      org.opencontainers.image.created=$APP_BUILD_TIME
WORKDIR /workspace/apps/worker
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/apps/worker/node_modules ./node_modules
COPY --from=build /workspace/apps/worker/dist ./dist
COPY --from=build /workspace/apps/worker/package.json ./package.json
CMD ["node", "dist/main.js"]

FROM build AS migrate
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@lexloop/api", "exec", "prisma", "migrate", "deploy"]
