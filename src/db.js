// Veritabanı bağlantısı (Prisma). Adaptör, DATABASE_URL'e göre seçilir:
//   file:...          → SQLite (@prisma/adapter-better-sqlite3)
//   postgresql://...  → PostgreSQL (@prisma/adapter-pg — geçişte kurulur, bkz. prisma/schema.prisma)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from './generated/prisma/client.ts';
import { sqliteFilePath } from './database-url.js';

/** @typedef {InstanceType<typeof PrismaClient>} Db */

async function createAdapter(url) {
  const file = sqliteFilePath(url);
  if (file !== null) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const { PrismaBetterSqlite3 } = await import('@prisma/adapter-better-sqlite3');
    return new PrismaBetterSqlite3({ url });
  }
  if (/^postgres(ql)?:\/\//i.test(url)) {
    let mod;
    try {
      mod = await import('@prisma/adapter-pg');
    } catch {
      throw new Error('PostgreSQL için adaptör kurulu değil: npm install @prisma/adapter-pg pg');
    }
    return new mod.PrismaPg({ connectionString: url });
  }
  throw new Error('DATABASE_URL "file:" (SQLite) veya "postgresql://" ile başlamalı.');
}

/** @param {string} url  resolveDatabaseUrl() ile normalleştirilmiş adres */
export async function createDb(url) {
  return new PrismaClient({ adapter: await createAdapter(url) });
}

/**
 * Bağlanır ve şemanın kurulu olduğunu doğrular. Geçici hatalarda birkaç kez yeniden dener
 * (ör. PostgreSQL sunucusu henüz ayağa kalkmamışsa).
 * @param {Db} db
 */
export async function connectDb(db, { retries = 5, delayMs = 1000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.$connect();
      await db.$queryRaw`SELECT 1`;
      break;
    } catch (err) {
      if (attempt >= retries) throw new Error(`Veritabanına bağlanılamadı: ${err.message}`);
      console.warn(`[veritabanı] Bağlantı denemesi ${attempt}/${retries} başarısız, tekrar deneniyor…`);
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  try {
    await db.user.findFirst({ select: { id: true } });
  } catch (err) {
    if (err?.code === 'P2021') {
      throw new Error('Veritabanı tabloları oluşturulmamış. Önce çalıştırın: npm run db:deploy');
    }
    throw err;
  }
}

/** Sağlık kontrolü için hafif sorgu. @param {Db} db */
export async function pingDb(db) {
  await db.$queryRaw`SELECT 1`;
}
