// Sunucu API'si için uçtan uca testler (bellek içi SQLite + sahte e-posta gönderici).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEMO_MODE = '1'; // testler hiçbir zaman gerçek AI çağrısı yapmasın

const { createApp } = await import('../src/app.js');
const { createTestDb } = await import('./helpers/db.js');
const { loadConfig } = await import('../src/config.js');
const { createEmailService } = await import('../src/email/service.js');
const { createMemoryProvider } = await import('../src/email/providers.js');

const FRONTEND = 'http://frontend.test';
const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://app.test', CORS_ORIGINS: FRONTEND }, process.cwd());

const provider = createMemoryProvider();
const email = createEmailService({ provider, from: 'Test <test@example.test>', appUrl: config.appUrl, appName: 'EasyHustle' });
const lastMail = (to) => [...provider.sent].reverse().find((m) => m.to === to);
const tokenFrom = (mail, kind) => mail.text.match(new RegExp(`#${kind}=([\\w-]+)`))[1];

let server;
let base;
let db;
let testDb;

before(async () => {
  testDb = await createTestDb();
  db = testDb.db;
  const app = createApp({ db, email, config, limits: { auth: 1000, send: 1000 } });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await testDb?.cleanup();
});

/** Çerezleri saklayan küçük istemci (her kullanıcı için ayrı). */
function client() {
  let cookie = '';
  return async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('ita_session='));
    if (set) cookie = set.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* gövde yok */
    }
    return { status: res.status, data, setCookie: set };
  };
}

const sampleQuote = (company = 'Bakü Home', total = 100) => ({
  request: { from: 'A <a@b.az>', subject: 'Fiyat', body: '5000 adet banyo havlusu' },
  analysis: { customer: { company, email: 'a@b.az' }, items: [], missingInfo: [], salesNotes: [] },
  quoteInput: { lines: [{ code: 'HVL-002', quantity: 5000, priceOverride: null }], incoterm: 'CIF', extraDiscountPercent: 0 },
  email: { subject: 'Fiyat Teklifi', body: 'Merhaba', to: 'a@b.az' },
  total,
  currency: 'USD',
});

test('health: sağlık kontrolü 200 ve veritabanı durumu döner', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.checks.database, 'ok');
  assert.equal(body.environment, 'test');
  assert.equal(typeof body.uptimeSeconds, 'number');
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  assert.doesNotMatch(JSON.stringify(body), /KEY|SECRET|PASS|SMTP/i, 'gizli bilgi sızmamalı');
});

test('CORS: izinli adrese başlık verilir, izinsiz adrese verilmez', async () => {
  const pre = await fetch(`${base}/api/quotes`, {
    method: 'OPTIONS',
    headers: { Origin: FRONTEND, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), FRONTEND);
  assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);

  const get = await fetch(`${base}/api/health`, { headers: { Origin: FRONTEND } });
  assert.equal(get.headers.get('access-control-allow-origin'), FRONTEND);

  const evil = await fetch(`${base}/api/quotes`, { method: 'OPTIONS', headers: { Origin: 'https://kotu-site.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const evilGet = await fetch(`${base}/api/health`, { headers: { Origin: 'https://kotu-site.example' } });
  assert.equal(evilGet.headers.get('access-control-allow-origin'), null);
});

test('hata yönetimi: bilinmeyen uç 404, bozuk JSON 400, hepsi JSON', async () => {
  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Hata Test', email: 'hata@firma.com', password: 'gizli-sifre-h' } });
  const nf = await c('/api/boyle-bir-uc-yok');
  assert.equal(nf.status, 404);
  assert.match(nf.data.error, /bulunamadı/);
  assert.equal((await client()('/api/boyle-bir-uc-yok')).status, 404, 'girişsiz de 404 olmalı');

  const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bozuk' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Geçersiz JSON.', code: 'INVALID_JSON' });
});

test('yapılandırma: geçersiz değerler ve canlı ortamda eksik APP_URL reddedilir', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }, process.cwd()), /PORT/);
  assert.throws(() => loadConfig({ CORS_ORIGINS: 'ornek.com' }, process.cwd()), /Geçersiz adres/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }, process.cwd()), /APP_URL/);
  const ok = loadConfig({ NODE_ENV: 'production', APP_URL: 'https://ornek.com/', CORS_ORIGINS: 'https://a.com, https://b.com/' }, process.cwd());
  assert.equal(ok.appUrl, 'https://ornek.com');
  assert.deepEqual(ok.corsOrigins, ['https://a.com', 'https://b.com']);
  assert.equal(ok.isProduction, true);
});

