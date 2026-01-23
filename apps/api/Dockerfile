FROM node:20-slim

WORKDIR /app

# Prisma engines commonly need OpenSSL available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies (workspace-aware) with good cache behavior
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/logger/package.json packages/logger/package.json
RUN npm ci

# Copy source and build
COPY packages/db/prisma packages/db/prisma
COPY packages/logger packages/logger
COPY apps/api apps/api
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
RUN npm run build -w packages/logger
RUN npm run build -w apps/api

ENV NODE_ENV=production
ENV API_PORT=3001

EXPOSE 3001

CMD ["npm","run","start","-w","apps/api"]
