import { analyzeRequestDemo, draftEmailTemplate } from './demo-analyzer.js';
import { calculateQuote, createQuoteLines, formatMoney, formatNumber, normalizeIncoterm } from './quote.js';

// ---- Durum -----------------------------------------------------------------

const DEFAULT_SETTINGS = {
  companyName: 'Anadolu Tekstil San. ve Tic. A.Ş.',
  contactName: 'İhracat Satış Ekibi',
  email: 'export@anadolutekstil.example',
  phone: '+90 212 000 00 00',
  validityDays: 30,
  defaultPaymentTerms: '%30 peşin, bakiye yükleme öncesi',
};

const state = {
  mode: 'static', // 'ai' | 'demo' | 'static' (sunucusuz, ör. GitHub Pages)
  model: null,
  catalog: null,
  samples: [],
  activeId: null,
  request: null,
  analysis: null,
  quoteInput: null,
  quote: null,
  email: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* depolama kapalı olabilir */
  }
}
const getSettings = () => ({ ...DEFAULT_SETTINGS, ...storageGet('ita.settings', {}) });
const getSaved = () => storageGet('ita.savedQuotes', []);

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ---- Başlangıç ---------------------------------------------------------------

async function init() {
  const [catalog, samples] = await Promise.all([
    fetch('data/catalog.json').then((r) => r.json()),
    fetch('data/sample-requests.json').then((r) => r.json()),
  ]);
  state.catalog = catalog;
  state.samples = samples;

  try {
    const res = await fetch('api/status');
    if (!res.ok) throw new Error();
    const status = await res.json();
    state.mode = status.mode;
    state.model = status.model;
  } catch {
    state.mode = 'static';
  }
  renderModeBadge();

  $('incotermSelect').innerHTML = Object.entries(catalog.incotermAdjustments)
    .map(([code, pct]) => `<option value="${code}">${code} (${pct > 0 ? '+' : ''}${pct}%)</option>`)
    .join('');
  $('pricingNote').textContent =
    `Liste fiyatları ${catalog.basePriceTerm} ${catalog.basePort} bazındadır. Incoterm farkı yaklaşık navlun/sigorta/masraf payıdır. ` +
    `Kademe indirimleri: ${catalog.quantityDiscounts.map((d) => `${formatNumber(d.minQuantity)}+ → %${d.percent}`).join(', ')}.`;

  renderInbox();
  renderSaved();
  bindEvents();
  if (samples[0]) selectSample(samples[0].id);
}

function renderModeBadge() {
  const b = $('modeBadge');
  b.className = 'badge ' + (state.mode === 'ai' ? 'ai' : 'demo');
  b.textContent =
    state.mode === 'ai' ? `AI aktif · ${state.model}` : state.mode === 'demo' ? 'Demo modu (kural tabanlı)' : 'Statik demo (kural tabanlı)';
  b.title =
    state.mode === 'ai'
      ? 'Analiz ve e-posta taslakları Claude ile üretiliyor.'
      : 'AI anahtarı tanımlı değil; analiz kural tabanlı motorla yapılıyor. Kurulum için README dosyasına bakın.';
}

// ---- Gelen kutusu ----------------------------------------------------------

function renderInbox() {
  $('inboxList').innerHTML = state.samples
    .map(
      (s) => `<li><button class="inbox-item ${s.id === state.activeId ? 'active' : ''}" data-sample="${esc(s.id)}" type="button">
        <span class="from">${esc(s.from.replace(/<.*>/, '').trim() || s.from)}</span>
        <span class="subj">${esc(s.subject)}</span>
        <span class="meta"><span>${esc(formatDate(s.receivedAt))}</span><span>Örnek</span></span>
      </button></li>`,
    )
    .join('');
}

function renderSaved() {
  const saved = getSaved();
  $('savedList').innerHTML = saved.length
    ? saved
        .map(
          (s) => `<li><button class="inbox-item ${s.id === state.activeId ? 'active' : ''}" data-saved="${esc(s.id)}" type="button">
            <span class="from">${esc(s.analysis.customer?.company || s.request.from || 'Müşteri')}</span>
            <span class="subj">${esc(s.email?.subject || s.request.subject)}</span>
            <span class="meta"><span>${esc(formatDate(s.savedAt))}</span><span>${esc(formatMoney(s.total, s.currency))}</span></span>
          </button></li>`,
        )
        .join('')
    : '<li class="empty">Henüz kayıtlı teklif yok.</li>';
}

