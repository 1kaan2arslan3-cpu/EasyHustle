// Brevo sağlayıcısı: sahte Brevo HTTP API'sine gerçek istek → istek biçimi, hata eşlemesi,
// yapılandırma (Brevo öncelikli, MAIL_FROM zorunlu) ve kayıt akışında doğrulama e-postası.
import { test, before, after, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DEMO_MODE = '1';

const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { createTestDb } = await import('./helpers/db.js');
const { createEmailServiceFromConfig } = await import('../src/email/service.js');
const { createBrevoProvider, parseMailbox, EmailSendError } = await import('../src/email/providers.js');

const API_KEY = 'xkeysib-test0123456789abcdef0123456789-ABCDEFGH';
const FROM = 'EasyHustle <gonderen@gmail.test>';

const brevo = {
  requests: [],
  mode: 'ok', // 'ok' | 'reject' | 'unauthorized' | 'down'
  server: null,
  url: null,
  last() {
    return this.requests.at(-1);
  },
};

function startFakeBrevo() {
  brevo.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      brevo.requests.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      if (brevo.mode === 'reject') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ code: 'invalid_parameter', message: 'Sender is not valid' }));
      }
      if (brevo.mode === 'unauthorized') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }));
      }
      if (brevo.mode === 'down') {
        res.statusCode = 503;
        return res.end('Service Unavailable');
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ messageId: `<msg-${brevo.requests.length}@smtp-relay.mailin.fr>` }));
    });
  });
  return new Promise((resolve) => brevo.server.listen(0, '127.0.0.1', resolve)).then(() => {
    brevo.url = `http://127.0.0.1:${brevo.server.address().port}/v3`;
  });
}

let app;
let base;
let testDb;
let server;

before(async () => {
  await startFakeBrevo();
  testDb = await createTestDb();
  const config = loadConfig(
    { NODE_ENV: 'test', APP_URL: 'http://app.test', BREVO_API_KEY: API_KEY, BREVO_API_URL: brevo.url, MAIL_FROM: FROM, MAIL_REPLY_TO: 'destek@easyhustle.test' },
    process.cwd(),
  );
  const email = createEmailServiceFromConfig(config);
  assert.equal(email.providerName, 'brevo');
  assert.equal(email.delivers, true);
  app = createApp({ db: testDb.db, email, config, limits: { auth: 1000, send: 1000, resend: 1000 } });
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  await new Promise((r) => brevo.server?.close(r));
  await testDb?.cleanup();
});
beforeEach(() => {
  brevo.mode = 'ok';
});

async function register(address) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Deniz', email: address, password: 'guclu-sifre-2026' }),
  });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text), text };
}

describe('Brevo ile doğrulama e-postası', () => {
  test('kayıtta Brevo API\'sine doğru biçimde istek gider ve yanıt "gönderildi" der', async () => {
    const before = brevo.requests.length;
    const r = await register('brevo1@ornek.com');
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.verificationEmail, { sent: true, delivery: 'brevo' });
    assert.equal(brevo.requests.length, before + 1);

    const req = brevo.last();
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v3/smtp/email');
    assert.equal(req.headers['api-key'], API_KEY);
    assert.equal(req.headers.authorization, undefined);
    assert.deepEqual(req.body.sender, { name: 'EasyHustle', email: 'gonderen@gmail.test' });
    assert.deepEqual(req.body.to, [{ email: 'brevo1@ornek.com' }]);
    assert.deepEqual(req.body.replyTo, { email: 'destek@easyhustle.test' });
    assert.match(req.body.subject, /doğrula/i);
    assert.match(req.body.textContent, /http:\/\/app\.test\/#verify=[\w-]+/);
    assert.match(req.body.htmlContent, /href="http:\/\/app\.test\/#verify=[\w-]+"/);
    assert.ok(!r.text.includes(API_KEY), 'API anahtarı yanıtta görünmemeli');
  });

  test('Brevo hata döndürürse hesap oluşur ama yanıt gönderilmediğini söyler', async () => {
    brevo.mode = 'reject';
    const r = await register('brevo2@ornek.com');
    assert.equal(r.status, 201);
    assert.equal(r.data.verificationEmail.sent, false);
    assert.equal(r.data.verificationEmail.delivery, 'brevo');
    assert.ok(!r.text.includes(API_KEY));
  });
});

describe('Brevo sağlayıcısı', () => {
  const msg = { from: FROM, to: 'a@b.com', subject: 's', html: 'h', text: 't' };

  test('hatalar EmailSendError olur; anahtar mesajda yer almaz', async () => {
    const p = createBrevoProvider({ apiKey: API_KEY, baseUrl: brevo.url });

    brevo.mode = 'reject';
    await assert.rejects(p.send(msg), (err) => {
      assert.ok(err instanceof EmailSendError);
      assert.equal(err.status, 400);
      assert.equal(err.providerCode, 'invalid_parameter');
      assert.equal(err.retryable, false);
      assert.match(err.message, /Sender is not valid/);
      assert.ok(!err.message.includes(API_KEY));
      return true;
    });

    brevo.mode = 'unauthorized';
    await assert.rejects(p.send(msg), (err) => err.status === 401 && !err.retryable);

    brevo.mode = 'down';
    await assert.rejects(p.send(msg), (err) => err.status === 503 && err.retryable && /HTTP 503/.test(err.message));

    const offline = createBrevoProvider({ apiKey: API_KEY, baseUrl: 'http://127.0.0.1:1/v3' });
    await assert.rejects(offline.send(msg), (err) => err instanceof EmailSendError && err.retryable);

    const hanging = createBrevoProvider({
      apiKey: API_KEY,
      baseUrl: brevo.url,
      timeoutMs: 1,
      fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))),
    });
    await assert.rejects(hanging.send(msg), /zamanında yanıt vermedi/);
  });

  test('gönderen adres ayrıştırma', () => {
    assert.deepEqual(parseMailbox('EasyHustle <a@b.com>'), { name: 'EasyHustle', email: 'a@b.com' });
    assert.deepEqual(parseMailbox('"Easy Hustle" <a@b.com>'), { name: 'Easy Hustle', email: 'a@b.com' });
    assert.deepEqual(parseMailbox('<a@b.com>'), { email: 'a@b.com' });
    assert.deepEqual(parseMailbox(' a@b.com '), { email: 'a@b.com' });
  });
});

describe('Brevo yapılandırması', () => {
  test('anahtar biçimi denetlenir, MAIL_FROM zorunlu, Brevo Resend\'den önceliklidir', () => {
    assert.throws(() => loadConfig({ BREVO_API_KEY: 're_yanlis_anahtar_123', MAIL_FROM: FROM }, process.cwd()), /xkeysib-/);
    assert.throws(() => loadConfig({ BREVO_API_KEY: API_KEY }, process.cwd()), /MAIL_FROM/);
    const both = loadConfig({ BREVO_API_KEY: API_KEY, RESEND_API_KEY: 're_test_ABCdef123456789', MAIL_FROM: FROM }, process.cwd());
    assert.equal(createEmailServiceFromConfig(both).providerName, 'brevo');
    const dev = loadConfig({}, process.cwd());
    assert.equal(dev.email.brevoApiKey, null);
    assert.equal(createEmailServiceFromConfig(dev).providerName, 'console');
  });
});
