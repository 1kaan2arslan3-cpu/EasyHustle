// Express uygulaması. Sunucuyu başlatma server.js'te; testler createApp'i doğrudan kullanır.
//
// Sorumluluk ayrımı:
//   public/        → frontend (statik dosyalar; derleme yok)
//   src/routes/    → API uçları (yalnızca JSON döner)
//   src/*.js       → yapılandırma, veritabanı, kimlik doğrulama, e-posta, AI servisleri
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadUser, sessionCookie } from './auth.js';
import { cors, trustedOriginsOnly } from './cors.js';
import { errorBody, errorHandler, notFound } from './http.js';
import { aiRouter } from './routes/ai.js';
import { authRouter } from './routes/auth.js';
import { dataRouter } from './routes/data.js';
import { healthRouter } from './routes/health.js';
import { createVerificationService } from './verification.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const catalog = JSON.parse(readFileSync(path.join(publicDir, 'data', 'catalog.json'), 'utf8'));

/**
 * @param {object} deps
 * @param {import('./db.js').Db} deps.db
 * @param {ReturnType<typeof import('./email/service.js').createEmailService>} deps.email
 * @param {ReturnType<import('./config.js').loadConfig>} deps.config
 * @param {{ auth?: number, send?: number, resend?: number, resendCooldownSeconds?: number, loginPerAccount?: number, ai?: number }} [deps.limits]
 *        auth/send: IP başına 15 dakikada; resend: kullanıcı başına saatte; resendCooldownSeconds: iki gönderim arası bekleme;
 *        loginPerAccount: hesap başına 15 dakikada başarısız giriş; ai: kullanıcı başına 15 dakikada analiz/taslak
 */
export function createApp({ db, email, config, limits = {} }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1); // ters vekil (nginx, Render, Railway vb.) arkasında gerçek IP için

  // ---- Genel ara katmanlar ----
  app.use(
    helmet({
      // localhost (http) üzerinde istekleri https'e yükseltmesin
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.isProduction ? [] : null } },
    }),
  );

  // ---- API ----
  const api = express.Router();
  api.use(cors(config.corsOrigins));
  api.use(trustedOriginsOnly(config.corsOrigins));
  api.use(express.json({ limit: '1mb' }));
  api.use(cookieParser());

  // IP başına, 15 dakikalık pencerede istek sınırı. Aşılınca 429 + Retry-After + RateLimit başlıkları.
  const limiter = (limit) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: errorBody(429, 'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.', 'RATE_LIMITED'),
    });

  // Kullanıcı başına, saatlik sınır (doğrulama e-postasını tekrar gönderme). requireAuth'tan sonra çalışır.
  const resendLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: limits.resend ?? 5,
    keyGenerator: (req) => `user:${req.user.id}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: errorBody(429, 'Çok fazla doğrulama e-postası istendi. Lütfen bir saat sonra tekrar deneyin.', 'RATE_LIMITED'),
  });

  // Hesap (e-posta) başına başarısız giriş sınırı: farklı IP'lerden tek hesaba dağıtık şifre denemelerini durdurur.
  // Yalnızca başarısız denemeler sayılır; doğru şifreyle girişler sayacı tüketmez.
  const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: limits.loginPerAccount ?? 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `login:${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '-'}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: errorBody(429, 'Bu hesap için çok fazla başarısız giriş denemesi yapıldı. Lütfen 15 dakika sonra tekrar deneyin.', 'RATE_LIMITED'),
  });

  // AI uçları: kullanıcı başına (maliyetli çağrıların kötüye kullanımına karşı). requireAuth'tan sonra çalışır.
  const aiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: limits.ai ?? 60,
    keyGenerator: (req) => `ai:${req.user.id}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: errorBody(429, 'Çok fazla analiz isteği gönderildi. Lütfen biraz sonra tekrar deneyin.', 'RATE_LIMITED'),
  });

  const cookie = sessionCookie(config);
  const verification = createVerificationService({
    db,
    email,
    ttlHours: config.email.verificationTtlHours,
    cooldownSeconds: limits.resendCooldownSeconds ?? 60,
  });

  api.use(healthRouter({ db, env: config.env })); // oturum gerektirmez, veritabanına yalnızca SELECT 1
  api.use(loadUser(db, cookie.name));
  api.use(aiRouter({ catalog, email, verification, aiLimiter }));
  api.use('/auth', authRouter({ db, email, verification, limiter: limiter(limits.auth ?? 20), resendLimiter, loginAccountLimiter, cookie }));
  api.use(dataRouter({ db, email, sendLimiter: limiter(limits.send ?? 30) }));
  api.use(notFound);

  app.use('/api', api);

  // ---- Frontend (statik) ----
  app.use(express.static(publicDir));

  app.use(errorHandler(config));
  return app;
}
