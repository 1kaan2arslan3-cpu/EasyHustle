// Ortam değişkenlerinin tek noktadan okunması ve doğrulanması.
// .env dosyası server.js'te Node'un yerleşik process.loadEnvFile() ile yüklenir (dotenv gerekmez).
import { z } from 'zod';
import { resolveDatabaseUrl } from './database-url.js';

const bool = z
  .string()
  .optional()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase()));

const list = z
  .string()
  .optional()
  .transform((v) =>
    String(v ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: z.string().trim().optional(),
  DATABASE_URL: z.string().trim().optional(),
  CORS_ORIGINS: list,
  TRUST_PROXY: bool,
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // ---- E-posta (Resend) ----
  APP_NAME: z.string().trim().min(1).max(60).default('EasyHustle'),
  RESEND_API_KEY: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^re_[A-Za-z0-9_]{8,}$/.test(v), 'Resend API anahtarı "re_" ile başlamalı (resend.com → API Keys).'),
  RESEND_API_URL: z.string().trim().url().default('https://api.resend.com'),
  // ---- E-posta (Brevo) — tanımlıysa Resend yerine kullanılır ----
  BREVO_API_KEY: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^xkeysib-[A-Za-z0-9-]{20,}$/.test(v), 'Brevo API anahtarı "xkeysib-" ile başlamalı (Brevo → SMTP & API → API Keys).'),
  BREVO_API_URL: z.string().trim().url().default('https://api.brevo.com/v3'),
  MAIL_FROM: z.string().trim().optional(),
  MAIL_REPLY_TO: z.string().trim().optional(),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

// "Ad <adres@alan.com>" veya "adres@alan.com"
const MAILBOX = /^(?:[^<>@\r\n]+<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/;

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} rootDir  Proje kök dizini (göreli yollar buna göre çözülür)
 */
export function loadConfig(env, rootDir) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Geçersiz ortam değişkenleri (.env):\n${msg}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const appUrl = (e.APP_URL || `http://localhost:${e.PORT}`).replace(/\/+$/, '');

  for (const origin of [appUrl, ...e.CORS_ORIGINS]) {
    try {
      new URL(origin);
    } catch {
      throw new Error(`Geçersiz adres: "${origin}" (APP_URL / CORS_ORIGINS tam adres olmalı, ör. https://ornek.com)`);
    }
  }
  if (isProduction && !e.APP_URL) {
    throw new Error('Canlı ortamda (NODE_ENV=production) APP_URL tanımlanmalıdır.');
  }
  if (isProduction && !appUrl.startsWith('https://')) {
    throw new Error('Canlı ortamda APP_URL https:// ile başlamalıdır (oturum çerezi yalnızca HTTPS üzerinden gönderilir).');
  }
  if (e.COOKIE_SAMESITE === 'none' && !isProduction) {
    throw new Error('COOKIE_SAMESITE=none yalnızca canlı ortamda (HTTPS, Secure çerez) kullanılabilir.');
  }

  // Resend'in test göndericisi: yalnızca Resend hesabının sahibine gönderebilir; kendi alan adınızı doğrulayıp MAIL_FROM'u değiştirin.
  const mailFrom = e.MAIL_FROM || `${e.APP_NAME} <onboarding@resend.dev>`;
  for (const [name, value] of [['MAIL_FROM', mailFrom], ['MAIL_REPLY_TO', e.MAIL_REPLY_TO]]) {
    if (value && !MAILBOX.test(value)) {
      throw new Error(`${name} geçersiz: "${value}". Biçim: "Ad <adres@alanadi.com>" veya "adres@alanadi.com".`);
    }
  }
  if (e.BREVO_API_KEY && !e.MAIL_FROM) {
    throw new Error('BREVO_API_KEY ile MAIL_FROM tanımlanmalıdır (Brevo\'da doğrulanmış gönderen adresi, ör. "EasyHustle <adin@gmail.com>").');
  }
  if (isProduction && e.RESEND_API_KEY && !e.MAIL_FROM) {
    throw new Error('Canlı ortamda MAIL_FROM tanımlanmalıdır (Resend\'de doğrulanmış alan adınızdan bir adres).');
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    appUrl,
    databaseUrl: resolveDatabaseUrl(e.DATABASE_URL, rootDir),
    corsOrigins: e.CORS_ORIGINS,
    trustProxy: e.TRUST_PROXY,
    cookieSameSite: e.COOKIE_SAMESITE,
    appName: e.APP_NAME,
    email: {
      // Anahtar yalnızca e-posta sağlayıcısına iletilir; hiçbir yanıtta veya günlükte yer almaz.
      brevoApiKey: e.BREVO_API_KEY || null,
      brevoApiUrl: e.BREVO_API_URL.replace(/\/+$/, ''),
      resendApiKey: e.RESEND_API_KEY || null,
      resendApiUrl: e.RESEND_API_URL.replace(/\/+$/, ''),
      from: mailFrom,
      replyTo: e.MAIL_REPLY_TO || null,
      verificationTtlHours: e.EMAIL_VERIFICATION_TTL_HOURS,
    },
  };
}
