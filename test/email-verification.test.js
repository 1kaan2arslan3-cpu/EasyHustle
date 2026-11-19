// E-posta doğrulama akışı uçtan uca: kayıt → Resend'e gerçek HTTP isteği (sahte Resend sunucusu) →
// e-postadaki bağlantıdan token → doğrulama → tekrar kullanım / süre dolumu / tekrar gönderme / sağlayıcı hataları.
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DEMO_MODE = '1';

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { createTestDb } = await import('./helpers/db.js');
const { createEmailServiceFromConfig } = await import('../src/email/service.js');
const { createResendProvider, EmailSendError } = await import('../src/email/providers.js');
const { verificationEmail } = await import('../src/email/templates.js');
const { hashToken } = await import('../src/email-tokens.js');

const API_KEY = 're_test_ABCdef123456789';
const FROM = 'EasyHustle <no-reply@easyhustle.test>';

// ---- Sahte Resend API ----------------------------------------------------------------
const resend = {
  requests: [],
  mode: 'ok', // 'ok' | 'reject' | 'down'
  server: null,
  url: null,
  last() {
    return this.requests.at(-1);
  },
};

function startFakeResend() {
  resend.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      resend.requests.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      if (resend.mode === 'reject') {
        res.statusCode = 422;
        return res.end(JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'The from address domain is not verified.' }));
      }
      if (resend.mode === 'down') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ statusCode: 500, name: 'internal_server_error', message: 'Unexpected error' }));
      }
      res.end(JSON.stringify({ id: `email_${resend.requests.length}` }));
    });
  });
  return new Promise((resolve) => resend.server.listen(0, '127.0.0.1', resolve)).then(() => {
    resend.url = `http://127.0.0.1:${resend.server.address().port}`;
  });
}

// ---- Uygulama -------------------------------------------------------------------------
let app;
let base;
let db;
let testDb;
let server;

before(async () => {
  await startFakeResend();
  testDb = await createTestDb();
  db = testDb.db;
  const config = loadConfig(
    { NODE_ENV: 'test', APP_URL: 'http://app.test', RESEND_API_KEY: API_KEY, RESEND_API_URL: resend.url, MAIL_FROM: FROM, MAIL_REPLY_TO: 'destek@easyhustle.test' },
    process.cwd(),
  );
  const email = createEmailServiceFromConfig(config);
  assert.equal(email.providerName, 'resend');
  app = createApp({ db, email, config, limits: { auth: 1000, send: 1000, resend: 3 } });
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  await new Promise((r) => resend.server?.close(r));
  await testDb?.cleanup();
});
beforeEach(() => {
  resend.mode = 'ok';
});

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('ita_session='));
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null, text, headers: res.headers };
  };
}

let seq = 0;
async function registerUser(username = 'Deniz') {
  const c = client();
  const address = `kullanici${++seq}@ornek.com`;
  const r = await c('/api/auth/register', { method: 'POST', body: { username, email: address, password: 'guclu-sifre-2026' } });
  return { c, r, address };
}

