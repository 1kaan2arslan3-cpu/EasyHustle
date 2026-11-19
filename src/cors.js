// CORS: varsayılan olarak yalnızca aynı adres (frontend'i bu sunucu sunar, CORS gerekmez).
// Frontend başka bir adreste barındırılacaksa CORS_ORIGINS ile izin verilen adresler listelenir.

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type';

/** @param {string[]} allowedOrigins  Tam adresler, ör. ['https://app.ornek.com'] */
export function cors(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.append('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
        res.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.set('Access-Control-Max-Age', '600');
        return res.sendStatus(204);
      }
    } else if (req.method === 'OPTIONS' && origin) {
      // İzin verilmeyen adresten ön kontrol: CORS başlığı olmadan yanıtla, tarayıcı isteği engeller
      return res.sendStatus(204);
    }
    next();
  };
}

/**
 * Basit CSRF koruması: durum değiştiren isteklerde Origin başlığı varsa
 * ya sunucunun kendi adresi ya da CORS_ORIGINS listesinde olmalı.
 * (Oturum çerezi SameSite=Lax; ayrıca API yalnızca application/json kabul eder.)
 */
export function trustedOriginsOnly(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || allowed.has(origin)) return next();
    try {
      if (new URL(origin).host === req.get('host')) return next();
    } catch {
      /* geçersiz origin */
    }
    res.status(403).json({ error: 'Geçersiz istek kaynağı.', code: 'FORBIDDEN_ORIGIN' });
  };
}
