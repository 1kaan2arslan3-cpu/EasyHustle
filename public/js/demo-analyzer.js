// Kural tabanlı "demo" analiz motoru.
// API anahtarı yokken (veya GitHub Pages'te statik demo çalışırken) AI'ın yerine geçer.
// Çıktı biçimi AI analiziyle birebir aynıdır, böylece arayüz iki modda da aynı çalışır.

import { formatMoney, formatNumber } from './quote.js';

const lower = (s) => (s || '').toLocaleLowerCase('tr-TR');

const CITY_TO_COUNTRY = {
  'bakü': 'Azerbaycan', 'baku': 'Azerbaycan', 'gence': 'Azerbaycan',
  'münih': 'Almanya', 'berlin': 'Almanya', 'hamburg': 'Almanya', 'frankfurt': 'Almanya', 'köln': 'Almanya',
  'dubai': 'Birleşik Arap Emirlikleri', 'abu dabi': 'Birleşik Arap Emirlikleri',
  'londra': 'Birleşik Krallık', 'paris': 'Fransa', 'amsterdam': 'Hollanda', 'rotterdam': 'Hollanda',
  'tiflis': 'Gürcistan', 'batum': 'Gürcistan', 'erbil': 'Irak', 'bağdat': 'Irak',
  'riyad': 'Suudi Arabistan', 'cidde': 'Suudi Arabistan', 'doha': 'Katar', 'moskova': 'Rusya',
  'almatı': 'Kazakistan', 'taşkent': 'Özbekistan', 'viyana': 'Avusturya', 'milano': 'İtalya', 'madrid': 'İspanya',
};
const COUNTRIES = ['Almanya', 'Azerbaycan', 'Fransa', 'Hollanda', 'İngiltere', 'Birleşik Krallık', 'Irak', 'Gürcistan',
  'Katar', 'Suudi Arabistan', 'Rusya', 'Kazakistan', 'Özbekistan', 'Avusturya', 'İtalya', 'İspanya', 'Birleşik Arap Emirlikleri', 'ABD'];
const TLD_TO_COUNTRY = {
  az: 'Azerbaycan', de: 'Almanya', ae: 'Birleşik Arap Emirlikleri', fr: 'Fransa', uk: 'Birleşik Krallık', nl: 'Hollanda',
  iq: 'Irak', ge: 'Gürcistan', sa: 'Suudi Arabistan', qa: 'Katar', ru: 'Rusya', kz: 'Kazakistan', uz: 'Özbekistan',
  at: 'Avusturya', it: 'İtalya', es: 'İspanya',
};
const MONTHS = 'Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık';

function parseQuantity(raw) {
  // "12.000" / "12,000" / "5000"
  return Number(raw.replace(/[.,](?=\d{3}\b)/g, ''));
}

function parseFrom(from) {
  const m = (from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() };
  const email = (from || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return { name: null, email: email ? email[0] : null };
}

function findCompany(text, email) {
  const legal = text.match(/([A-ZÇĞİÖŞÜ][\w&çğıöşüÇĞİÖŞÜ.-]*(?:\s+[A-ZÇĞİÖŞÜ][\w&çğıöşüÇĞİÖŞÜ.-]*){0,3}\s+(?:GmbH|Ltd\.?|LLC|A\.Ş\.|Inc\.?|S\.A\.|B\.V\.|FZE|FZCO))/);
  if (legal) return legal[1].trim();
  const sirket = text.match(/([A-ZÇĞİÖŞÜ][\wçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][\wçğıöşü]+){0,2})\s+şirketinden/);
  if (sirket) return sirket[1].replace(/^(Ben|Biz)\s+/, '').trim();
  if (email) {
    const domain = email.split('@')[1].split('.')[0];
    if (!/^(gmail|hotmail|outlook|yahoo|yandex|icloud|mail)$/i.test(domain)) {
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    }
  }
  return null;
}

function findLocation(text, email) {
  const t = lower(text);
  for (const [city, country] of Object.entries(CITY_TO_COUNTRY)) {
    if (t.includes(city)) {
      const cityName = city.charAt(0).toLocaleUpperCase('tr-TR') + city.slice(1);
      return { city: cityName, country };
    }
  }
  const country = COUNTRIES.find((c) => t.includes(lower(c)));
  if (country) return { city: null, country };
  const tld = email && email.split('.').pop().toLowerCase();
  return { city: null, country: (tld && TLD_TO_COUNTRY[tld]) || null };
}

