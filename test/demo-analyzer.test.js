import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeRequestDemo, draftEmailTemplate } from '../public/js/demo-analyzer.js';
import { calculateQuote, createQuoteLines } from '../public/js/quote.js';

const catalog = JSON.parse(readFileSync(new URL('../public/data/catalog.json', import.meta.url)));
const samples = JSON.parse(readFileSync(new URL('../public/data/sample-requests.json', import.meta.url)));
const settings = { companyName: 'Test A.Ş.', contactName: 'Test', email: 't@t.com', phone: '', validityDays: 30, defaultPaymentTerms: 'Peşin' };

test('Bakü talebi: ürünler, miktarlar ve CIF tespit edilir', () => {
  const a = analyzeRequestDemo(samples[0], catalog);
  assert.equal(a.customer.company, 'Bakü Home');
  assert.equal(a.customer.country, 'Azerbaycan');
  assert.equal(a.incoterm, 'CIF');
  assert.deepEqual(a.items.map((i) => [i.productCode, i.quantity]), [['HVL-002', 5000], ['BRN-001', 400]]);
});

test('Almanya talebi: 12.000 adet ayrıştırılır, kademe indirimi uygulanır', () => {
  const a = analyzeRequestDemo(samples[1], catalog);
  assert.equal(a.urgency, 'yüksek');
  assert.equal(a.paymentTerms, 'Akreditif (L/C)');
  const q = calculateQuote({ lines: createQuoteLines(a, catalog), incoterm: a.incoterm, extraDiscountPercent: 0 }, catalog);
  const towel = q.lines.find((l) => l.code === 'HVL-003');
  assert.equal(towel.quantity, 12000);
  assert.equal(towel.discountPct, 8);
  assert.equal(towel.unitPrice, 3.31); // 3.60 * 0.92
});

test('Miktarsız talep MOQ ile fiyatlanır ve eksik bilgi olarak işaretlenir', () => {
  const a = analyzeRequestDemo(samples[2], catalog);
  assert.equal(a.items[0].productCode, 'PST-001');
  assert.equal(a.items[0].quantity, null);
  assert.ok(a.missingInfo.some((m) => m.includes('miktar')));
  const q = calculateQuote({ lines: createQuoteLines(a, catalog), incoterm: a.incoterm, extraDiscountPercent: 0 }, catalog);
  assert.equal(q.lines[0].quantity, 500);
  assert.ok(q.lines[0].quantityAssumed);
});

test('Incoterm, ek indirim ve elle fiyat girişi hesaba yansır', () => {
  const q = calculateQuote({ lines: [{ code: 'BRN-001', quantity: 400, priceOverride: null }], incoterm: 'CIF', extraDiscountPercent: 10 }, catalog);
  assert.equal(q.lines[0].unitPrice, 15.52); // 14.50 * 1.07
  assert.equal(q.subtotal, 6208);
  assert.equal(q.total, 5587.2);
  const o = calculateQuote({ lines: [{ code: 'BRN-001', quantity: 400, priceOverride: 15 }], incoterm: 'CIF', extraDiscountPercent: 0 }, catalog);
  assert.equal(o.total, 6000);
});

test('Şablon e-posta toplamı ve imzayı içerir', () => {
  const a = analyzeRequestDemo(samples[0], catalog);
  const q = calculateQuote({ lines: createQuoteLines(a, catalog), incoterm: a.incoterm, extraDiscountPercent: 0 }, catalog);
  const e = draftEmailTemplate({ request: samples[0], analysis: a, quote: q, settings });
  assert.match(e.body, /Sayın Rashad Aliyev/);
  assert.match(e.body, /35\.708,00 USD/);
  assert.match(e.body, /Test A\.Ş\./);
});
