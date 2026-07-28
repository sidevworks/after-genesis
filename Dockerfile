FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cognition/package.json packages/cognition/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY apps/genesis/package.json apps/genesis/package.json
COPY apps/spectator/package.json apps/spectator/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --omit=dev --workspace=@after-genesis/worker --include-workspace-root=false

COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/worker apps/worker

USER node
CMD ["npm", "run", "start", "--workspace=@after-genesis/worker"]
