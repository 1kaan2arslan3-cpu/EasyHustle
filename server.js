// Sunucuyu başlatır: .env → yapılandırma → veritabanı → e-posta → Express.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// .env dosyasını (varsa) yükle. Ortamda zaten tanımlı değişkenler ezilmez.
try {
  process.loadEnvFile(path.join(rootDir, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';

// Yapılandırma .env yüklendikten sonra okunmalı (ai.js modül yüklenirken ortamı okur)
const { loadConfig } = await import('./src/config.js');
const { createApp } = await import('./src/app.js');
const { isAiConfigured, MODEL } = await import('./src/ai.js');
const { createDb, connectDb } = await import('./src/db.js');
const { createEmailServiceFromConfig } = await import('./src/email/service.js');

let config;
try {
  config = loadConfig(process.env, rootDir);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = await createDb(config.databaseUrl);
try {
  await connectDb(db);
} catch (err) {
  console.error(err.message);
  await db.$disconnect().catch(() => {});
  process.exit(1);
}
const email = createEmailServiceFromConfig(config);
const app = createApp({ db, email, config });

const server = app.listen(config.port, () => {
  console.log(`EasyHustle → http://localhost:${config.port}  (${config.env})`);
  console.log(`Sağlık kontrolü: http://localhost:${config.port}/api/health`);
  console.log(isAiConfigured() ? `Mod: AI (${MODEL})` : 'Mod: DEMO (kural tabanlı) — AI için .env dosyasına ANTHROPIC_API_KEY ekleyin.');
  console.log(`Veritabanı: ${config.databaseUrl.startsWith('file:') ? config.databaseUrl : config.databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);
  // API anahtarı asla yazdırılmaz; yalnızca sağlayıcı adı ve gönderen adresi
  console.log(
    email.delivers
      ? `E-posta: ${email.providerName === 'brevo' ? 'Brevo' : 'Resend'} ile gönderiliyor (gönderen: ${config.email.from})`
      : 'E-posta: geliştirme modu (gönderilmez, konsola yazılır) — göndermek için .env dosyasına BREVO_API_KEY veya RESEND_API_KEY ekleyin.',
  );
  if (config.corsOrigins.length) console.log(`CORS izinli adresler: ${config.corsOrigins.join(', ')}`);
  if (config.isProduction && !email.delivers) console.warn('UYARI: Canlı ortamda BREVO_API_KEY / RESEND_API_KEY tanımlı değil; doğrulama/sıfırlama e-postaları gönderilmeyecek.');
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} kullanımda. .env içinde PORT değiştirin.` : err);
  process.exit(1);
});

// Düzgün kapanış (Ctrl+C, deploy yeniden başlatmaları)
function shutdown(signal) {
  console.log(`\n${signal} alındı, sunucu kapatılıyor…`);
  server.close(async () => {
    await db.$disconnect().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('[yakalanmamış hata]', reason));
