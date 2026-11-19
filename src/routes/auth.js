// /api/auth — kayıt, giriş, çıkış, oturum bilgisi, e-posta doğrulama, şifre sıfırlama.
//
// E-posta gönderimi bu dosyada yapılmaz: doğrulama için `verification` servisi (src/verification.js),
// şifre sıfırlama için `email` servisi (src/email/service.js) çağrılır.
//
// Hata kodları: VALIDATION_ERROR (400), EMAIL_TAKEN (409), INVALID_CREDENTIALS (401), UNAUTHENTICATED (401),
//               INVALID_TOKEN (400), RATE_LIMITED (429), EMAIL_SEND_FAILED (502)
import { Router } from 'express';
import { z } from 'zod';
import {
  createSession,
  createUser,
  deleteSession,
  deleteUserSessions,
  findUserByEmail,
  findUserById,
  publicUser,
  purgeExpiredSessions,
  requireAuth,
} from '../auth.js';
import { EmailSendError } from '../email/service.js';
import { consumeEmailToken, createEmailToken, peekEmailToken } from '../email-tokens.js';
import { HttpError, validate } from '../http.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../password.js';
import { weakPasswordReason } from '../password-policy.js';

const RESET_TTL_MIN = 60; // 1 saat

// ---- Doğrulama şemaları ----------------------------------------------------------

const emailField = z
  .string({ error: 'E-posta zorunludur.' })
  .trim()
  .toLowerCase()
  .max(254, 'E-posta adresi çok uzun.')
  .email('Geçerli bir e-posta adresi girin.');
const passwordField = z
  .string({ error: 'Şifre zorunludur.' })
  .min(8, 'Şifre en az 8 karakter olmalı.')
  .max(128, 'Şifre en fazla 128 karakter olabilir.')
  .refine((p) => p.trim().length > 0, 'Şifre yalnızca boşluktan oluşamaz.');
const usernameField = z
  .string({ error: 'Kullanıcı adı metin olmalı.' })
  .trim()
  .min(2, 'Kullanıcı adı en az 2 karakter olmalı.')
  .max(50, 'Kullanıcı adı en fazla 50 karakter olabilir.')
  .refine((s) => !/[<>\u0000-\u001f]/.test(s), 'Kullanıcı adı geçersiz karakter içeriyor.');

// Arayüzün kayıt formu "name" alanını gönderir; API "username" alanını da kabul eder.
const RegisterSchema = z
  .object({ username: usernameField.optional(), name: usernameField.optional(), email: emailField, password: passwordField })
  .transform(({ username, name, ...rest }) => ({ ...rest, username: username ?? name }))
  .refine((d) => Boolean(d.username), { message: 'Kullanıcı adı zorunludur.', path: ['username'] })
  .superRefine((d, ctx) => {
    const reason = weakPasswordReason(d.password, { email: d.email, username: d.username });
    if (reason) ctx.addIssue({ code: 'custom', message: reason, path: ['password'] });
  });
const LoginSchema = z.object({
  email: emailField,
  password: z.string({ error: 'Şifre zorunludur.' }).min(1, 'Şifre zorunludur.').max(128, 'E-posta veya şifre hatalı.'),
});
const TokenSchema = z.object({
  token: z.string({ error: 'Bağlantı geçersiz.' }).min(20, 'Bağlantı geçersiz.').max(200, 'Bağlantı geçersiz.'),
});
const ForgotSchema = z.object({ email: emailField });
const ResetSchema = TokenSchema.extend({ password: passwordField });

/**
 * @param {object} deps
 * @param {import('../db.js').Db} deps.db
 * @param {ReturnType<typeof import('../email/service.js').createEmailService>} deps.email
 * @param {ReturnType<typeof import('../verification.js').createVerificationService>} deps.verification
 * @param {import('express').RequestHandler} deps.limiter        IP başına (kayıt/giriş/şifre uçları)
 * @param {import('express').RequestHandler} deps.resendLimiter  kullanıcı başına (doğrulama e-postasını tekrar gönder)
 * @param {import('express').RequestHandler} deps.loginAccountLimiter  e-posta (hesap) başına başarısız giriş sınırı
 * @param {{ name: string, options: (expires?: Date) => object }} deps.cookie
 */
