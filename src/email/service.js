// Yeniden kullanılabilir e-posta servisi: şablon + gönderen bilgisi + sağlayıcı.
// Kimlik doğrulama kodu e-postanın NASIL gönderildiğini bilmez; yalnızca bu servisi çağırır.
//
// Her gönderim { sent, delivery, id } döner:
//   sent: true     → sağlayıcı e-postayı kabul etti
//   sent: false    → geliştirme modu (delivery: 'console'), e-posta gönderilmedi
//   hata           → EmailSendError fırlatılır; çağıran taraf "gönderildi" demez
import { createConsoleProvider, createResendProvider, EmailSendError } from './providers.js';
import { passwordResetEmail, plainTextToHtml, verificationEmail } from './templates.js';

export { EmailSendError };

/**
 * @param {{ provider: { name: string, delivers: boolean, send: Function }, from: string, replyTo?: string|null, appUrl: string, appName: string }} opts
 */
export function createEmailService({ provider, from, replyTo = null, appUrl, appName }) {
  async function deliver(msg) {
    const { id } = await provider.send({ ...msg, from, replyTo: msg.replyTo || replyTo || undefined });
    return { sent: provider.delivers, delivery: provider.name, id };
  }

  return {
    /** E-postalar gerçekten gönderiliyor mu (false: geliştirme modu, konsola yazılır) */
    get delivers() {
      return provider.delivers;
    },
    get providerName() {
      return provider.name;
    },

    /** @param {{ to: string, username: string, token: string, expiresInHours: number, idempotencyKey?: string }} p */
    sendVerification({ to, username, token, expiresInHours, idempotencyKey }) {
      // Token URL'nin hash (#) kısmında: sunucu günlüklerine ve Referer başlığına düşmez,
      // e-posta tarayıcı/antivirüs ön-yüklemeleri (GET) token'ı tüketemez — doğrulama sayfadaki POST ile yapılır.
      const url = `${appUrl}/#verify=${encodeURIComponent(token)}`;
      return deliver({ to, idempotencyKey, ...verificationEmail({ appName, username, email: to, url, expiresInHours }) });
    },

    /** @param {{ to: string, username: string, token: string, expiresInMinutes: number }} p */
    sendPasswordReset({ to, username, token, expiresInMinutes }) {
      const url = `${appUrl}/#reset=${encodeURIComponent(token)}`;
      return deliver({ to, ...passwordResetEmail({ appName, username, email: to, url, expiresInMinutes }) });
    },

    /** Kullanıcının yazdığı düz metin e-posta (teklif). */
    sendPlain({ to, subject, text, replyTo: reply }) {
      return deliver({ to, subject, text, html: plainTextToHtml(text), replyTo: reply });
    },
  };
}

/** Yapılandırmadan servis: RESEND_API_KEY varsa Resend, yoksa geliştirme (konsol) modu. */
export function createEmailServiceFromConfig(config) {
  const { resendApiKey, resendApiUrl, from, replyTo } = config.email;
  const provider = resendApiKey
    ? createResendProvider({ apiKey: resendApiKey, baseUrl: resendApiUrl })
    : createConsoleProvider({ redact: config.isProduction }); // canlıda token'lar günlüğe yazılmaz
  return createEmailService({ provider, from, replyTo, appUrl: config.appUrl, appName: config.appName });
}
