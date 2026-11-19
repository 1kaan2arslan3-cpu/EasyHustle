// Tek kullanımlık e-posta token'ları (doğrulama / şifre sıfırlama).
//   - 256 bit kriptografik rastgele değer (crypto.randomBytes), base64url
//   - Veritabanında yalnızca SHA-256 özeti saklanır; düz token yalnızca e-postadaki bağlantıda bulunur
//   - Süresi dolar (expiresAt), kullanılınca işaretlenir (usedAt), yeni token eskilerini geçersiz kılar
import { createHash, randomBytes } from 'node:crypto';

/** @typedef {import('./db.js').Db} Db */

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/**
 * Yeni token üretir; aynı kullanıcı ve türdeki kullanılmamış eski token'ları geçersiz kılar.
 * @param {Db} db  @param {'verify'|'reset'} type
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
export async function createEmailToken(db, userId, type, ttlMinutes) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 6e4);
  await db.$transaction([
    db.emailToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: now } }),
    db.emailToken.create({ data: { userId, type, tokenHash: hashToken(token), expiresAt } }),
  ]);
  return { token, expiresAt };
}

/**
 * Token geçerliyse (doğru tür, kullanılmamış, süresi dolmamış) kullanılmış işaretler ve userId döner; değilse null.
 * Koşullu updateMany sayesinde aynı token eşzamanlı iki istekte de yalnızca bir kez kabul edilir.
 * @param {Db} db  @param {'verify'|'reset'} type
 */
export async function consumeEmailToken(db, token, type) {
  if (typeof token !== 'string' || !token) return null;
  const now = new Date();
  const row = await db.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt <= now) return null;
  const { count } = await db.emailToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  return count === 1 ? row.userId : null;
}

/** Token'ı tüketmeden geçerliliğini kontrol eder; geçerliyse { userId } döner, değilse null. @param {Db} db */
export async function peekEmailToken(db, token, type) {
  if (typeof token !== 'string' || !token) return null;
  const row = await db.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt <= new Date()) return null;
  return { userId: row.userId };
}

/** Kullanıcının bu türdeki en son token'ının oluşturulma zamanı (bekleme süresi için). @param {Db} db */
export async function lastEmailTokenAt(db, userId, type) {
  const row = await db.emailToken.findFirst({ where: { userId, type }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return row?.createdAt ?? null;
}
