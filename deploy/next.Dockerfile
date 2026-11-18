ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app
# argon2 ships Linux N-API binaries; no compiler toolchain is needed in this stage.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases/yarn-4.1.0.cjs .yarn/releases/yarn-4.1.0.cjs
COPY .yarn/patches .yarn/patches
COPY server/package.json server/
COPY common/package.json common/
ENV YARN_ENABLE_IMMUTABLE_INSTALLS=true
RUN node .yarn/releases/yarn-4.1.0.cjs workspaces focus ott-server --production \
    && mkdir -p server/node_modules common/node_modules
COPY scripts/check-runtime-dependencies.mjs scripts/check-runtime-dependencies.mjs
RUN node scripts/check-runtime-dependencies.mjs

FROM dependencies AS application

COPY server/ts-out server/ts-out
COPY common/ts-out common/ts-out
COPY server/config server/config
COPY server/migrations server/migrations
COPY server/.sequelizerc server/.sequelizerc
COPY deploy/import-room-state.mjs server/import-room-state.mjs
COPY client/dist client/dist
COPY LICENSE UPSTREAM.md ./
# tsc also emits unit tests. Copy this cleaned tree into a fresh runtime layer.
RUN rm -rf server/ts-out/tests common/ts-out/tests .yarn .yarnrc.yml

FROM ${NODE_IMAGE} AS runtime

ARG SOURCE_COMMIT=unknown
ARG OTT_VERSION=dev
LABEL org.opencontainers.image.version=$OTT_VERSION
LABEL org.opencontainers.image.source="https://github.com/g1157/opentogethertube-cn"
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT

WORKDIR /app
ARG DEBIAN_MIRROR=http://deb.debian.org
# Bootstrap the system CA store through Debian's signed package indexes.
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o APT::Update::Error-Mode=any update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=application --chown=node:node /app /app
USER node
WORKDIR /app/server
ENV NODE_ENV=production
ENV FFPROBE_STRATEGY=run
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV OTT_CLIENT_REVISION=$SOURCE_COMMIT
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD curl -fsS http://localhost:8080/api/status || exit 1
CMD ["node", "--conditions=lean", "ts-out/app.js"]
