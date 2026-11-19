// Kullanıcılar, oturumlar ve auth middleware'i.
// Şifre hash'leme src/password.js'te (Argon2id); e-posta token'ları src/email-tokens.js'te.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.js';
import { hashPassword } from './password.js';

/** @typedef {import('./db.js').Db} Db */

export const SESSION_DAYS = 30;

// ---- Token yardımcıları -------------------------------------------------------

const newToken = () => randomBytes(32).toString('base64url'); // 256 bit
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---- Oturum çerezi ---------------------------------------------------------------

/**
 * Ortama göre oturum çerezi ayarları.
 *   Geliştirme (http://localhost): ita_session; HttpOnly; SameSite=Lax; Path=/
 *   Canlı (HTTPS):                 __Host-ita_session; HttpOnly; Secure; SameSite=Lax; Path=/
 *     __Host- öneki tarayıcıya çerezin yalnızca HTTPS'te, bu alan adına (alt alan adı yok) ve Path=/ ile
 *     ayarlanabileceğini zorunlu kılar.
 * @param {{ isProduction: boolean, cookieSameSite?: 'lax'|'strict'|'none' }} config
 */
export function sessionCookie({ isProduction, cookieSameSite = 'lax' }) {
  const base = { httpOnly: true, secure: isProduction, sameSite: cookieSameSite, path: '/' };
  return {
    name: isProduction ? '__Host-ita_session' : 'ita_session',
    /** @param {Date} [expires] */
    options: (expires) => (expires ? { ...base, expires } : { ...base }),
  };
}

// ---- Kullanıcılar --------------------------------------------------------------

export const normalizeEmail = (email) => email.trim().toLowerCase();

/** API'ye dönen kullanıcı — passwordHash ASLA dönmez. `name`, arayüzle uyumluluk için username'in takma adıdır. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
  };
}

/** @param {Db} db */
export function findUserByEmail(db, email) {
  return db.user.findUnique({ where: { email: normalizeEmail(email) } });
}

/** @param {Db} db */
export function findUserById(db, id) {
  return db.user.findUnique({ where: { id } });
}

/** @param {Db} db  Yeni hesap her zaman doğrulanmamış (emailVerified=false) oluşturulur. E-posta kayıtlıysa P2002 fırlatır. */
export async function createUser(db, { username, email, password }) {
  return db.user.create({
    data: { username: username.trim(), email: normalizeEmail(email), passwordHash: await hashPassword(password), emailVerified: false },
  });
}

// ---- Oturumlar ----------------------------------------------------------------
// Çerezde rastgele token, veritabanında yalnızca SHA-256 özeti tutulur (veritabanı sızsa da oturum çalınamaz).

/** @param {Db} db */
export async function createSession(db, userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt: expires } });
  return { token, expires };
}

/** @param {Db} db */
export async function getSessionUser(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const session = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date()) return null;
  return session.user;
}

/** @param {Db} db */
export async function deleteSession(db, token) {
  if (token) await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

/** @param {Db} db */
export async function deleteUserSessions(db, userId) {
  await db.session.deleteMany({ where: { userId } });
}

/** Süresi dolmuş oturumları temizler. @param {Db} db */
export async function purgeExpiredSessions(db) {
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

// ---- Middleware ------------------------------------------------------------------

/** Çerezdeki oturumu çözer: req.user (veya null) ve req.sessionToken. @param {Db} db */
export function loadUser(db, cookieName) {
  return async (req, _res, next) => {
    req.sessionToken = req.cookies?.[cookieName] || null;
    req.user = await getSessionUser(db, req.sessionToken);
    next();
  };
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Bu işlem için giriş yapmalısınız.', 'UNAUTHENTICATED'));
  next();
}
