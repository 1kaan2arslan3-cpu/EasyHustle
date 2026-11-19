// Prisma'dan önceki sürümün veritabanındaki (data/app.db) hesapları ve verileri yeni Prisma veritabanına aktarır.
// Kullanım: npm run db:import-legacy [-- eski/dosya/yolu.db]
// Tekrar çalıştırmak güvenlidir: e-postası zaten kayıtlı kullanıcılar atlanır. Eski dosya silinmez.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(rootDir, '.env'));
} catch {
  /* .env yok */
}
const { resolveDatabaseUrl } = await import('../src/database-url.js');
const { createDb, connectDb } = await import('../src/db.js');

const legacyFile = path.resolve(rootDir, process.argv[2] || 'data/app.db');
if (!existsSync(legacyFile)) {
  console.log(`Eski veritabanı bulunamadı (${legacyFile}); aktarılacak bir şey yok.`);
  process.exit(0);
}

const legacy = new DatabaseSync(legacyFile, { readOnly: true });
const db = await createDb(resolveDatabaseUrl(process.env.DATABASE_URL, rootDir));
await connectDb(db, { retries: 1 });

const date = (s) => (s ? new Date(s) : undefined);
const json = (s) => (s ? JSON.parse(s) : undefined);
const counts = { users: 0, skipped: 0, sessions: 0, settings: 0, quotes: 0 };

for (const u of legacy.prepare('SELECT * FROM users').all()) {
  if (await db.user.findUnique({ where: { email: u.email } })) {
    counts.skipped++;
    continue;
  }
  await db.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: u.id,
        username: u.name,
        email: u.email,
        passwordHash: u.password_hash, // zaten scrypt hash'i; düz metin şifre yok
        emailVerified: Boolean(u.email_verified_at),
        createdAt: date(u.created_at),
      },
    });
    counts.users++;

    // Açık oturumlar korunur (token özetleri aynı yöntemle saklanıyor)
    for (const s of legacy.prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ?').all(u.id, new Date().toISOString())) {
      await tx.session.create({ data: { id: s.id, userId: u.id, tokenHash: s.token_hash, expiresAt: date(s.expires_at), createdAt: date(s.created_at) } });
      counts.sessions++;
    }

    const st = legacy.prepare('SELECT * FROM company_settings WHERE user_id = ?').get(u.id);
    if (st) {
      await tx.companySettings.create({
        data: {
          userId: u.id,
          companyName: st.company_name,
          contactName: st.contact_name,
          email: st.email,
          phone: st.phone,
          validityDays: st.validity_days,
          defaultPaymentTerms: st.default_payment_terms,
        },
      });
      counts.settings++;
    }

    for (const q of legacy.prepare('SELECT * FROM quotes WHERE user_id = ?').all(u.id)) {
      await tx.quote.create({
        data: {
          id: q.id,
          userId: u.id,
          customerCompany: q.customer_company,
          customerEmail: q.customer_email,
          subject: q.subject,
          request: json(q.request_json),
          analysis: json(q.analysis_json),
          quoteInput: json(q.quote_input_json),
          email: json(q.email_json),
          total: q.total,
          currency: q.currency,
          status: q.status,
          createdAt: date(q.created_at),
          updatedAt: date(q.updated_at),
        },
      });
      counts.quotes++;
    }
  });
}

legacy.close();
await db.$disconnect();
console.log(
  `Aktarıldı: ${counts.users} kullanıcı, ${counts.sessions} oturum, ${counts.settings} firma ayarı, ${counts.quotes} teklif.` +
    (counts.skipped ? ` Zaten kayıtlı olduğu için atlanan kullanıcı: ${counts.skipped}.` : ''),
);
