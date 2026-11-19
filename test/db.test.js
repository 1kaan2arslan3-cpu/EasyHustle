// Veritabanı katmanı testleri: oluşturma (migration), bağlantı ve temel kullanıcı sorguları.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createTestDb } from './helpers/db.js';
import { createDb, connectDb, pingDb } from '../src/db.js';
import { createSession, createUser, findUserByEmail, getSessionUser } from '../src/auth.js';
import { verifyPassword } from '../src/password.js';
import { resolveDatabaseUrl } from '../src/database-url.js';

let t;
before(async () => {
  t = await createTestDb();
});
after(() => t?.cleanup());

test('veritabanı migration ile oluşturulur ve bağlantı çalışır', async () => {
  assert.ok(existsSync(t.file), 'SQLite dosyası oluşmalı');
  assert.match(t.migrateOutput, /init/);
  await pingDb(t.db);
  const tables = (await t.db.$queryRaw`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r.name);
  for (const name of ['users', 'sessions', 'email_tokens', 'company_settings', 'quotes', 'email_log', '_prisma_migrations']) {
    assert.ok(tables.includes(name), `${name} tablosu olmalı`);
  }
});

test('User tablosu yalnızca istenen alanları içerir', async () => {
  const cols = (await t.db.$queryRaw`SELECT name FROM pragma_table_info('users')`).map((r) => r.name).sort();
  assert.deepEqual(cols, ['createdAt', 'email', 'emailVerified', 'id', 'passwordHash', 'updatedAt', 'username']);
});

test('kullanıcı oluşturma, bulma, güncelleme, silme', async () => {
  const u = await createUser(t.db, { username: 'kaan', email: '  Kaan@Ornek.COM ', password: 'cok-gizli-123' });
  assert.match(u.id, /^[0-9a-f-]{36}$/);
  assert.equal(u.email, 'kaan@ornek.com', 'e-posta küçük harfe çevrilir');
  assert.equal(u.emailVerified, false);
  assert.ok(u.createdAt instanceof Date && u.updatedAt instanceof Date);

  const found = await findUserByEmail(t.db, 'KAAN@ornek.com');
  assert.equal(found.id, u.id);

  await new Promise((r) => setTimeout(r, 10));
  const updated = await t.db.user.update({ where: { id: u.id }, data: { emailVerified: true } });
  assert.equal(updated.emailVerified, true);
  assert.ok(updated.updatedAt > u.updatedAt, 'updatedAt otomatik güncellenir');

  assert.equal(await t.db.user.count({ where: { emailVerified: true } }), 1);
  await t.db.user.delete({ where: { id: u.id } });
  assert.equal(await findUserByEmail(t.db, 'kaan@ornek.com'), null);
});

test('e-posta benzersizdir (unique)', async () => {
  await createUser(t.db, { username: 'a', email: 'ayni@ornek.com', password: 'sifre-12345' });
  await assert.rejects(createUser(t.db, { username: 'b', email: 'AYNI@ornek.com', password: 'sifre-67890' }), (err) => err.code === 'P2002');
});

test('şifre düz metin saklanmaz, Argon2id hash ile doğrulanır', async () => {
  const u = await createUser(t.db, { username: 'gizli', email: 'gizli@ornek.com', password: 'duz-metin-sifre' });
  const [raw] = await t.db.$queryRaw`SELECT * FROM users WHERE id = ${u.id}`;
  assert.ok(!JSON.stringify(raw).includes('duz-metin-sifre'), 'düz metin şifre veritabanında olmamalı');
  assert.match(raw.passwordHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.deepEqual(await verifyPassword('duz-metin-sifre', raw.passwordHash), { ok: true, needsRehash: false });
  assert.equal((await verifyPassword('yanlis', raw.passwordHash)).ok, false);

  const other = await createUser(t.db, { username: 'gizli2', email: 'gizli2@ornek.com', password: 'duz-metin-sifre' });
  assert.notEqual(other.passwordHash, raw.passwordHash, 'aynı şifre farklı tuzla farklı hash üretir');
});

test('kullanıcı silinince oturumları da silinir (cascade)', async () => {
  const u = await createUser(t.db, { username: 'oturum', email: 'oturum@ornek.com', password: 'sifre-12345' });
  const { token } = await createSession(t.db, u.id);
  assert.equal((await getSessionUser(t.db, token)).id, u.id);
  await t.db.user.delete({ where: { id: u.id } });
  assert.equal(await t.db.session.count({ where: { userId: u.id } }), 0);
  assert.equal(await getSessionUser(t.db, token), null);
});

test('tabloları olmayan veritabanında açıklayıcı hata verilir', async () => {
  const db = await createDb(`${t.url}.bos.db`);
  await assert.rejects(connectDb(db, { retries: 1 }), /npm run db:deploy/);
  await db.$disconnect();
  rmSync(`${t.file}.bos.db`, { force: true });
});

test('DATABASE_URL çözümleme: SQLite yolu proje klasörüne göre, PostgreSQL olduğu gibi', () => {
  const root = path.resolve('proje-kok');
  const expected = (rel) => `file:${path.resolve(root, rel).replaceAll('\\', '/')}`;
  assert.equal(resolveDatabaseUrl(undefined, root), expected('data/dev.db'));
  assert.equal(resolveDatabaseUrl('file:./x/y.db', root), expected('x/y.db'));
  assert.equal(resolveDatabaseUrl('file::memory:', root), 'file::memory:');
  const pg = 'postgresql://kullanici:sifre@localhost:5432/easyhustle';
  assert.equal(resolveDatabaseUrl(pg, '/srv/app'), pg);
});