function findItems(body, catalog) {
  const segments = body
    .split(/\n|;|\s+ve\s+|,(?!\d)|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const items = [];
  const qtyRe = /(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(adet|takım|pcs|pieces|set|tane)\b/i;

  for (const seg of segments) {
    const s = lower(seg);
    let best = null;
    for (const p of catalog.products) {
      for (const kw of p.keywords) {
        if (s.includes(lower(kw)) && (!best || kw.length > best.kw.length)) best = { product: p, kw };
      }
    }
    const q = seg.match(qtyRe);
    if (best) {
      items.push({
        requestedText: seg.replace(/^[-•*]\s*/, ''),
        productCode: best.product.code,
        quantity: q ? parseQuantity(q[1]) : null,
        unit: best.product.unit,
        note: null,
      });
    } else if (/havlu|nevresim|bornoz|towel/.test(s)) {
      items.push({
        requestedText: seg.replace(/^[-•*]\s*/, ''),
        productCode: null,
        quantity: q ? parseQuantity(q[1]) : null,
        unit: q ? q[2].toLowerCase() : 'adet',
        note: 'Katalogda net eşleşme bulunamadı (ebat/model belirtilmemiş olabilir).',
      });
    }
  }
  // Aynı ürünün (miktarsız) tekrarlarını birleştir
  const merged = [];
  for (const it of items) {
    const dup = it.productCode && merged.find((m) => m.productCode === it.productCode);
    if (dup) {
      if (!dup.quantity && it.quantity) dup.quantity = it.quantity;
    } else merged.push(it);
  }
  return merged;
}

export function analyzeRequestDemo(request, catalog) {
  const body = request.body || '';
  const fullText = `${request.subject || ''}\n${body}`;
  const t = lower(fullText);
  const sender = parseFrom(request.from);

  const signatureName = body.match(/(?:Saygılarımla|Saygılarımızla|İyi çalışmalar|Teşekkürler),?\s*\n\s*([A-ZÇĞİÖŞÜ][\wçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][\wçğıöşü]+)?)/);
  const location = findLocation(fullText, sender.email);

  const incotermMatch = fullText.match(/\b(EXW|FCA|FOB|CFR|CIF|CPT|CIP|DAP|DDP)\b\s*([A-ZÇĞİÖŞÜ][\wçğıöşü]+)?/);
  const incoterm = incotermMatch ? incotermMatch[1].toUpperCase() : null;
  const destination = incotermMatch && incotermMatch[2] ? incotermMatch[2] : null;

  let paymentTerms = null;
  if (/akreditif|\bl\/c\b|letter of credit/.test(t)) paymentTerms = 'Akreditif (L/C)';
  else if (/vesaik mukabili|\bcad\b/.test(t)) paymentTerms = 'Vesaik mukabili (CAD)';
  else {
    const pay = body.match(/%\s?\d+\s*(?:peşin|avans)[^.\n]*/i) || body.match(/(?:peşin|avans)[^.\n]*/i);
    if (pay) paymentTerms = pay[0].replace(/\s*(düşünüyoruz|olabilir|istiyoruz|rica ediyoruz)\s*$/i, '').trim();
  }

  const dateMatch = fullText.match(new RegExp(`(\\d{1,2}\\s+(?:${MONTHS})(?:\\s+\\d{4})?)`, 'i'));
  const deadline = dateMatch ? dateMatch[1] : null;
  const urgency = /acil|bu hafta|en kısa sürede|ivedi|urgent/.test(t) ? 'yüksek' : deadline ? 'normal' : 'düşük';

  const items = findItems(body, catalog);

  const missingInfo = [];
  if (!items.length) missingInfo.push('Talep edilen ürün katalogla eşleştirilemedi.');
  for (const it of items) {
    const p = it.productCode && catalog.products.find((x) => x.code === it.productCode);
    const label = p ? p.name : `"${it.requestedText}"`;
    if (!it.quantity) missingInfo.push(`${label} için miktar belirtilmemiş.`);
    if (!it.productCode) missingInfo.push(`${label} için ürün ebadı/modeli net değil.`);
  }
  if (!incoterm) missingInfo.push('Teslim şekli (Incoterm) belirtilmemiş.');
  if (!paymentTerms) missingInfo.push('Ödeme koşulu belirtilmemiş.');
  if (!deadline && urgency !== 'yüksek') missingInfo.push('İstenen teslim tarihi belirtilmemiş.');

  const salesNotes = [];
  if (/renk/.test(t)) salesNotes.push('Müşteri renk seçeneklerini soruyor — renk kartelası paylaşılmalı.');
  if (/logo|baskı|nakış|private label/.test(t)) salesNotes.push('Müşteri logo/özel baskı soruyor — nakış/baskı fiyatı ayrıca belirtilmeli.');
  if (/numune|sample/.test(t)) salesNotes.push('Müşteri numune talep ediyor.');
  if (/fiyat listesi/.test(t)) salesNotes.push('Müşteri genel fiyat listesi istiyor.');
  if (urgency === 'yüksek') salesNotes.push('Acil talep — aynı gün içinde dönüş yapılması önerilir.');

  const company = findCompany(fullText, sender.email);
  const productNames = items
    .map((it) => {
      const p = it.productCode && catalog.products.find((x) => x.code === it.productCode);
      const name = p ? p.name : it.requestedText;
      return it.quantity ? `${formatNumber(it.quantity)} ${it.unit} ${name}` : name;
    })
    .join(', ');

  return {
    source: 'demo',
    customer: {
      company,
      contactName: sender.name || (signatureName ? signatureName[1] : null),
      email: sender.email,
      country: location.country,
      city: location.city,
    },
    summary:
      `${company || 'Müşteri'}${location.country ? ` (${location.country})` : ''} ` +
      (productNames ? `şu ürünler için teklif istiyor: ${productNames}.` : 'genel bilgi/fiyat talep ediyor.') +
      (incoterm ? ` Teslim şekli: ${incoterm}${destination ? ' ' + destination : ''}.` : ''),
    items,
    incoterm,
    destination,
    paymentTerms,
    deadline,
    urgency,
    missingInfo,
    salesNotes,
  };
}

/** Şablon tabanlı e-posta taslağı (demo modu ve AI hatası durumunda yedek). */
export function draftEmailTemplate({ request, analysis, quote, settings }) {
  const name = analysis.customer?.contactName;
  const greeting = name ? `Sayın ${name},` : 'Sayın Yetkili,';
  const cur = quote.currency;

  const lines = quote.lines
    .map((l, i) =>
      `${i + 1}) ${l.name} (${l.code})\n   ${formatNumber(l.quantity)} ${l.unit} × ${formatMoney(l.unitPrice, cur)} = ${formatMoney(l.total, cur)}`)
    .join('\n');

  const totals = [
    quote.extraDiscountPercent > 0 ? `Ara toplam: ${formatMoney(quote.subtotal, cur)}` : null,
    quote.extraDiscountPercent > 0 ? `Ek indirim (%${quote.extraDiscountPercent}): -${formatMoney(quote.extraDiscountAmount, cur)}` : null,
    `Genel toplam: ${formatMoney(quote.total, cur)}`,
  ].filter(Boolean).join('\n');

  const terms = [
    `• Teslim şekli: ${quote.incoterm}${analysis.destination ? ' ' + analysis.destination : quote.incoterm === 'FOB' ? ' İstanbul' : ''}`,
    `• Ödeme koşulu: ${analysis.paymentTerms || settings.defaultPaymentTerms}`,
    quote.leadTimeDays ? `• Üretim/teslim süresi: sipariş onayından itibaren yaklaşık ${quote.leadTimeDays} gün` : null,
    `• Teklif geçerlilik süresi: ${settings.validityDays} gün`,
  ].filter(Boolean).join('\n');

  const questions = customerQuestions(analysis, quote);
  const topics = askedTopics(`${request.subject || ''} ${request.body || ''}`);

  let body = `${greeting}\n\n`;
  body += `"${request.subject || 'Fiyat talebi'}" konulu talebiniz için teşekkür ederiz. Talebinize ilişkin fiyat teklifimizi aşağıda bilgilerinize sunarız.\n\n`;
  if (quote.lines.length) {
    body += `TEKLİF DETAYI\n${lines}\n\n${totals}\n\n`;
  } else {
    body += `Talebinizi netleştirebilmemiz için aşağıdaki bilgilere ihtiyaç duymaktayız.\n\n`;
  }
  body += `KOŞULLAR\n${terms}\n`;
  if (quote.lines.some((l) => l.quantityAssumed)) {
    body += `\nNot: Miktar belirtilmeyen kalemler minimum sipariş miktarı üzerinden fiyatlandırılmıştır.\n`;
  }
  if (topics.length) {
    body += `\nSorduğunuz ${topics.join(', ')} ile ilgili detayları ayrıca paylaşacağız.\n`;
  }
  if (questions.length) {
    body += `\nTeklifimizi kesinleştirebilmemiz için lütfen şu bilgileri iletir misiniz?\n${questions.map((q) => `- ${q}`).join('\n')}\n`;
  }
  body += `\nHer türlü sorunuz için bizimle iletişime geçebilirsiniz.\n\nSaygılarımızla,\n${settings.contactName}\n${settings.companyName}\n${[settings.email, settings.phone].filter(Boolean).join(' | ')}`;

  const subject = `Fiyat Teklifi – ${analysis.customer?.company || request.subject || 'Talebiniz'} (${quote.incoterm})`;
  return { subject, body, source: 'demo' };
}

function askedTopics(text) {
  const t = lower(text);
  const topics = [];
  if (/renk/.test(t)) topics.push('renk seçenekleri');
  if (/logo|baskı|nakış|private label/.test(t)) topics.push('logo/özel baskı imkânı');
  if (/numune|sample/.test(t)) topics.push('numune talebi');
  return topics;
}

function customerQuestions(analysis, quote) {
  const qs = [];
  for (const line of quote.lines.filter((l) => l.quantityAssumed)) {
    qs.push(`${line.name} için planladığınız sipariş miktarı`);
  }
  for (const it of analysis.items.filter((i) => !i.productCode)) {
    qs.push(`"${it.requestedText}" için istediğiniz ebat/model`);
  }
  if (!analysis.incoterm) qs.push('Tercih ettiğiniz teslim şekli (FOB, CIF vb.) ve varış noktası');
  if (!analysis.paymentTerms) qs.push('Tercih ettiğiniz ödeme koşulu');
  if (!analysis.deadline && analysis.urgency !== 'yüksek') qs.push('Ürünlere ihtiyaç duyduğunuz tarih');
  return qs;
}
