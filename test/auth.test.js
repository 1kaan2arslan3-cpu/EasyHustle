// Kimlik doğrulama sistemi testleri: POST /register, /login, /logout, GET /me
// + şifre hash'leme, çerez ayarları (geliştirme / canlı), hız sınırı ve hata biçimi.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { argon2Sync, scryptSync, randomBytes } from 'node:crypto';

process.env.DEMO_MODE = '1';

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { createTestDb } = await import('./helpers/db.js');
const { hashPassword, verifyPassword } = await import('../src/password.js');
const { createEmailService } = await import('../src/email/service.js');
const { createConsoleProvider } = await import('../src/email/providers.js');

// Bu dosya e-posta gönderimini test etmez: geliştirme (konsol) sağlayıcısı, sessiz
const silentEmail = createEmailService({ provider: createConsoleProvider({ log: () => {} }), from: 'Test <t@example.test>', appUrl: 'http://app.test', appName: 'EasyHustle' });

/** Ayrı bir uygulama + geçici veritabanı başlatır. */
async function startApp({ env = {}, limits = { auth: 1000, send: 1000 } } = {}) {
  const testDb = await createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://app.test', ...env }, process.cwd());
  const app = createApp({ db: testDb.db, email: silentEmail, config, limits });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    db: testDb.db,
    base: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((r) => server.close(r));
      await testDb.cleanup();
    },
  };
}

