FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace root (needed for npm workspaces)
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/

RUN npm ci --workspace=packages/server

COPY packages/server ./packages/server

RUN npm run build --workspace=packages/server

# ---------------------------------------------------------------------------

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/

RUN npm ci --workspace=packages/server --omit=dev

COPY --from=builder /app/packages/server/dist ./packages/server/dist

EXPOSE 3000

CMD ["node", "packages/server/dist/index.js"]
