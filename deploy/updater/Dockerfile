ARG DOCKER_CLI_IMAGE=docker:27.5.1-cli
FROM ${DOCKER_CLI_IMAGE}
RUN apk add --no-cache nodejs git curl postgresql-client
WORKDIR /opt/updater
COPY deploy/updater/core.mjs deploy/updater/server.mjs ./
CMD ["node", "server.mjs"]
