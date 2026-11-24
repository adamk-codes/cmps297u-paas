# Production image for notes-app. Built by CI (test -> build -> scan -> push to ECR).
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Install only production dependencies, using the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Image version is baked in at build time so the app (and backups) can report it.
ARG IMAGE_TAG=dev
ENV IMAGE_TAG=${IMAGE_TAG}

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "src/server.js"]