function resetDownstream() {
  state.analysis = state.quoteInput = state.quote = state.email = null;
  ['analysisCard', 'quoteCard', 'emailCard'].forEach((id) => $(id).classList.add('hidden'));
  $('analyzeStatus').textContent = '';
}

function selectSample(id) {
  const s = state.samples.find((x) => x.id === id);
  if (!s) return;
  state.activeId = id;
  $('reqFrom').value = s.from;
  $('reqSubject').value = s.subject;
  $('reqBody').value = s.body;
  resetDownstream();
  renderInbox();
  renderSaved();
}

function loadSaved(id) {
  const s = getSaved().find((x) => x.id === id);
  if (!s) return;
  state.activeId = id;
  state.request = s.request;
  state.analysis = s.analysis;
  state.quoteInput = s.quoteInput;
  state.email = s.email;
  $('reqFrom').value = s.request.from;
  $('reqSubject').value = s.request.subject;
  $('reqBody').value = s.request.body;
  renderAnalysis();
  renderQuote();
  renderEmail();
  renderInbox();
  renderSaved();
}

function newRequest() {
  state.activeId = null;
  $('reqFrom').value = '';
  $('reqSubject').value = '';
  $('reqBody').value = '';
  resetDownstream();
  renderInbox();
  renderSaved();
  $('reqBody').focus();
}

// ---- Adım 2: analiz ---------------------------------------------------------

