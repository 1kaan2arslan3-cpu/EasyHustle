# EasyHustle — üretim imajı (Railway ve Docker çalıştıran her ortam için)
# Node 24 (LTS): yerleşik Argon2id ve TypeScript tip ayıklama için >= 24.7 gerekir.

# ---- 1) Bağımlılıklar: yerel modüller (better-sqlite3) ve Prisma istemcisi burada derlenir ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
# better-sqlite3 için hazır ikili yoksa kaynaktan derlemek gerekir; Prisma şema motoru OpenSSL ister
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# postinstall (prisma generate) şemaya ve yapılandırmaya ihtiyaç duyar
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
COPY src/database-url.js ./src/database-url.js
RUN npm ci --omit=dev --no-audit --no-fund

# ---- 2) Çalışma imajı: derleme araçları olmadan ----
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/src/generated ./src/generated
COPY . .
EXPOSE 3000
# Bekleyen migration'ları uygular, sonra sunucuyu canlı modda başlatır (PORT'u platform verir)
CMD ["npm", "run", "start:prod"]
