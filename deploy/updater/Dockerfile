ARG DOCKER_CLI_IMAGE=docker:27.5.1-cli
ARG NODE_IMAGE=node:22.14.0-bookworm-slim
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
WORKDIR /opt/updater
COPY deploy/updater/core.mjs deploy/updater/server.mjs ./
ENTRYPOINT []
CMD ["node", "server.mjs"]