async function analyze() {
  const request = { from: $('reqFrom').value.trim(), subject: $('reqSubject').value.trim(), body: $('reqBody').value.trim() };
  if (!request.body) {
    $('analyzeStatus').textContent = 'Lütfen e-posta içeriğini girin.';
    return;
  }
  const btn = $('analyzeBtn');
  btn.disabled = true;
  $('analyzeStatus').textContent = state.mode === 'ai' ? 'Claude talebi analiz ediyor…' : 'Analiz ediliyor…';
  try {
    let analysis;
    if (state.mode === 'static') {
      analysis = analyzeRequestDemo(request, state.catalog);
    } else {
      const res = await fetch('api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      analysis = await res.json();
      if (!res.ok) throw new Error(analysis.error || 'Analiz başarısız.');
    }
    state.request = request;
    state.analysis = analysis;
    state.email = null;
    state.quoteInput = {
      lines: createQuoteLines(analysis, state.catalog),
      incoterm: normalizeIncoterm(state.catalog, analysis.incoterm),
      extraDiscountPercent: 0,
    };
    $('analyzeStatus').textContent = '';
    renderAnalysis();
    renderQuote();
    $('emailCard').classList.add('hidden');
    $('analysisCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('analyzeStatus').textContent = `Hata: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderAnalysis() {
  const a = state.analysis;
  const c = a.customer || {};
  $('analysisCard').classList.remove('hidden');
  $('analysisSource').textContent = a.source === 'ai' ? 'AI analizi' : 'Kural tabanlı analiz';
  $('analysisSummary').textContent = a.summary;
  $('analysisWarning').classList.toggle('hidden', !a.warning);
  $('analysisWarning').textContent = a.warning || '';

  const fact = (label, value, cls = '') =>
    `<div><dt>${label}</dt><dd class="${value ? cls : 'missing'}">${value ? esc(value) : 'Belirtilmemiş'}</dd></div>`;
  $('analysisFacts').innerHTML = [
    fact('Firma', c.company),
    fact('Yetkili', c.contactName),
    fact('E-posta', c.email),
    fact('Ülke / şehir', [c.country, c.city].filter(Boolean).join(' / ')),
    fact('Teslim şekli', a.incoterm ? `${a.incoterm}${a.destination ? ' ' + a.destination : ''}` : null),
    fact('Ödeme', a.paymentTerms),
    fact('İstenen termin', a.deadline),
    fact('Aciliyet', a.urgency, `urgency-${a.urgency}`),
  ].join('');

  $('itemsBody').innerHTML = a.items.length
    ? a.items
        .map((it) => {
          const p = it.productCode && state.catalog.products.find((x) => x.code === it.productCode);
          return `<tr>
            <td>${esc(it.requestedText)}</td>
            <td>${p ? `${esc(p.name)} <span class="code">${esc(p.code)}</span>` : '<span class="unmatched">Eşleşme yok</span>'}</td>
            <td class="num">${it.quantity ? `${formatNumber(it.quantity)} ${esc(it.unit)}` : '<span class="unmatched">—</span>'}</td>
            <td>${esc(it.note || '')}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="muted">Ürün kalemi tespit edilemedi.</td></tr>';

  const li = (arr, empty) => (arr.length ? arr.map((x) => `<li>${esc(x)}</li>`).join('') : `<li class="none">${empty}</li>`);
  $('missingList').innerHTML = li(a.missingInfo, 'Eksik bilgi yok 👍');
  $('notesList').innerHTML = li(a.salesNotes, 'Not yok.');
}

// ---- Adım 3: teklif -----------------------------------------------------------

function renderQuote() {
  const input = state.quoteInput;
  state.quote = calculateQuote(input, state.catalog);
  const q = state.quote;
  $('quoteCard').classList.remove('hidden');
  $('incotermSelect').value = q.incoterm;
  $('extraDiscount').value = input.extraDiscountPercent;

  const productOptions = (selected) =>
    state.catalog.products
      .map((p) => `<option value="${p.code}" ${p.code === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
      .join('');

  $('quoteBody').innerHTML = q.lines.length
    ? q.lines
        .map(
          (l, i) => `<tr>
          <td><select data-line="${i}" data-field="code" aria-label="Ürün">${productOptions(l.code)}</select>
            <div class="code">${esc(l.code)} · MOQ ${formatNumber(l.moq)} · ${l.leadTimeDays} gün${l.quantityAssumed ? ' · miktar varsayıldı (MOQ)' : ''}</div></td>
          <td class="num"><input type="number" min="0" step="1" value="${l.quantity}" data-line="${i}" data-field="quantity" aria-label="Miktar"> <span class="code">${esc(l.unit)}</span></td>
          <td class="num">${formatMoney(l.listPrice, q.currency)}</td>
          <td class="num">${l.discountPct ? '%' + l.discountPct : '—'}</td>
          <td class="num"><input type="number" min="0" step="0.01" value="${l.unitPrice.toFixed(2)}" data-line="${i}" data-field="price"
              class="${l.priceOverridden ? 'override' : ''}" title="${l.priceOverridden ? 'Elle girildi. Hesaplanan: ' + l.computedUnitPrice.toFixed(2) : 'Hesaplanan fiyat — değiştirebilirsiniz'}" aria-label="Birim fiyat"></td>
          <td class="num">${formatMoney(l.total, q.currency)}</td>
          <td><button class="icon-btn" data-remove="${i}" type="button" title="Kalemi sil" aria-label="Kalemi sil">×</button></td>
        </tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="muted">Katalogla eşleşen kalem yok. "+ Kalem ekle" ile ekleyebilirsiniz.</td></tr>';

  $('quoteFoot').innerHTML = `
    ${q.extraDiscountPercent ? `<tr><td colspan="5" class="num">Ara toplam</td><td class="num">${formatMoney(q.subtotal, q.currency)}</td><td></td></tr>
    <tr><td colspan="5" class="num">Ek indirim (%${q.extraDiscountPercent})</td><td class="num">-${formatMoney(q.extraDiscountAmount, q.currency)}</td><td></td></tr>` : ''}
    <tr class="grand"><td colspan="5" class="num">Genel toplam (${q.incoterm})</td><td class="num">${formatMoney(q.total, q.currency)}</td><td></td></tr>`;

  $('quoteWarnings').innerHTML = q.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
}

function onQuoteChange(e) {
  const t = e.target;
  if (t.id === 'incotermSelect') state.quoteInput.incoterm = t.value;
  else if (t.id === 'extraDiscount') state.quoteInput.extraDiscountPercent = Number(t.value) || 0;
  else if (t.dataset.line !== undefined) {
    const line = state.quoteInput.lines[Number(t.dataset.line)];
    if (t.dataset.field === 'code') {
      line.code = t.value;
      line.priceOverride = null;
    } else if (t.dataset.field === 'quantity') {
      line.quantity = Number(t.value) || 0;
      line.quantityAssumed = false;
    } else if (t.dataset.field === 'price') {
      const computed = state.quote.lines[Number(t.dataset.line)].computedUnitPrice;
      line.priceOverride = t.value === '' || Number(t.value) === computed ? null : Number(t.value);
    }
  } else return;
  renderQuote();
}

// ---- Adım 4: e-posta ---------------------------------------------------------

async function draftEmail() {
  if (!state.quote.lines.length && !state.analysis.missingInfo.length) {
    $('draftStatus').textContent = 'Önce teklif kalemi ekleyin.';
    return;
  }
  const payload = { request: state.request, analysis: state.analysis, quote: state.quote, settings: getSettings() };
  const btn = $('draftBtn');
  btn.disabled = true;
  $('draftStatus').textContent = state.mode === 'ai' ? 'Claude e-posta taslağını yazıyor…' : 'Taslak hazırlanıyor…';
  try {
    if (state.mode === 'static') {
      state.email = draftEmailTemplate(payload);
    } else {
      const res = await fetch('api/draft-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.email = await res.json();
      if (!res.ok) throw new Error(state.email.error || 'Taslak oluşturulamadı.');
    }
    state.email.to = state.analysis.customer?.email || '';
    $('draftStatus').textContent = '';
    renderEmail();
    $('emailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('draftStatus').textContent = `Hata: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderEmail() {
  const e = state.email;
  if (!e) {
    $('emailCard').classList.add('hidden');
    return;
  }
  $('emailCard').classList.remove('hidden');
  $('emailSource').textContent = e.source === 'ai' ? 'AI taslağı' : 'Şablon taslağı';
  $('emailWarning').classList.toggle('hidden', !e.warning);
  $('emailWarning').textContent = e.warning || '';
  $('emailTo').value = e.to || '';
  $('emailSubject').value = e.subject;
  $('emailBody').value = e.body;
  updateMailto();
}

function syncEmailFromForm() {
  if (!state.email) return;
  state.email.to = $('emailTo').value;
  state.email.subject = $('emailSubject').value;
  state.email.body = $('emailBody').value;
  updateMailto();
}

function updateMailto() {
  const e = state.email;
  $('mailtoBtn').href = `mailto:${encodeURIComponent(e.to || '')}?subject=${encodeURIComponent(e.subject)}&body=${encodeURIComponent(e.body)}`;
}

async function copyEmail() {
  syncEmailFromForm();
  const text = `Konu: ${state.email.subject}\n\n${state.email.body}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('E-posta panoya kopyalandı');
  } catch {
    $('emailBody').select();
    toast('Kopyalamak için Ctrl+C kullanın');
  }
}

function saveQuote() {
  syncEmailFromForm();
  const saved = getSaved();
  const existing = saved.find((s) => s.id === state.activeId && s.id.startsWith('teklif-'));
  const id = existing ? existing.id : `teklif-${Date.now()}`;
  const record = {
    id,
    savedAt: new Date().toISOString(),
    request: state.request,
    analysis: state.analysis,
    quoteInput: state.quoteInput,
    email: state.email,
    total: state.quote.total,
    currency: state.quote.currency,
  };
  const next = [record, ...saved.filter((s) => s.id !== id)].slice(0, 50);
  storageSet('ita.savedQuotes', next);
  state.activeId = id;
  renderSaved();
  renderInbox();
  toast('Teklif kaydedildi');
}

// ---- Ayarlar -----------------------------------------------------------------

function openSettings() {
  const form = $('settingsForm');
  const s = getSettings();
  for (const [k, v] of Object.entries(s)) if (form.elements[k]) form.elements[k].value = v;
  $('settingsDialog').showModal();
}

function onSettingsClose() {
  if ($('settingsDialog').returnValue !== 'save') return;
  const form = $('settingsForm');
  const data = Object.fromEntries(new FormData(form).entries());
  data.validityDays = Number(data.validityDays) || DEFAULT_SETTINGS.validityDays;
  storageSet('ita.settings', data);
  toast('Ayarlar kaydedildi');
}

// ---- Olaylar -----------------------------------------------------------------

function bindEvents() {
  $('inboxList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sample]');
    if (b) selectSample(b.dataset.sample);
  });
  $('savedList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-saved]');
    if (b) loadSaved(b.dataset.saved);
  });
  $('newRequestBtn').addEventListener('click', newRequest);
  $('analyzeBtn').addEventListener('click', analyze);
  $('reqBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) analyze();
  });

  $('quoteCard').addEventListener('change', onQuoteChange);
  $('quoteBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    state.quoteInput.lines.splice(Number(b.dataset.remove), 1);
    renderQuote();
  });
  $('addLineBtn').addEventListener('click', () => {
    const p = state.catalog.products[0];
    state.quoteInput.lines.push({ code: p.code, quantity: p.moq, quantityAssumed: false, priceOverride: null });
    renderQuote();
  });
  $('draftBtn').addEventListener('click', draftEmail);

  ['emailTo', 'emailSubject', 'emailBody'].forEach((id) => $(id).addEventListener('input', syncEmailFromForm));
  $('copyBtn').addEventListener('click', copyEmail);
  $('saveBtn').addEventListener('click', saveQuote);

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsDialog').addEventListener('close', onSettingsClose);
}

init().catch((err) => {
  console.error(err);
  document.querySelector('.workspace').insertAdjacentHTML('afterbegin', `<div class="alert warn">Uygulama yüklenemedi: ${esc(err.message)}</div>`);
});
