// Ortak HTTP yardımcıları ve merkezi hata yönetimi.
//
// Tüm hata yanıtları aynı biçimdedir:
//   { "error": "Kullanıcıya gösterilebilir Türkçe mesaj", "code": "MAKINE_KODU", "fields"?: { alan: "mesaj" } }
// `error` her zaman metindir (arayüz bunu doğrudan gösterir); `code` istemcinin mantık kurması içindir;
// `fields` yalnızca doğrulama hatalarında, hangi alanın neden geçersiz olduğunu söyler.

const DEFAULT_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'UPSTREAM_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [code]
   * @param {Record<string,string>} [fields]
   */
  constructor(status, message, code, fields) {
    super(message);
    this.status = status;
    this.code = code || DEFAULT_CODES[status] || 'ERROR';
    this.fields = fields;
  }
}

/** Standart hata gövdesi. */
export function errorBody(status, message, code, fields) {
  return { error: message, code: code || DEFAULT_CODES[status] || 'ERROR', ...(fields ? { fields } : {}) };
}

/** zod şemasıyla doğrular; hata varsa alan bazlı mesajlarla 400 VALIDATION_ERROR fırlatır. */
export function validate(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  const first = result.error.issues[0]?.message || 'Geçersiz istek.';
  throw new HttpError(400, first, 'VALIDATION_ERROR', fields);
}

/** Tanımsız API uçları için JSON 404. */
export function notFound(_req, res) {
  res.status(404).json(errorBody(404, 'İstenen API ucu bulunamadı.', 'NOT_FOUND'));
}

/**
 * Merkezi hata yöneticisi. Beklenmeyen hataların ayrıntısı yalnızca sunucu günlüğüne yazılır, istemciye sızdırılmaz.
 * Express 5 async route'lardaki reddedilen promise'leri otomatik olarak buraya iletir.
 */
export function errorHandler({ isProduction }) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (res.headersSent) return req.socket.destroy();

    let status = 500;
    let message = 'Sunucu hatası. Lütfen tekrar deneyin.';
    let code;
    let fields;
    if (err instanceof HttpError) {
      ({ status, message, code, fields } = err);
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      message = 'Geçersiz JSON.';
      code = 'INVALID_JSON';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      message = 'İstek çok büyük.';
    } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      status = err.status;
      message = err.expose && err.message ? err.message : 'Geçersiz istek.';
    }

    if (status >= 500) {
      // Beklenen (HttpError) hatalarda yalnızca mesaj; beklenmeyenlerde geliştirmede tam yığın
      console.error(`[hata] ${req.method} ${req.originalUrl}`, isProduction || err instanceof HttpError ? `${status} ${err?.message}` : err);
    }
    res.status(status).json(errorBody(status, message, code, fields));
  };
}
