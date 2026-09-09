FROM dyc3/opentogethertube@sha256:feec95f418e7d438b632bb05311bfa522d5e40f13d019e2146216a49e5b53d93

ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.version="v0.15.0-cn6"
LABEL org.opencontainers.image.source="https://github.com/g1157/opentogethertube-cn"
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT

WORKDIR /app
COPY --chown=node:node server /app/server
COPY --chown=node:node common /app/common
COPY --chown=node:node deploy/import-room-state.mjs /app/server/import-room-state.mjs
COPY --chown=node:node client/dist /app/client/dist
USER node
WORKDIR /app/server
ENV NODE_ENV=production
ENV OTT_CLIENT_REVISION=$SOURCE_COMMIT
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s CMD curl -fsS http://localhost:8080/api/status || exit 1
CMD ["node", "--conditions=lean", "ts-out/app.js"]
