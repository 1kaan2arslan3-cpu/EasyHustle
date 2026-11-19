// E-posta doğrulama akışı: token üret → e-posta servisiyle gönder → bağlantıdaki token'ı doğrula.
// Kimlik doğrulama route'ları yalnızca bu servisi çağırır; e-postanın nasıl gönderildiğini bilmez.
import { EmailSendError } from './email/service.js';
import { consumeEmailToken, createEmailToken, lastEmailTokenAt } from './email-tokens.js';

/**
 * @param {{ db: import('./db.js').Db, email: ReturnType<typeof import('./email/service.js').createEmailService>,
 *           ttlHours: number, cooldownSeconds?: number }} deps
 */
export function createVerificationService({ db, email, ttlHours, cooldownSeconds = 60 }) {
  return {
    ttlHours,
    cooldownSeconds,

    /**
     * Yeni doğrulama token'ı üretir ve e-postayı gönderir. Gönderim hatası fırlatılmaz, sonuçta bildirilir:
     * @returns {Promise<{ sent: boolean, delivery: string, error?: string, retryable?: boolean }>}
     */
    async send(user) {
      const { token } = await createEmailToken(db, user.id, 'verify', ttlHours * 60);
      try {
        const r = await email.sendVerification({ to: user.email, username: user.username, token, expiresInHours: ttlHours });
        return { sent: r.sent, delivery: r.delivery };
      } catch (err) {
        if (!(err instanceof EmailSendError)) throw err;
        console.error(`[e-posta] Doğrulama e-postası gönderilemedi (kullanıcı ${user.id}): ${err.message}`);
        return { sent: false, delivery: email.providerName, error: 'Doğrulama e-postası gönderilemedi.', retryable: err.retryable };
      }
    },

    /** Son gönderimden bu yana bekleme süresi dolmadıysa kalan saniye; dolduysa 0. */
    async cooldownRemaining(userId) {
      const last = await lastEmailTokenAt(db, userId, 'verify');
      if (!last) return 0;
      const remaining = Math.ceil((last.getTime() + cooldownSeconds * 1000 - Date.now()) / 1000);
      return Math.max(0, remaining);
    },

    /**
     * Token'ı doğrular: geçerliyse kullanıcıyı doğrulanmış işaretler ve kalan doğrulama token'larını geçersiz kılar.
     * Süresi dolmuş, kullanılmış, başka türde veya uydurma token'larda null döner.
     */
    async verify(token) {
      const userId = await consumeEmailToken(db, token, 'verify');
      if (!userId) return null;
      const [user] = await db.$transaction([
        db.user.update({ where: { id: userId }, data: { emailVerified: true } }),
        db.emailToken.updateMany({ where: { userId, type: 'verify', usedAt: null }, data: { usedAt: new Date() } }),
      ]);
      return user;
    },
  };
}
