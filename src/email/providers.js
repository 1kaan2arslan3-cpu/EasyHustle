// E-posta sağlayıcıları. Hepsi aynı arayüzü uygular:
//   { name, delivers, send({ from, to, subject, html, text, replyTo, idempotencyKey }) → Promise<{ id }> }
//   delivers: true → e-posta gerçekten gönderilir. Hata durumunda EmailSendError fırlatılır (asla "gönderildi" denmez).

export class EmailSendError extends Error {
  /** @param {string} message  @param {{ status?: number, providerCode?: string, retryable?: boolean }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'EmailSendError';
    this.status = info.status ?? null;
    this.providerCode = info.providerCode ?? null;
    this.retryable = info.retryable ?? false;
  }
}

/**
 * Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 * Resend SDK yerine doğrudan fetch kullanılır: ek bağımlılık yok, tek bir uç nokta yeterli.
 * @param {{ apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function createResendProvider({ apiKey, baseUrl = 'https://api.resend.com', fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!apiKey) throw new Error('Resend API anahtarı gerekli.');
  return {
    name: 'resend',
    delivers: true,
    async send({ from, to, subject, html, text, replyTo, idempotencyKey }) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new EmailSendError(timedOut ? 'E-posta servisi zamanında yanıt vermedi.' : 'E-posta servisine bağlanılamadı.', { retryable: true });
      }

      let body = null;
      try {
        body = await res.json();
      } catch {
        /* gövde JSON değil */
      }
      if (!res.ok || !body?.id) {
        // Sağlayıcının mesajı günlüğe yazılabilir; API anahtarı hiçbir zaman mesajda yer almaz.
        const providerMessage = typeof body?.message === 'string' ? body.message.slice(0, 300) : `HTTP ${res.status}`;
        throw new EmailSendError(`E-posta servisi hata döndürdü: ${providerMessage}`, {
          status: res.status,
          providerCode: body?.name ?? null,
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      return { id: body.id };
    },
  };
}

/**
 * E-posta servisi tanımlı değilken: e-posta gönderilmez.
 *   Geliştirme: içerik (doğrulama/sıfırlama bağlantıları dahil) konsola yazılır, böylece akış denenebilir.
 *   Canlı (redact: true): yalnızca "gönderilmedi" kaydı düşülür — tek kullanımlık token'lar günlüklere sızmaz.
 */
export function createConsoleProvider({ log = console.log, redact = false } = {}) {
  return {
    name: 'console',
    delivers: false,
    async send({ to, subject, text }) {
      if (redact) {
        log(`[e-posta] GÖNDERİLMEDİ (e-posta servisi tanımlı değil) — konu: "${subject}"`);
      } else {
        log(`\n[e-posta · geliştirme modu, GÖNDERİLMEDİ]\nKime: ${to}\nKonu: ${subject}\n\n${text}\n`);
      }
      return { id: null };
    },
  };
}

/** Testler: gönderilen e-postaları bellekte tutar; fail() ile bir sonraki gönderim hata verdirilebilir. */
export function createMemoryProvider() {
  const sent = [];
  let failNext = null;
  return {
    name: 'memory',
    delivers: true,
    sent,
    fail(error = new EmailSendError('Test: sağlayıcı hatası', { status: 500 })) {
      failNext = error;
    },
    async send(msg) {
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      sent.push(msg);
      return { id: `mem-${sent.length}` };
    },
  };
}