/** Son e-postadaki doğrulama bağlantısından token'ı çıkarır (hem HTML hem metin sürümünde olmalı). */
function tokenFromLastEmail() {
  const { body } = resend.last();
  const fromText = body.text.match(/#verify=([\w-]+)/)?.[1];
  const fromHtml = body.html.match(/href="http:\/\/app\.test\/#verify=([\w-]+)"/)?.[1];
  assert.ok(fromText, 'metin sürümünde bağlantı olmalı');
  assert.equal(fromHtml, fromText, 'HTML butonundaki bağlantı ile metin sürümündeki aynı olmalı');
  return fromText;
}

const backdateLastToken = (userId, seconds) =>
  db.emailToken.updateMany({ where: { userId, type: 'verify', usedAt: null }, data: { createdAt: new Date(Date.now() - seconds * 1000) } });

// ---- Testler ---------------------------------------------------------------------------

describe('kayıt sonrası doğrulama e-postası (Resend)', () => {
  test('Resend API\'sine doğru istek gider ve yanıt "gönderildi" der', async () => {
    const before = resend.requests.length;
    const { r, address } = await registerUser('Deniz Kaya');
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.verificationEmail, { sent: true, delivery: 'resend' });
    assert.equal(r.data.user.emailVerified, false);

    assert.equal(resend.requests.length, before + 1);
    const req = resend.last();
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/emails');
    assert.equal(req.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.body.from, FROM);
    assert.deepEqual(req.body.to, [address]);
    assert.equal(req.body.reply_to, 'destek@easyhustle.test');
    assert.equal(req.body.subject, 'EasyHustle hesabınızı doğrulayın');
    assert.match(req.body.html, /^<!doctype html>/);
    assert.match(req.body.html, /E-posta adresimi doğrula/);
    assert.match(req.body.html, /EasyHustle/);
    assert.match(req.body.text, /24 saat geçerlidir/);

    assert.ok(!r.text.includes(API_KEY), 'API anahtarı yanıtta olmamalı');
  });

  test('token rastgele, tek kullanımlık; veritabanında yalnızca SHA-256 özeti var; 24 saat geçerli', async () => {
    const { r } = await registerUser();
    const token = tokenFromLastEmail();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, '256 bit base64url');

    const rows = await db.emailToken.findMany({ where: { userId: r.data.user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'verify');
    assert.equal(rows[0].tokenHash, hashToken(token));
    assert.notEqual(rows[0].tokenHash, token);
    assert.equal(rows[0].usedAt, null);
    const hours = (rows[0].expiresAt.getTime() - Date.now()) / 3.6e6;
    assert.ok(hours > 23.9 && hours <= 24, `süre ~24 saat olmalı, ${hours}`);

    const dump = JSON.stringify(await db.$queryRaw`SELECT * FROM email_tokens`);
    assert.ok(!dump.includes(token), 'düz token veritabanında hiçbir yerde olmamalı');

    await registerUser();
    assert.notEqual(tokenFromLastEmail(), token, 'her token farklı');
  });

  test('HTML şablonu kullanıcı girdisini kaçışlar, harici görsel içermez', () => {
    const { html, text, subject } = verificationEmail({
      appName: 'EasyHustle',
      username: '<img src=x onerror=alert(1)>',
      email: 'a@b.com',
      url: 'https://app.test/#verify=abc',
      expiresInHours: 24,
    });
    assert.ok(!html.includes('<img'), 'kullanıcı adı HTML olarak yorumlanmamalı');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<script|src="http/i);
    assert.match(text, /https:\/\/app\.test\/#verify=abc/);
    assert.equal(subject, 'EasyHustle hesabınızı doğrulayın');
  });
});

describe('doğrulama ucu', () => {
  test('geçerli token: emailVerified=true olur, /me de doğrulanmış gösterir', async () => {
    const { c, r } = await registerUser();
    const token = tokenFromLastEmail();
    const v = await client()('/api/auth/verify-email', { method: 'POST', body: { token } });
    assert.equal(v.status, 200);
    assert.equal(v.data.user.emailVerified, true);
    assert.equal((await db.user.findUnique({ where: { id: r.data.user.id } })).emailVerified, true);
    assert.equal((await c('/api/auth/me')).data.user.emailVerified, true);
    const row = await db.emailToken.findFirst({ where: { userId: r.data.user.id } });
    assert.ok(row.usedAt instanceof Date, 'token kullanılmış işaretlenmeli');
  });

  test('kullanılmış token tekrar kullanılamaz', async () => {
    await registerUser();
    const token = tokenFromLastEmail();
    assert.equal((await client()('/api/auth/verify-email', { method: 'POST', body: { token } })).status, 200);
    const again = await client()('/api/auth/verify-email', { method: 'POST', body: { token } });
    assert.equal(again.status, 400);
    assert.equal(again.data.code, 'INVALID_TOKEN');
  });

  test('aynı token\'la eşzamanlı iki istekten yalnızca biri başarılı olur', async () => {
    await registerUser();
    const token = tokenFromLastEmail();
    const results = await Promise.all([1, 2, 3].map(() => client()('/api/auth/verify-email', { method: 'POST', body: { token } })));
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 400, 400]);
  });

  test('süresi dolmuş token reddedilir, kullanıcı doğrulanmamış kalır', async () => {
    const { r } = await registerUser();
    const token = tokenFromLastEmail();
    await db.emailToken.updateMany({ where: { userId: r.data.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const v = await client()('/api/auth/verify-email', { method: 'POST', body: { token } });
    assert.equal(v.status, 400);
    assert.equal(v.data.code, 'INVALID_TOKEN');
    assert.equal((await db.user.findUnique({ where: { id: r.data.user.id } })).emailVerified, false);
  });

  test('uydurma, eksik veya şifre sıfırlama token\'ı doğrulama yapamaz', async () => {
    const c = client();
    assert.equal((await c('/api/auth/verify-email', { method: 'POST', body: { token: 'a'.repeat(43) } })).data.code, 'INVALID_TOKEN');
    assert.equal((await c('/api/auth/verify-email', { method: 'POST', body: {} })).data.code, 'VALIDATION_ERROR');
    assert.equal((await c('/api/auth/verify-email', { method: 'POST', body: { token: 'kisa' } })).data.code, 'VALIDATION_ERROR');

    const { address } = await registerUser();
    await c('/api/auth/forgot-password', { method: 'POST', body: { email: address } });
    const resetToken = resend.last().body.text.match(/#reset=([\w-]+)/)[1];
    assert.equal((await c('/api/auth/verify-email', { method: 'POST', body: { token: resetToken } })).data.code, 'INVALID_TOKEN');
  });
});

describe('doğrulama e-postasını tekrar gönderme', () => {
  test('giriş gerektirir', async () => {
    const r = await client()('/api/auth/resend-verification', { method: 'POST' });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'UNAUTHENTICATED');
  });

  test('60 sn bekleme süresi; sonra yeni token gönderilir ve eski token geçersiz olur', async () => {
    const { c, r } = await registerUser();
    const oldToken = tokenFromLastEmail();

    const tooSoon = await c('/api/auth/resend-verification', { method: 'POST' });
    assert.equal(tooSoon.status, 429);
    assert.equal(tooSoon.data.code, 'RATE_LIMITED');
    assert.ok(Number(tooSoon.headers.get('retry-after')) > 0 && Number(tooSoon.headers.get('retry-after')) <= 60);

    await backdateLastToken(r.data.user.id, 61);
    const count = resend.requests.length;
    const again = await c('/api/auth/resend-verification', { method: 'POST' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.data, { ok: true, sent: true, delivery: 'resend' });
    assert.equal(resend.requests.length, count + 1);
    const newToken = tokenFromLastEmail();
    assert.notEqual(newToken, oldToken);

    assert.equal((await client()('/api/auth/verify-email', { method: 'POST', body: { token: oldToken } })).status, 400, 'eski token geçersiz');
    assert.equal((await client()('/api/auth/verify-email', { method: 'POST', body: { token: newToken } })).status, 200);

    const done = await c('/api/auth/resend-verification', { method: 'POST' });
    assert.deepEqual(done.data, { ok: true, alreadyVerified: true, sent: false });
  });

  test('kullanıcı başına saatlik sınır (testte 3)', async () => {
    const { c, r } = await registerUser();
    for (let i = 0; i < 3; i++) {
      await backdateLastToken(r.data.user.id, 61);
      assert.equal((await c('/api/auth/resend-verification', { method: 'POST' })).status, 200, `gönderim ${i + 1}`);
    }
    await backdateLastToken(r.data.user.id, 61);
    const blocked = await c('/api/auth/resend-verification', { method: 'POST' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'RATE_LIMITED');
  });
});

describe('sağlayıcı hataları — "gönderildi" denmez', () => {
  test('kayıtta Resend hata döndürürse hesap oluşur ama yanıt gönderilmediğini söyler', async () => {
    resend.mode = 'reject';
    const { r } = await registerUser();
    assert.equal(r.status, 201);
    assert.equal(r.data.verificationEmail.sent, false);
    assert.equal(r.data.verificationEmail.delivery, 'resend');
    assert.match(r.data.verificationEmail.error, /gönderilemedi/);
    assert.ok(!r.text.includes(API_KEY));
    assert.equal(r.data.user.emailVerified, false);
  });

  test('tekrar gönderimde Resend hata verirse 502 EMAIL_SEND_FAILED', async () => {
    const { c, r } = await registerUser();
    await backdateLastToken(r.data.user.id, 61);
    resend.mode = 'down';
    const fail = await c('/api/auth/resend-verification', { method: 'POST' });
    assert.equal(fail.status, 502);
    assert.equal(fail.data.code, 'EMAIL_SEND_FAILED');
    assert.ok(!fail.text.includes(API_KEY));
  });

  test('Resend sağlayıcısı: hata, zaman aşımı ve bağlantı hatası EmailSendError olur', async () => {
    resend.mode = 'reject';
    const p = createResendProvider({ apiKey: API_KEY, baseUrl: resend.url });
    await assert.rejects(p.send({ from: FROM, to: 'a@b.com', subject: 's', html: 'h', text: 't' }), (err) => {
      assert.ok(err instanceof EmailSendError);
      assert.equal(err.status, 422);
      assert.equal(err.providerCode, 'validation_error');
      assert.equal(err.retryable, false);
      assert.ok(!err.message.includes(API_KEY));
      return true;
    });

    const offline = createResendProvider({ apiKey: API_KEY, baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(offline.send({ from: FROM, to: 'a@b.com', subject: 's', html: 'h', text: 't' }), (err) => err instanceof EmailSendError && err.retryable);

    const hanging = createResendProvider({ apiKey: API_KEY, baseUrl: resend.url, timeoutMs: 1, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))) });
    await assert.rejects(hanging.send({ from: FROM, to: 'a@b.com', subject: 's', html: 'h', text: 't' }), /zamanında yanıt vermedi/);
  });
});

describe('yapılandırma', () => {
  test('geçersiz anahtar / gönderen reddedilir; anahtar yoksa geliştirme (konsol) modu', () => {
    assert.throws(() => loadConfig({ RESEND_API_KEY: 'sk-yanlis' }, process.cwd()), /re_/);
    assert.throws(() => loadConfig({ MAIL_FROM: 'adres-degil' }, process.cwd()), /MAIL_FROM/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_URL: 'https://a.example', RESEND_API_KEY: API_KEY }, process.cwd()), /MAIL_FROM/);
    const dev = loadConfig({}, process.cwd());
    assert.equal(dev.email.resendApiKey, null);
    assert.equal(dev.email.from, 'EasyHustle <onboarding@resend.dev>');
    assert.equal(createEmailServiceFromConfig(dev).providerName, 'console');
    assert.equal(createEmailServiceFromConfig(dev).delivers, false);
  });
});
