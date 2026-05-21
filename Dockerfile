FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/next.config.* ./

EXPOSE 3000

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DEMO_ADAPTER_PORT=18789 \
    UPSTREAM_ALLOWLIST=localhost

CMD ["dumb-init", "node", "server/index.js"]
