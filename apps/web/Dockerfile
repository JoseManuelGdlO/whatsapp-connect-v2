FROM node:20-slim

WORKDIR /app

# For TLS downloads during npm/prisma operations.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Build-time API URL for Vite (injected into the static bundle)
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

# Install dependencies (workspace-aware) with good cache behavior
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci

# Copy source and build
COPY apps/web apps/web
RUN npm run build -w apps/web

ENV NODE_ENV=production
ENV WEB_PORT=3000

EXPOSE 3000

CMD ["npm","run","start","-w","apps/web"]

