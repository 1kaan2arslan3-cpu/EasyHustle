// Güvenlik incelemesi testleri: giriş doğrulama, yetkisiz erişim, oturum, hız sınırı, hata yanıtları,
// CORS/çerez/başlıklar, SQL enjeksiyonu, zayıf şifreler, hassas veri sızıntısı.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEMO_MODE = '1';

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { createTestDb } = await import('./helpers/db.js');
const { createEmailService } = await import('../src/email/service.js');
const { createConsoleProvider, createMemoryProvider } = await import('../src/email/providers.js');

const FRONTEND = 'https://frontend.example';

async function startApp({ env = {}, limits = {} } = {}) {
  const testDb = await createTestDb();
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://app.test', CORS_ORIGINS: FRONTEND, ...env }, process.cwd());
  const provider = createMemoryProvider();
  const email = createEmailService({ provider, from: 'T <t@example.test>', appUrl: config.appUrl, appName: 'EasyHustle' });
  const app = createApp({ db: testDb.db, email, config, limits: { auth: 1000, send: 1000, resend: 1000, ai: 1000, loginPerAccount: 1000, ...limits } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    db: testDb.db,
    provider,
    base: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      await new Promise((r) => server.close(r));
      await testDb.cleanup();
    },
  };
}

function client(base) {
  let cookie = '';
  const fn = async (path, { method = 'GET', body, raw, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      redirect: 'manual',
    });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('ita_session='));
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* JSON değil */
    }
    return { status: res.status, data, text, headers: res.headers };
  };
  fn.cookie = () => cookie;
  fn.setCookie = (v) => {
    cookie = v;
  };
  return fn;
}

let n = 0;
const uniqueEmail = (p = 'u') => `${p}${++n}@guvenlik.test`;
const STRONG = 'Uzun-ve-Guclu-Sifre-2026';

async function registered(base, extra = {}) {
  const c = client(base);
  const email = uniqueEmail();
  const r = await c('/api/auth/register', { method: 'POST', body: { username: 'Güvenlik Test', email, password: STRONG, ...extra } });
  assert.equal(r.status, 201, r.text);
  return { c, email, user: r.data.user };
}

/** Yanıt gövdesinde hassas veri olmamalı. */
function assertNoSecrets(text) {
  assert.doesNotMatch(text, /passwordHash|tokenHash|\$argon2|scrypt\$|re_[A-Za-z0-9]{8,}|"stack"|at .+\.js:\d+/);
}