export function authRouter({ db, email, verification, limiter, resendLimiter, loginAccountLimiter, cookie }) {
  const r = Router();

  // Kimlik bilgisi içeren yanıtlar önbelleğe alınmasın
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** Yeni oturum açar; bu tarayıcının önceki oturumu (varsa) sunucuda da kapatılır. */
  async function startSession(req, res, userId) {
    if (req.sessionToken) await deleteSession(db, req.sessionToken);
    const { token, expires } = await createSession(db, userId);
    res.cookie(cookie.name, token, cookie.options(expires));
  }

  // ---- POST /api/auth/register ----
  r.post('/register', limiter, async (req, res) => {
    const data = validate(RegisterSchema, req.body);
    const emailTaken = () => new HttpError(409, 'Bu e-posta adresiyle kayıtlı bir hesap zaten var.', 'EMAIL_TAKEN', { email: 'Bu e-posta zaten kayıtlı.' });

    if (await findUserByEmail(db, data.email)) throw emailTaken();
    let user;
    try {
      user = await createUser(db, data); // emailVerified = false
    } catch (err) {
      if (err?.code === 'P2002') throw emailTaken(); // aynı anda iki kayıt: veritabanının unique kısıtı yakalar
      throw err;
    }
    await startSession(req, res, user.id);
    // Hesap oluştu; doğrulama e-postasının sonucu ayrıca ve dürüstçe bildirilir (hata olsa da kayıt geçerlidir)
    const verificationEmail = await verification.send(user);
    res.status(201).json({ user: publicUser(user), verificationEmail });
  });

  // ---- POST /api/auth/login ----
  r.post('/login', limiter, loginAccountLimiter, async (req, res) => {
    const data = validate(LoginSchema, req.body);
    const user = await findUserByEmail(db, data.email);
    let result = { ok: false, needsRehash: false };
    if (user) result = await verifyPassword(data.password, user.passwordHash);
    else await burnPasswordCheck(data.password);
    // Kullanıcı yok / şifre yanlış ayrımı yapılmaz
    if (!result.ok) throw new HttpError(401, 'E-posta veya şifre hatalı.', 'INVALID_CREDENTIALS');

    if (result.needsRehash) {
      // Eski (scrypt) veya eski parametreli hash → güncel Argon2id'ye yükselt
      await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(data.password) } });
    }
    await purgeExpiredSessions(db);
    await startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  });

  // ---- POST /api/auth/logout ----
  r.post('/logout', async (req, res) => {
    await deleteSession(db, req.sessionToken); // oturum sunucuda da silinir; eski çerez artık geçersiz
    res.clearCookie(cookie.name, cookie.options());
    res.json({ ok: true });
  });

  // ---- GET /api/auth/me ----
  r.get('/me', (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  // ---- POST /api/auth/verify-email  { token } ----
  // Bağlantı GET ile doğrudan doğrulama yapmaz: e-posta tarayıcıları/antivirüsler bağlantıları önceden açıp
  // tek kullanımlık token'ı tüketebilir. Sayfa (#verify=...) token'ı bu uca POST eder.
  r.post('/verify-email', limiter, async (req, res) => {
    const { token } = validate(TokenSchema, req.body);
    const user = await verification.verify(token);
    if (!user) throw new HttpError(400, 'Doğrulama bağlantısı geçersiz, süresi dolmuş veya daha önce kullanılmış.', 'INVALID_TOKEN');
    res.json({ user: publicUser(user) });
  });

  // ---- POST /api/auth/resend-verification ----
  r.post('/resend-verification', requireAuth, resendLimiter, async (req, res) => {
    if (req.user.emailVerified) return res.json({ ok: true, alreadyVerified: true, sent: false });

    const wait = await verification.cooldownRemaining(req.user.id);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      throw new HttpError(429, `Yeni doğrulama e-postası için ${wait} saniye bekleyin.`, 'RATE_LIMITED');
    }
    const result = await verification.send(req.user);
    if (result.error) {
      // Sağlayıcı hata döndürdü → "gönderildi" denmez
      throw new HttpError(502, 'Doğrulama e-postası şu anda gönderilemedi. Lütfen biraz sonra tekrar deneyin.', 'EMAIL_SEND_FAILED');
    }
    res.json({ ok: true, sent: result.sent, delivery: result.delivery });
  });

  // ---- Şifre sıfırlama ----
  r.post('/forgot-password', limiter, async (req, res) => {
    const { email: address } = validate(ForgotSchema, req.body);
    const user = await findUserByEmail(db, address);
    if (user) {
      const { token } = await createEmailToken(db, user.id, 'reset', RESET_TTL_MIN);
      try {
        await email.sendPasswordReset({ to: user.email, username: user.username, token, expiresInMinutes: RESET_TTL_MIN });
      } catch (err) {
        if (!(err instanceof EmailSendError)) throw err;
        console.error(`[e-posta] Şifre sıfırlama e-postası gönderilemedi (kullanıcı ${user.id}): ${err.message}`);
      }
    }
    // Hesabın var olup olmadığını belli etmemek için her durumda aynı yanıt (gönderildi iddiası yok)
    res.json({ ok: true });
  });

  r.post('/reset-password', limiter, async (req, res) => {
    const { token, password } = validate(ResetSchema, req.body);
    const invalid = () => new HttpError(400, 'Sıfırlama bağlantısı geçersiz, süresi dolmuş veya daha önce kullanılmış.', 'INVALID_TOKEN');
    // Önce token'ı tüketmeden kontrol et: şifre politikaya uymazsa bağlantı boşa harcanmasın
    const pending = await peekEmailToken(db, token, 'reset');
    if (!pending) throw invalid();
    const owner = await findUserById(db, pending.userId);
    const reason = owner && weakPasswordReason(password, { email: owner.email, username: owner.username });
    if (reason) throw new HttpError(400, reason, 'VALIDATION_ERROR', { password: reason });

    const userId = await consumeEmailToken(db, token, 'reset');
    if (!userId) throw invalid();
    // Bağlantı e-postaya gittiği için adres de doğrulanmış sayılır
    await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password), emailVerified: true } });
    await deleteUserSessions(db, userId); // diğer cihazlardaki oturumları kapat
    await startSession(req, res, userId);
    res.json({ user: publicUser(await findUserById(db, userId)) });
  });

  return r;
}