/** Çerezleri saklayan istemci. */
function client(base, cookieName = 'ita_session') {
  let cookie = '';
  const fn = async (path, { method = 'GET', body, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${cookieName}=`));
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, setCookie, headers: res.headers, text };
  };
  fn.cookie = () => cookie;
  fn.setCookieValue = (v) => {
    cookie = v;
  };
  return fn;
}

const register = (c, body) => c('/api/auth/register', { method: 'POST', body });
const login = (c, body) => c('/api/auth/login', { method: 'POST', body });
const VALID = { username: 'Deniz Kaya', email: 'deniz@ornek.com', password: 'guclu-sifre-2026' };

/** Hata yanıtı standart biçimde mi? */
function assertError(r, status, code) {
  assert.equal(r.status, status, `HTTP ${status} beklenirdi: ${r.text}`);
  assert.equal(typeof r.data.error, 'string');
  assert.ok(r.data.error.length > 0);
  assert.equal(r.data.code, code);
}

describe('kimlik doğrulama (geliştirme ortamı)', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.stop());

  test('başarılı kayıt: 201, doğrulanmamış hesap, HttpOnly oturum çerezi, hash dönmez', async () => {
    const c = client(app.base);
    const r = await register(c, { ...VALID, email: '  Deniz@Ornek.COM ' });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.data.user).sort(), ['createdAt', 'email', 'emailVerified', 'id', 'name', 'username']);
    assert.equal(r.data.user.email, 'deniz@ornek.com');
    assert.equal(r.data.user.username, 'Deniz Kaya');
    assert.equal(r.data.user.emailVerified, false, 'yeni hesap doğrulanmamış olmalı');
    assert.doesNotMatch(r.text, /argon2|passwordHash|guclu-sifre/i);
    assert.equal(r.headers.get('cache-control'), 'no-store');

    // Çerez: HttpOnly, SameSite=Lax, Path=/, geliştirmede Secure YOK (http://localhost'ta çalışsın diye)
    assert.match(r.setCookie, /^ita_session=[A-Za-z0-9_-]{43};/);
    assert.match(r.setCookie, /HttpOnly/i);
    assert.match(r.setCookie, /SameSite=Lax/i);
    assert.match(r.setCookie, /Path=\//);
    assert.match(r.setCookie, /Expires=/);
    assert.doesNotMatch(r.setCookie, /Secure/i);

    const me = await c('/api/auth/me');
    assert.equal(me.data.user.id, r.data.user.id);
    assert.doesNotMatch(me.text, /argon2|passwordHash/i);

    const row = await app.db.user.findUnique({ where: { email: 'deniz@ornek.com' } });
    assert.equal(row.emailVerified, false);
    assert.match(row.passwordHash, /^\$argon2id\$/);
  });

  test('"name" alanıyla kayıt (arayüz formu) da çalışır', async () => {
    const r = await register(client(app.base), { name: 'Arayüz Kullanıcı', email: 'arayuz@ornek.com', password: 'guclu-sifre-2026' });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.username, 'Arayüz Kullanıcı');
  });

  test('aynı e-postayla ikinci kayıt: 409 EMAIL_TAKEN (büyük/küçük harf fark etmez), ikinci hesap oluşmaz', async () => {
    const r = await register(client(app.base), { ...VALID, username: 'Başka', email: 'DENIZ@ornek.com' });
    assertError(r, 409, 'EMAIL_TAKEN');
    assert.equal(r.data.fields.email, 'Bu e-posta zaten kayıtlı.');
    assert.equal(r.setCookie, undefined, 'başarısız kayıtta oturum açılmamalı');
    assert.equal(await app.db.user.count({ where: { email: 'deniz@ornek.com' } }), 1);
  });

  test('geçersiz kayıt verileri: 400 VALIDATION_ERROR ve alan bazlı mesaj', async () => {
    const c = client(app.base);
    const cases = [
      [{}, 'email'],
      [{ ...VALID, email: undefined }, 'email'],
      [{ ...VALID, email: 'gecersiz-adres' }, 'email'],
      [{ ...VALID, email: `${'a'.repeat(250)}@ornek.com` }, 'email'],
      [{ ...VALID, email: 'yeni1@ornek.com', password: 'kisa' }, 'password'],
      [{ ...VALID, email: 'yeni2@ornek.com', password: 'x'.repeat(129) }, 'password'],
      [{ ...VALID, email: 'yeni3@ornek.com', password: '          ' }, 'password'],
      [{ ...VALID, email: 'yeni4@ornek.com', password: 12345678 }, 'password'],
      [{ email: 'yeni5@ornek.com', password: 'guclu-sifre-2026' }, 'username'],
      [{ ...VALID, email: 'yeni6@ornek.com', username: 'a' }, 'username'],
      [{ ...VALID, email: 'yeni7@ornek.com', username: '<script>' }, 'username'],
      [{ ...VALID, email: 'yeni8@ornek.com', username: 'x'.repeat(51) }, 'username'],
    ];
    for (const [body, field] of cases) {
      const r = await register(c, body);
      assertError(r, 400, 'VALIDATION_ERROR');
      assert.ok(r.data.fields?.[field], `${JSON.stringify(body).slice(0, 60)} → "${field}" alanı için hata beklenirdi, gelen: ${JSON.stringify(r.data.fields)}`);
    }
    assert.equal(await app.db.user.count({ where: { email: { startsWith: 'yeni' } } }), 0, 'geçersiz istekler hesap oluşturmamalı');

    assertError(await c('/api/auth/register', { method: 'POST', raw: '{bozuk json' }), 400, 'INVALID_JSON');
    assertError(await c('/api/auth/register', { method: 'POST', raw: '[]' }), 400, 'VALIDATION_ERROR');
  });

  test('giriş: doğru bilgilerle 200 ve yeni oturum; yanlış şifre / olmayan hesap aynı 401', async () => {
    const c = client(app.base);
    const ok = await login(c, { email: 'Deniz@ornek.com', password: VALID.password });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.email, 'deniz@ornek.com');
    assert.doesNotMatch(ok.text, /argon2|passwordHash/i);
    assert.match(ok.setCookie, /HttpOnly/i);
    assert.equal((await c('/api/auth/me')).data.user.email, 'deniz@ornek.com');

    const wrong = await login(client(app.base), { email: 'deniz@ornek.com', password: 'yanlis-sifre-123' });
    const missing = await login(client(app.base), { email: 'kimse@ornek.com', password: 'yanlis-sifre-123' });
    assertError(wrong, 401, 'INVALID_CREDENTIALS');
    assertError(missing, 401, 'INVALID_CREDENTIALS');
    assert.equal(wrong.data.error, missing.data.error, 'hesabın var olup olmadığı belli edilmemeli');
    assert.equal(wrong.setCookie, undefined);

    assertError(await login(client(app.base), { email: 'deniz@ornek.com' }), 400, 'VALIDATION_ERROR');
  });

  test('çıkış: çerez silinir, oturum sunucuda geçersiz olur (eski çerez tekrar kullanılamaz)', async () => {
    const c = client(app.base);
    await login(c, { email: VALID.email, password: VALID.password });
    const stolen = c.cookie();
    assert.ok(stolen);

    const out = await c('/api/auth/logout', { method: 'POST' });
    assert.equal(out.status, 200);
    assert.deepEqual(out.data, { ok: true });
    assert.match(out.setCookie, /^ita_session=;/);
    assert.match(out.setCookie, /Expires=Thu, 01 Jan 1970/);
    assert.equal((await c('/api/auth/me')).data.user, null);

    // Çıkıştan önce kopyalanmış çerez de artık işe yaramaz
    const replay = client(app.base);
    replay.setCookieValue(stolen);
    assert.equal((await replay('/api/auth/me')).data.user, null);
    assertError(await replay('/api/quotes'), 401, 'UNAUTHENTICATED');

    // Oturumsuz çıkış da sorunsuz
    assert.equal((await client(app.base)('/api/auth/logout', { method: 'POST' })).status, 200);
  });

  test('me: oturum yoksa user=null; geçersiz/uydurma çerez reddedilir', async () => {
    assert.deepEqual((await client(app.base)('/api/auth/me')).data, { user: null });
    const fake = client(app.base);
    fake.setCookieValue(`ita_session=${randomBytes(32).toString('base64url')}`);
    assert.equal((await fake('/api/auth/me')).data.user, null);
    fake.setCookieValue(`ita_session=${'x'.repeat(5000)}`);
    assert.equal((await fake('/api/auth/me')).status, 200);
  });

  test('eski (scrypt) şifre hash\'i girişte Argon2id\'ye yükseltilir', async () => {
    const salt = randomBytes(16);
    const legacy = `scrypt$16384$8$1$${salt.toString('base64')}$${scryptSync('eski-sifre-123', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    await app.db.user.create({ data: { username: 'Eski', email: 'eski@ornek.com', passwordHash: legacy } });

    assert.equal((await login(client(app.base), { email: 'eski@ornek.com', password: 'eski-sifre-123' })).status, 200);
    const row = await app.db.user.findUnique({ where: { email: 'eski@ornek.com' } });
    assert.match(row.passwordHash, /^\$argon2id\$/);
    assert.equal((await login(client(app.base), { email: 'eski@ornek.com', password: 'eski-sifre-123' })).status, 200, 'yükseltmeden sonra da giriş çalışır');
  });
});

describe('şifre hash\'leme', () => {
  test('Argon2id, OWASP parametreleri, her seferinde farklı tuz', async () => {
    const a = await hashPassword('ayni-sifre-123');
    const b = await hashPassword('ayni-sifre-123');
    assert.match(a, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.notEqual(a, b);
    assert.deepEqual(await verifyPassword('ayni-sifre-123', a), { ok: true, needsRehash: false });
    assert.equal((await verifyPassword('Ayni-sifre-123', a)).ok, false);
    assert.equal((await verifyPassword('x', 'bozuk-hash')).ok, false);
    assert.equal((await verifyPassword('x', '')).ok, false);
  });

  test('daha zayıf parametreli Argon2id hash\'i doğru şifrede yeniden hash\'lenmek üzere işaretlenir', async () => {
    const salt = randomBytes(16);
    const tag = argon2Sync('argon2id', { message: Buffer.from('sifre-12345'), nonce: salt, memory: 8192, passes: 1, parallelism: 1, tagLength: 32 });
    const b64 = (b) => b.toString('base64').replace(/=+$/, '');
    const weak = `$argon2id$v=19$m=8192,t=1,p=1$${b64(salt)}$${b64(tag)}`;
    assert.deepEqual(await verifyPassword('sifre-12345', weak), { ok: true, needsRehash: true });
    assert.deepEqual(await verifyPassword('yanlis-12345', weak), { ok: false, needsRehash: false });
  });
});

describe('canlı ortam çerez ayarları', () => {
  let app;
  before(async () => {
    app = await startApp({ env: { NODE_ENV: 'production', APP_URL: 'https://easyhustle.example' } });
  });
  after(() => app?.stop());

  test('__Host- önekli, Secure, HttpOnly, SameSite=Lax, Path=/ ve alan adı (Domain) yok', async () => {
    const c = client(app.base, '__Host-ita_session');
    const r = await register(c, { ...VALID, email: 'canli@ornek.com' });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /^__Host-ita_session=/);
    assert.match(r.setCookie, /; Secure/i);
    assert.match(r.setCookie, /HttpOnly/i);
    assert.match(r.setCookie, /SameSite=Lax/i);
    assert.match(r.setCookie, /Path=\//);
    assert.doesNotMatch(r.setCookie, /Domain=/i);
    assert.equal((await c('/api/auth/me')).data.user.email, 'canli@ornek.com');

    const out = await c('/api/auth/logout', { method: 'POST' });
    assert.match(out.setCookie, /^__Host-ita_session=;.*Secure/i);
  });

  test('yapılandırma: canlıda https olmayan APP_URL ve geliştirmede SameSite=None reddedilir', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_URL: 'http://easyhustle.example' }, process.cwd()), /https/);
    assert.throws(() => loadConfig({ COOKIE_SAMESITE: 'none' }, process.cwd()), /COOKIE_SAMESITE/);
    assert.equal(loadConfig({ NODE_ENV: 'production', APP_URL: 'https://a.example', COOKIE_SAMESITE: 'none' }, process.cwd()).cookieSameSite, 'none');
  });
});

describe('hız sınırı', () => {
  let app;
  before(async () => {
    app = await startApp({ limits: { auth: 3, send: 3 } });
  });
  after(() => app?.stop());

  test('giriş denemeleri sınırı aşınca 429 RATE_LIMITED + Retry-After', async () => {
    const c = client(app.base);
    for (let i = 0; i < 3; i++) {
      assertError(await login(c, { email: 'saldirgan@ornek.com', password: `deneme-${i}-xxxx` }), 401, 'INVALID_CREDENTIALS');
    }
    const blocked = await login(c, { email: 'saldirgan@ornek.com', password: 'deneme-son-xxxx' });
    assertError(blocked, 429, 'RATE_LIMITED');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.ok(blocked.headers.get('ratelimit'));

    // Sınır, kayıt ucu için de geçerli; oturum bilgisi (me) sınırlanmaz
    assertError(await register(c, { ...VALID, email: 'limit@ornek.com' }), 429, 'RATE_LIMITED');
    assert.equal((await c('/api/auth/me')).status, 200);
  });
});
