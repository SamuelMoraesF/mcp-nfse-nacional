FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci
COPY index.ts ./
COPY src/ ./src/

RUN npx tsc

# Production stage
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
RUN mkdir -p storage

CMD ["node", "--openssl-legacy-provider", "dist/index.js"]
