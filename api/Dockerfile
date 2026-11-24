# Rebound API image. Build from the REPO ROOT (it bundles the data scripts):
#   docker build -f api/Dockerfile -t rebound-api .
# Contains the Postgres client + AWS CLI (process executor, local dev) and kubectl + envsubst
# (kubernetes executor, which runs jobs/backup-restore/k8s/rebound-data.sh in the cluster).
FROM node:20-alpine

ARG PG_MAJOR=16
ARG KUBECTL_VERSION=v1.34.1
ARG TARGETARCH=amd64

RUN apk add --no-cache bash jq coreutils gettext curl aws-cli "postgresql${PG_MAJOR}-client" \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c - \
 && chmod +x /usr/local/bin/kubectl

ENV NODE_ENV=production PORT=8080 JOBS_DIR=/jobs DEPLOY_SCRIPT=/deploy/deploy-app.sh
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api/src ./src
COPY jobs/backup-restore /jobs
COPY deploy /deploy

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "src/server.js"]