// ============================================================================
describe('güvenlik incelemesi', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app?.stop());

  // ---- 1. Kayıt: geçersiz veri, tür karışıklığı, SQL enjeksiyonu ----
  test('kayıt: tür karışıklığı ve beklenmeyen alanlar reddedilir / yok sayılır', async () => {
    const c = client(app.base);
    for (const body of [
      { username: 'X Y', email: { $ne: null }, password: STRONG },
      { username: 'X Y', email: ['a@b.com'], password: STRONG },
      { username: ['X'], email: uniqueEmail(), password: STRONG },
      { username: 'X Y', email: uniqueEmail(), password: { length: 20 } },
      { username: 'X Y', email: uniqueEmail(), password: null },
    ]) {
      const r = await c('/api/auth/register', { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.data.code, 'VALIDATION_ERROR');
    }
    // Toplu atama: emailVerified / id gibi alanlar istemciden alınmaz
    const email = uniqueEmail();
    const r = await c('/api/auth/register', { method: 'POST', body: { username: 'Toplu Atama', email, password: STRONG, emailVerified: true, id: 'admin', passwordHash: 'x' } });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.emailVerified, false);
    assert.notEqual(r.data.user.id, 'admin');
    const row = await app.db.user.findUnique({ where: { email } });
    assert.match(row.passwordHash, /^\$argon2id\$/);
  });

  test('SQL enjeksiyonu: yükler veri olarak işlenir, sorguyu değiştiremez', async () => {
    const c = client(app.base);
    const payloads = ["' OR '1'='1", "admin'--", '"; DROP TABLE users; --', "' UNION SELECT passwordHash FROM users --"];
    for (const p of payloads) {
      const login = await c('/api/auth/login', { method: 'POST', body: { email: `${p}@x.com`, password: p } });
      assert.ok([400, 401].includes(login.status), `${p} → ${login.status}`);
      const login2 = await c('/api/auth/login', { method: 'POST', body: { email: 'deneme@x.com', password: p } });
      assert.equal(login2.status, 401);
    }
    // Kullanıcı adında SQL: olduğu gibi saklanır
    const { user } = await registered(app.base, { username: "Robert'); DROP TABLE users;--" });
    assert.equal(user.username, "Robert'); DROP TABLE users;--");
    assert.ok((await app.db.user.count()) > 0, 'users tablosu yerinde');
  });

  // ---- Zayıf şifreler ----
  test('zayıf şifreler: yaygın şifreler ve e-posta/ad ile aynı şifre reddedilir', async () => {
    const c = client(app.base);
    const email = uniqueEmail('zayif');
    for (const password of ['12345678', 'password', 'qwerty123', 'Password1', '11111111', 'abcdefgh', email, email.split('@')[0] + '1234', 'zayif ad zayif ad']) {
      const r = await c('/api/auth/register', { method: 'POST', body: { username: 'zayif ad', email, password } });
      assert.equal(r.status, 400, `"${password}" kabul edilmemeliydi`);
      assert.ok(r.data.fields?.password, `"${password}" için şifre alanı hatası beklenirdi`);
    }
    assert.equal(await app.db.user.count({ where: { email } }), 0);
  });

  // ---- 8. Yetkisiz istekler ----
  test('yetkisiz istekler: korunan tüm uçlar 401, yol varyasyonları atlatamaz', async () => {
    const c = client(app.base);
    const protectedCalls = [
      ['GET', '/api/quotes'],
      ['POST', '/api/quotes', {}],
      ['PUT', '/api/quotes/x', {}],
      ['PATCH', '/api/quotes/x/status', { status: 'sent' }],
      ['DELETE', '/api/quotes/x'],
      ['POST', '/api/quotes/import', { quotes: [] }],
      ['GET', '/api/settings'],
      ['PUT', '/api/settings', {}],
      ['POST', '/api/email/send', {}],
      ['POST', '/api/analyze', { body: 'x' }],
      ['POST', '/api/draft-email', {}],
      ['POST', '/api/auth/resend-verification'],
    ];
    for (const [method, path, body] of protectedCalls) {
      const r = await c(path, { method, body });
      assert.equal(r.status, 401, `${method} ${path} → ${r.status}`);
      assert.equal(r.data.code, 'UNAUTHENTICATED');
    }
    for (const path of ['/api/QUOTES', '/api/quotes/', '/api/Settings', '/api//quotes', '/api/quotes?x=1', '/api/%71uotes', '/api/./quotes']) {
      const r = await c(path);
      assert.ok([401, 404].includes(r.status), `${path} → ${r.status} (veri dönmemeli)`);
    }
  });

  test('sahte / bozuk oturum çerezleri reddedilir', async () => {
    const c = client(app.base);
    for (const value of ['x', 'j:{"a":1}', 'j:"abc"', 's:abc.def', '%00', 'A'.repeat(43), 'A'.repeat(500)]) {
      c.setCookie(`ita_session=${value}`);
      assert.equal((await c('/api/auth/me')).data.user, null, value);
      assert.equal((await c('/api/quotes')).status, 401, value);
    }
  });

  // ---- 9. Oturum süresi ve çıkış ----
  test('süresi dolmuş oturum geçersizdir', async () => {
    const { c, user } = await registered(app.base);
    assert.equal((await c('/api/auth/me')).data.user.id, user.id);
    await app.db.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await c('/api/auth/me')).data.user, null);
    assert.equal((await c('/api/quotes')).status, 401);
  });

  test('giriş / kayıt yapılınca tarayıcıdaki önceki oturum sunucuda da kapanır', async () => {
    const a = await registered(app.base);
    const oldCookie = a.c.cookie();
    const b = await registered(app.base);
    // A'nın tarayıcısında B ile giriş
    const r = await a.c('/api/auth/login', { method: 'POST', body: { email: b.email, password: STRONG } });
    assert.equal(r.status, 200);
    assert.equal(await app.db.session.count({ where: { userId: a.user.id } }), 0, 'eski oturum silinmeli');
    const replay = client(app.base);
    replay.setCookie(oldCookie);
    assert.equal((await replay('/api/auth/me')).data.user, null);
  });

  test('çıkış GET ile yapılamaz; POST gerektirir', async () => {
    const { c } = await registered(app.base);
    assert.equal((await c('/api/auth/logout')).status, 404);
    assert.ok((await c('/api/auth/me')).data.user);
  });

  // ---- 11. API hata yönetimi ----
  test('hatalı istekler: JSON dışı gövde, büyük gövde, bozuk taslak isteği → 4xx, yığın izi yok', async () => {
    const c = client(app.base);
    const textPlain = await c('/api/auth/login', { method: 'POST', raw: 'email=a@b.com&password=x', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(textPlain.status, 400);
    assert.equal(textPlain.data.code, 'VALIDATION_ERROR');

    const big = await c('/api/auth/login', { method: 'POST', raw: JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(1_100_000) }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(big.status, 413);
    assert.equal(big.data.code, 'PAYLOAD_TOO_LARGE');

    const { c: auth } = await registered(app.base);
    for (const body of [
      { request: {}, analysis: {}, quote: {}, settings: {} },
      { request: { body: 'x' }, analysis: { items: 'x' }, quote: { lines: 'x' }, settings: 1 },
      { request: 'x', analysis: 'x', quote: 'x', settings: 'x' },
    ]) {
      const r = await auth('/api/draft-email', { method: 'POST', body });
      assert.equal(r.status, 400, `draft-email ${JSON.stringify(body)} → ${r.status}: ${r.text}`);
      assert.equal(r.data.code, 'VALIDATION_ERROR');
      assertNoSecrets(r.text);
    }
    const analyze = await auth('/api/analyze', { method: 'POST', body: { body: 'x'.repeat(60_000) } });
    assert.equal(analyze.status, 400, 'aşırı uzun talep metni reddedilmeli');
  });

  test('e-posta gönderimi: konuya satır sonu (başlık enjeksiyonu) eklenemez', async () => {
    const { c, user } = await registered(app.base);
    await app.db.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    const r = await c('/api/email/send', { method: 'POST', body: { to: 'musteri@ornek.com', subject: 'Teklif\r\nBcc: kurban@ornek.com', body: 'x' } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'VALIDATION_ERROR');
  });

  // ---- Hassas veri ----
  test('hiçbir yanıtta şifre/token özeti veya yığın izi yok', async () => {
    const { c, email } = await registered(app.base);
    const texts = [
      (await c('/api/auth/me')).text,
      (await c('/api/auth/login', { method: 'POST', body: { email, password: STRONG } })).text,
      (await c('/api/auth/login', { method: 'POST', body: { email, password: 'yanlis-sifre-x' } })).text,
      (await c('/api/status')).text,
      (await c('/api/health')).text,
      (await c('/api/olmayan')).text,
      (await c('/api/auth/verify-email', { method: 'POST', body: { token: 'x'.repeat(43) } })).text,
    ];
    texts.forEach(assertNoSecrets);
  });

  // ---- 12. CORS, çerez ve güvenlik başlıkları ----
  test('güvenlik başlıkları', async () => {
    const res = await fetch(`${app.base}/`);
    const h = res.headers;
    assert.equal(h.get('x-powered-by'), null);
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.match(h.get('content-security-policy'), /default-src 'self'/);
    assert.match(h.get('content-security-policy'), /script-src 'self'/);
    assert.match(h.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.match(h.get('content-security-policy'), /object-src 'none'/);
    assert.equal(h.get('referrer-policy'), 'no-referrer');
    assert.ok(h.get('strict-transport-security'));
    assert.equal(h.get('x-frame-options'), 'SAMEORIGIN');
  });

  test('CORS: izinsiz kaynağa çerezli erişim izni verilmez; Origin: null yazamaz', async () => {
    const { c } = await registered(app.base);
    for (const origin of ['https://kotu.example', 'null', 'https://frontend.example.kotu.example', 'http://frontend.example']) {
      const r = await c('/api/auth/me', { headers: { Origin: origin } });
      assert.equal(r.headers.get('access-control-allow-origin'), null, origin);
      assert.equal(r.headers.get('access-control-allow-credentials'), null, origin);
      const w = await c('/api/quotes', { method: 'POST', body: {}, headers: { Origin: origin } });
      assert.equal(w.status, 403, `${origin} yazma → ${w.status}`);
      assert.equal(w.data.code, 'FORBIDDEN_ORIGIN');
    }
    const ok = await c('/api/auth/me', { headers: { Origin: FRONTEND } });
    assert.equal(ok.headers.get('access-control-allow-origin'), FRONTEND);
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  });

  test('statik dosyalar: kaynak kod, .env ve veritabanı sunulmaz', async () => {
    for (const path of ['/.env', '/../.env', '/%2e%2e/.env', '/..%2f.env', '/server.js', '/src/config.js', '/data/dev.db', '/prisma/schema.prisma', '/package.json', '/.git/config', '/js/../../.env']) {
      const res = await fetch(app.base + path, { redirect: 'manual' });
      const body = await res.text();
      assert.ok(res.status === 404 || res.status === 400 || res.status === 403, `${path} → ${res.status}`);
      assert.doesNotMatch(body, /RESEND_API_KEY|DATABASE_URL|SQLite format|\[core\]/);
    }
  });
});

// ============================================================================
describe('hız sınırları', () => {
  test('hesap başına başarısız giriş sınırı (farklı IP\'lerden dağıtık deneme)', async () => {
    const app = await startApp({ limits: { loginPerAccount: 5 } });
    try {
      const { email } = await registered(app.base);
      const c = client(app.base);
      for (let i = 0; i < 5; i++) {
        assert.equal((await c('/api/auth/login', { method: 'POST', body: { email, password: `yanlis-${i}-xxxx` } })).status, 401);
      }
      const blocked = await c('/api/auth/login', { method: 'POST', body: { email: email.toUpperCase(), password: STRONG } });
      assert.equal(blocked.status, 429, 'büyük harfle yazılmış aynı e-posta da sınırlanmalı');
      assert.equal(blocked.data.code, 'RATE_LIMITED');
      // Başka bir hesap etkilenmez
      const other = await registered(app.base);
      assert.equal((await client(app.base)('/api/auth/login', { method: 'POST', body: { email: other.email, password: STRONG } })).status, 200);
    } finally {
      await app.stop();
    }
  });

  test('başarılı girişler hesap sınırını tüketmez', async () => {
    const app = await startApp({ limits: { loginPerAccount: 3 } });
    try {
      const { email } = await registered(app.base);
      for (let i = 0; i < 6; i++) {
        assert.equal((await client(app.base)('/api/auth/login', { method: 'POST', body: { email, password: STRONG } })).status, 200, `giriş ${i + 1}`);
      }
    } finally {
      await app.stop();
    }
  });

  test('AI uçları kullanıcı başına sınırlanır (maliyet kötüye kullanımı)', async () => {
    const app = await startApp({ limits: { ai: 3 } });
    try {
      const { c } = await registered(app.base);
      for (let i = 0; i < 3; i++) assert.equal((await c('/api/analyze', { method: 'POST', body: { body: '500 adet banyo havlusu' } })).status, 200);
      const r = await c('/api/analyze', { method: 'POST', body: { body: '500 adet banyo havlusu' } });
      assert.equal(r.status, 429);
      assert.equal(r.data.code, 'RATE_LIMITED');
    } finally {
      await app.stop();
    }
  });
});

// ============================================================================
describe('günlükler', () => {
  test('canlı ortamda e-posta servisi yoksa doğrulama bağlantısı (token) günlüğe yazılmaz', async () => {
    const lines = [];
    const prod = createConsoleProvider({ log: (s) => lines.push(s), redact: true });
    await prod.send({ to: 'a@b.com', subject: 'Doğrula', text: 'Bağlantı: https://app.example/#verify=GIZLI_TOKEN_123', html: '' });
    assert.ok(lines.length > 0);
    assert.ok(!lines.join('\n').includes('GIZLI_TOKEN_123'), 'token günlüğe yazılmamalı');

    const devLines = [];
    const dev = createConsoleProvider({ log: (s) => devLines.push(s) });
    await dev.send({ to: 'a@b.com', subject: 'Doğrula', text: 'Bağlantı: #verify=DEV_TOKEN', html: '' });
    assert.ok(devLines.join('\n').includes('DEV_TOKEN'), 'geliştirmede bağlantı konsolda görünür');
  });
});