test('status: auth özelliği bildirilir', async () => {
  const r = await client()('/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.auth, true);
  assert.equal(r.data.mode, 'demo');
});

test('girişsiz: analiz ve veri uçları 401 döner, statik dosyalar açıktır', async () => {
  const c = client();
  assert.equal((await c('/api/analyze', { method: 'POST', body: { body: 'test' } })).status, 401);
  assert.equal((await c('/api/quotes')).status, 401);
  assert.equal((await c('/api/settings')).status, 401);
  assert.deepEqual((await c('/api/auth/me')).data, { user: null });
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /authDialog/);
});

test('kayıt, giriş, çıkış akışı', async () => {
  const c = client();
  const weak = await c('/api/auth/register', { method: 'POST', body: { name: 'Ayşe', email: 'ayse@firma.com', password: '123' } });
  assert.equal(weak.status, 400);
  assert.match(weak.data.error, /en az 8/);

  const reg = await c('/api/auth/register', { method: 'POST', body: { name: 'Ayşe Yılmaz', email: 'Ayse@Firma.com', password: 'gizli-sifre-1' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.email, 'ayse@firma.com');
  assert.equal(reg.data.user.emailVerified, false);
  assert.ok(!('passwordHash' in reg.data.user), 'şifre hash\'i API yanıtında olmamalı');
  assert.equal(reg.data.user.username, 'Ayşe Yılmaz', 'arayüzün "name" alanı username olarak kaydedilir');
  assert.match(reg.setCookie, /HttpOnly/i);
  assert.match(reg.setCookie, /SameSite=Lax/i);
  assert.ok(lastMail('ayse@firma.com'), 'doğrulama e-postası gönderilmeli');

  const dup = await c('/api/auth/register', { method: 'POST', body: { name: 'Başka Kişi', email: 'ayse@firma.com', password: 'baska-sifre-1' } });
  assert.equal(dup.status, 409);

  assert.equal((await c('/api/auth/me')).data.user.name, 'Ayşe Yılmaz');
  assert.equal((await c('/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await c('/api/auth/me')).data.user, null);

  const c2 = client();
  const bad = await c2('/api/auth/login', { method: 'POST', body: { email: 'ayse@firma.com', password: 'yanlis-sifre' } });
  assert.equal(bad.status, 401);
  const noUser = await c2('/api/auth/login', { method: 'POST', body: { email: 'yok@firma.com', password: 'yanlis-sifre' } });
  assert.equal(noUser.status, 401);
  assert.equal(noUser.data.error, bad.data.error, 'kullanıcı var/yok aynı mesaj');
  const ok = await c2('/api/auth/login', { method: 'POST', body: { email: 'AYSE@firma.com', password: 'gizli-sifre-1' } });
  assert.equal(ok.status, 200);

  const analysis = await c2('/api/analyze', { method: 'POST', body: { from: '', subject: '', body: '5000 adet 70x140 banyo havlusu, CIF Bakü' } });
  assert.equal(analysis.status, 200);
  assert.equal(analysis.data.items[0].productCode, 'HVL-002');
});

test('firma ayarları kaydedilir ve okunur', async () => {
  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Mehmet', email: 'mehmet@firma.com', password: 'gizli-sifre-2' } });
  assert.equal((await c('/api/settings')).data.settings, null);
  const bad = await c('/api/settings', { method: 'PUT', body: { companyName: '', contactName: 'M', validityDays: 30 } });
  assert.equal(bad.status, 400);
  const s = { companyName: 'Mehmet Tekstil', contactName: 'Mehmet', email: 'satis@mehmet.com', phone: '1', validityDays: '45', defaultPaymentTerms: 'Peşin' };
  assert.equal((await c('/api/settings', { method: 'PUT', body: s })).status, 200);
  const got = (await c('/api/settings')).data.settings;
  assert.equal(got.companyName, 'Mehmet Tekstil');
  assert.equal(got.validityDays, 45);
});

test('teklifler: oluştur, güncelle, listele, sil; kullanıcılar birbirinin verisini göremez', async () => {
  const a = client();
  const b = client();
  await a('/api/auth/register', { method: 'POST', body: { name: 'A Kullanıcı', email: 'a@firma.com', password: 'gizli-sifre-a' } });
  await b('/api/auth/register', { method: 'POST', body: { name: 'B Kullanıcı', email: 'b@firma.com', password: 'gizli-sifre-b' } });

  const created = await a('/api/quotes', { method: 'POST', body: sampleQuote() });
  assert.equal(created.status, 201);
  const id = created.data.quote.id;
  assert.match(id, /^teklif-/);
  assert.equal(created.data.quote.status, 'draft');
  assert.equal(created.data.quote.quoteInput.lines[0].code, 'HVL-002');

  const updated = await a(`/api/quotes/${id}`, { method: 'PUT', body: sampleQuote('Bakü Home', 250) });
  assert.equal(updated.data.quote.total, 250);
  assert.equal((await a('/api/quotes')).data.quotes.length, 1);

  // B, A'nın teklifini göremez / değiştiremez / silemez
  assert.equal((await b('/api/quotes')).data.quotes.length, 0);
  assert.equal((await b(`/api/quotes/${id}`, { method: 'PUT', body: sampleQuote() })).status, 404);
  assert.equal((await b(`/api/quotes/${id}`, { method: 'DELETE' })).status, 404);

  assert.equal((await a(`/api/quotes/${id}/status`, { method: 'PATCH', body: { status: 'accepted' } })).data.quote.status, 'accepted');
  assert.equal((await a(`/api/quotes/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await a('/api/quotes')).data.quotes.length, 0);
});

test('tarayıcıdaki teklifler hesaba aktarılır', async () => {
  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'İthal', email: 'import@firma.com', password: 'gizli-sifre-i' } });
  const local = [
    { ...sampleQuote('Yeni', 2), id: 'teklif-2', savedAt: '2026-11-02T10:00:00.000Z' },
    { ...sampleQuote('Eski', 1), id: 'teklif-1', savedAt: '2026-11-01T10:00:00.000Z' },
  ];
  const r = await c('/api/quotes/import', { method: 'POST', body: { quotes: local } });
  assert.equal(r.data.imported, 2);
  const list = (await c('/api/quotes')).data.quotes;
  assert.deepEqual(list.map((q) => q.analysis.customer.company), ['Yeni', 'Eski']);
});

test('e-posta gönderimi doğrulama gerektirir; doğrulandıktan sonra gönderilir ve teklif "sent" olur', async () => {
  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Gönderen', email: 'gonderen@firma.com', password: 'gizli-sifre-g' } });
  const { id } = (await c('/api/quotes', { method: 'POST', body: sampleQuote() })).data.quote;
  const mail = { to: 'musteri@bakuhome.az', subject: 'Fiyat Teklifi', body: 'Merhaba', quoteId: id };

  assert.equal((await c('/api/email/send', { method: 'POST', body: mail })).status, 403);

  const token = tokenFrom(lastMail('gonderen@firma.com'), 'verify');
  const v = await client()('/api/auth/verify-email', { method: 'POST', body: { token } });
  assert.equal(v.data.user.emailVerified, true);
  assert.equal((await client()('/api/auth/verify-email', { method: 'POST', body: { token } })).status, 400, 'token tek kullanımlık');

  assert.equal((await c('/api/email/send', { method: 'POST', body: { ...mail, to: 'gecersiz' } })).status, 400);
  const sent = await c('/api/email/send', { method: 'POST', body: mail });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.delivered, true);
  const out = lastMail('musteri@bakuhome.az');
  assert.equal(out.subject, 'Fiyat Teklifi');
  assert.equal(out.replyTo, 'gonderen@firma.com');
  assert.equal((await c('/api/quotes')).data.quotes[0].status, 'sent');
  assert.equal(await db.emailLog.count({ where: { toAddress: 'musteri@bakuhome.az' } }), 1);
});

test('şifre sıfırlama: bağlantı tek kullanımlık, eski oturumlar kapanır', async () => {
  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Unutkan', email: 'unutkan@firma.com', password: 'eski-sifre-1' } });

  const unknown = await client()('/api/auth/forgot-password', { method: 'POST', body: { email: 'kimse@firma.com' } });
  assert.equal(unknown.status, 200, 'hesap yoksa da aynı yanıt');

  await client()('/api/auth/forgot-password', { method: 'POST', body: { email: 'unutkan@firma.com' } });
  const token = tokenFrom(lastMail('unutkan@firma.com'), 'reset');

  const r = client();
  assert.equal((await r('/api/auth/reset-password', { method: 'POST', body: { token, password: 'kisa' } })).status, 400);
  const ok = await r('/api/auth/reset-password', { method: 'POST', body: { token, password: 'yeni-sifre-1' } });
  assert.equal(ok.status, 200);
  assert.equal((await r('/api/auth/me')).data.user.email, 'unutkan@firma.com');
  assert.equal((await c('/api/auth/me')).data.user, null, 'eski oturum kapanmalı');
  assert.equal((await client()('/api/auth/reset-password', { method: 'POST', body: { token, password: 'baska-sifre-1' } })).status, 400);

  const login = client();
  assert.equal((await login('/api/auth/login', { method: 'POST', body: { email: 'unutkan@firma.com', password: 'eski-sifre-1' } })).status, 401);
  assert.equal((await login('/api/auth/login', { method: 'POST', body: { email: 'unutkan@firma.com', password: 'yeni-sifre-1' } })).status, 200);
});

test('başka siteden gelen istekler reddedilir', async () => {
  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Csrf', email: 'csrf@firma.com', password: 'gizli-sifre-c' } });
  const r = await c('/api/quotes', { method: 'POST', body: sampleQuote(), headers: { Origin: 'https://kotu-site.example' } });
  assert.equal(r.status, 403);
  const same = await c('/api/quotes', { method: 'POST', body: sampleQuote(), headers: { Origin: base } });
  assert.equal(same.status, 201);
});
