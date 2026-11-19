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
  // Hesap (yalnızca sunucu modunda; statik demoda auth = false ve veriler localStorage'da kalır)
  auth: false,
  mailDelivery: false,
  user: null,
  saved: [],
  serverSettings: null,
  resetToken: null,
  verifyNotice: null, // doğrulama uyarısında gösterilecek özel mesaj (ör. geçersiz bağlantı)
  verificationTtlHours: null,
  resendCooldownSeconds: 0,
  resendReadyAt: 0,
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
function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* depolama kapalı olabilir */
  }
}
const getSettings = () => ({ ...DEFAULT_SETTINGS, ...(state.auth ? state.serverSettings || {} : storageGet('ita.settings', {})) });
const getSaved = () => (state.auth ? state.saved : storageGet('ita.savedQuotes', []));

/** API hatası: sunucunun standart gövdesi { error, code, fields } + HTTP durumu ve Retry-After. */
class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', fields = null, retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

/**
 * Sunucu API çağrısı. Oturum çerezi (HttpOnly) her istekte gönderilir: credentials 'include'
 * (aynı adreste 'same-origin' ile aynıdır; frontend ayrı bir adresten sunulursa da çalışır — sunucuda CORS_ORIGINS gerekir).
 * Hata durumunda ApiError fırlatır; oturum düşmüşse (401) giriş penceresini açar.
 */
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
  } catch {
    throw new ApiError('Sunucuya ulaşılamıyor. İnternet bağlantınızı kontrol edip tekrar deneyin.');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* boş yanıt */
  }
  if (res.status === 401 && state.user && !path.startsWith('auth/')) {
    onSignedOut({ message: 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.' });
  }
  if (!res.ok) {
    throw new ApiError(data.error || `İstek başarısız (${res.status}).`, {
      status: res.status,
      code: data.code || 'ERROR',
      fields: data.fields || null,
      retryAfter: Number(res.headers.get('Retry-After')) || 0,
    });
  }
  return data;
}

function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Butonu yükleniyor durumuna alır; geri döndürmek için dönen fonksiyonu çağırın. */
function setBusy(btn, busy, label) {
  if (busy) {
    btn.dataset.idleLabel ??= btn.textContent;
    btn.disabled = true;
    btn.textContent = label || btn.dataset.loading || btn.textContent;
  } else {
    btn.disabled = false;
    if (btn.dataset.idleLabel) btn.textContent = btn.dataset.idleLabel;
  }
}

const waitText = (s) => (s >= 90 ? `${Math.ceil(s / 60)} dakika` : `${s} saniye`);

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
    state.auth = Boolean(status.auth);
    state.mailDelivery = Boolean(status.mailDelivery);
    state.verificationTtlHours = status.verificationTtlHours || null;
    state.resendCooldownSeconds = status.resendCooldownSeconds || 0;
  } catch {
    state.mode = 'static';
  }
  renderModeBadge();
  if (state.auth) {
    try {
      state.user = (await api('auth/me')).user;
    } catch {
      state.user = null;
    }
  }

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

  if (state.auth) {
    renderUser();
    if (state.user) await loadUserData();
    await handleAuthLink();
    if (!state.user && !$('authDialog').open) openAuth('login');
  }
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
      analysis = await api('analyze', { method: 'POST', body: request });
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
    `<div><dt>${label}</dt><dd class="${value ? esc(cls) : 'missing'}">${value ? esc(value) : 'Belirtilmemiş'}</dd></div>`;
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
      state.email = await api('draft-email', { method: 'POST', body: payload });
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

async function sendEmail() {
  syncEmailFromForm();
  const btn = $('sendBtn');
  btn.disabled = true;
  $('emailStatus').textContent = 'Gönderiliyor…';
  try {
    const quoteId = state.saved.some((s) => s.id === state.activeId) ? state.activeId : null;
    const r = await api('email/send', {
      method: 'POST',
      body: { to: state.email.to, subject: state.email.subject, body: state.email.body, quoteId },
    });
    $('emailStatus').textContent = '';
    if (r.delivered) {
      toast('E-posta gönderildi');
      if (quoteId) await refreshSaved();
    } else {
      toast('Geliştirme modu: e-posta gönderilmedi, sunucu konsoluna yazıldı');
    }
  } catch (err) {
    $('emailStatus').textContent = `Hata: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function saveQuote() {
  syncEmailFromForm();
  if (state.auth) return saveQuoteToServer();
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

async function saveQuoteToServer() {
  const payload = {
    request: state.request,
    analysis: state.analysis,
    quoteInput: state.quoteInput,
    email: state.email,
    total: state.quote.total,
    currency: state.quote.currency,
  };
  const exists = state.saved.some((s) => s.id === state.activeId);
  const btn = $('saveBtn');
  btn.disabled = true;
  try {
    const { quote } = exists
      ? await api(`quotes/${encodeURIComponent(state.activeId)}`, { method: 'PUT', body: payload })
      : await api('quotes', { method: 'POST', body: payload });
    state.activeId = quote.id;
    state.saved = [quote, ...state.saved.filter((s) => s.id !== quote.id)];
    renderSaved();
    renderInbox();
    toast('Teklif kaydedildi');
  } catch (err) {
    $('emailStatus').textContent = `Hata: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- Ayarlar -----------------------------------------------------------------

function openSettings() {
  const form = $('settingsForm');
  const s = getSettings();
  for (const [k, v] of Object.entries(s)) if (form.elements[k]) form.elements[k].value = v;
  $('settingsHint').textContent = state.auth
    ? 'Bu bilgiler e-posta imzasında ve teklif koşullarında kullanılır. Hesabınızda saklanır.'
    : 'Bu bilgiler e-posta imzasında ve teklif koşullarında kullanılır. Tarayıcınızda saklanır.';
  $('settingsDialog').showModal();
}

async function onSettingsClose() {
  if ($('settingsDialog').returnValue !== 'save') return;
  const form = $('settingsForm');
  const data = Object.fromEntries(new FormData(form).entries());
  data.validityDays = Number(data.validityDays) || DEFAULT_SETTINGS.validityDays;
  if (!state.auth) {
    storageSet('ita.settings', data);
    toast('Ayarlar kaydedildi');
    return;
  }
  try {
    state.serverSettings = (await api('settings', { method: 'PUT', body: data })).settings;
    toast('Ayarlar kaydedildi');
  } catch (err) {
    toast(`Ayarlar kaydedilemedi: ${err.message}`);
  }
}

// ---- Hesap ---------------------------------------------------------------------

function renderUser() {
  const u = state.user;
  $('userChip').classList.toggle('hidden', !u);
  $('userChip').textContent = u ? u.name : '';
  $('userChip').title = u ? `${u.email}${u.emailVerified ? '' : ' (doğrulanmadı)'}` : '';
  $('logoutBtn').classList.toggle('hidden', !u);

  // Doğrulanmamış hesap: kalıcı ve net uyarı
  const unverified = Boolean(u && !u.emailVerified);
  $('verifyBanner').classList.toggle('hidden', !unverified);
  if (unverified) {
    $('verifyBannerText').textContent =
      state.verifyNotice ||
      `E-posta adresiniz (${u.email}) henüz doğrulanmadı. Teklif e-postası gönderebilmek için gelen kutunuzdaki doğrulama bağlantısını açın.`;
  }
  $('sendBtn').classList.toggle('hidden', !u);
  $('sendBtn').title = state.mailDelivery
    ? 'E-postayı sunucu üzerinden gönder'
    : 'Geliştirme modu: e-posta servisi tanımlı değil, e-posta sunucu konsoluna yazılır';
}

async function refreshSaved() {
  state.saved = (await api('quotes')).quotes;
  renderSaved();
}

/** Girişten sonra: ayarları ve teklifleri yükle, tarayıcıda kalmış eski verileri hesaba aktar. */
async function loadUserData() {
  try {
    state.serverSettings = (await api('settings')).settings;

    const localSettings = storageGet('ita.settings', null);
    if (localSettings && !state.serverSettings) {
      try {
        state.serverSettings = (await api('settings', { method: 'PUT', body: { ...DEFAULT_SETTINGS, ...localSettings } })).settings;
      } catch {
        /* geçersiz eski ayarlar — varsayılanlarla devam */
      }
    }
    storageRemove('ita.settings');

    const localQuotes = storageGet('ita.savedQuotes', []);
    if (Array.isArray(localQuotes) && localQuotes.length) {
      const { imported } = await api('quotes/import', { method: 'POST', body: { quotes: localQuotes.slice(0, 50) } });
      storageRemove('ita.savedQuotes');
      toast(`Tarayıcıdaki ${imported} teklif hesabınıza aktarıldı`);
    }
    await refreshSaved();
  } catch (err) {
    toast(`Veriler yüklenemedi: ${err.message}`);
  }
}

/** Oturum açıldı (giriş, kayıt veya şifre sıfırlama sonrası). Pencereyi çağıran taraf kapatır. */
function onSignedIn(user) {
  state.user = user;
  state.verifyNotice = null;
  renderUser();
  return loadUserData();
}

/** Oturum kapandı (çıkış veya süresi dolmuş oturum): verileri temizle, giriş penceresini mesajla aç. */
function onSignedOut({ message, success } = {}) {
  state.user = null;
  state.saved = [];
  state.serverSettings = null;
  state.verifyNotice = null;
  if (String(state.activeId).startsWith('teklif-')) state.activeId = null;
  renderUser();
  renderSaved();
  renderInbox();
  openAuth('login', { error: message, success });
}

async function logout() {
  const btn = $('logoutBtn');
  setBusy(btn, true, 'Çıkış yapılıyor…');
  try {
    await api('auth/logout', { method: 'POST' });
  } catch {
    /* sunucuya ulaşılamasa da yerelde çıkış yap */
  } finally {
    setBusy(btn, false);
  }
  if (state.samples[0]) selectSample(state.samples[0].id);
  onSignedOut({ success: 'Çıkış yaptınız.' });
}

// ---- Hesap penceresi: görünümler, alan hataları, mesajlar ----

const FIELD_INPUT = { username: 'name' }; // API alan adı → formdaki input adı

function clearFieldErrors(form) {
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid]').forEach((el) => {
    el.removeAttribute('aria-invalid');
    el.removeAttribute('aria-describedby');
  });
}

/** Sunucunun alan bazlı hatalarını ilgili inputların altında gösterir; gösterilen hata sayısını döner. */
function showFieldErrors(form, fields) {
  let shown = 0;
  for (const [key, message] of Object.entries(fields || {})) {
    const input = form.elements[FIELD_INPUT[key] || key];
    if (!input || input.getAttribute('aria-invalid') === 'true') continue;
    const note = document.createElement('small');
    note.className = 'field-error';
    note.id = `${form.dataset.view}-${input.name}-error`;
    // Arayüzde alanın adı "Ad soyad"; API mesajındaki "Kullanıcı adı" ifadesini etiketle eşleştir
    note.textContent = key === 'username' ? message.replace('Kullanıcı adı', 'Ad soyad') : message;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', note.id);
    input.closest('label').appendChild(note);
    if (!shown) input.focus();
    shown++;
  }
  return shown;
}

function setAlert(el, html) {
  if (!el) return;
  el.innerHTML = html || '';
  el.classList.toggle('hidden', !html);
}

function showFormError(form, err) {
  const errorEl = form.querySelector('[data-error]');
  const fieldCount = showFieldErrors(form, err.fields);

  if (err.code === 'EMAIL_TAKEN') {
    const email = form.elements.email?.value || '';
    setAlert(
      errorEl,
      `${esc(err.message)} <button class="link-btn" type="button" data-goto="login" data-prefill="${esc(email)}">Bu e-postayla giriş yapın</button>`,
    );
    return;
  }
  if (err.code === 'INVALID_CREDENTIALS' && form.elements.password) {
    form.elements.password.value = '';
    form.elements.password.focus();
  }
  if (err.code === 'VALIDATION_ERROR' && fieldCount > 0) return; // mesajlar alanların altında
  const message = err.code === 'RATE_LIMITED' && err.retryAfter ? `Çok fazla deneme yapıldı. Yaklaşık ${waitText(err.retryAfter)} sonra tekrar deneyin.` : err.message;
  setAlert(errorEl, esc(message));
}

/**
 * Hesap penceresini bir görünümle açar.
 * @param {'login'|'register'|'forgot'|'reset'|'verify-notice'} view
 * @param {{ error?: string, success?: string, prefill?: string }} [opts]
 */
function openAuth(view, { error, success, prefill } = {}) {
  const dlg = $('authDialog');
  let target;
  dlg.querySelectorAll('.auth-view').forEach((f) => {
    const active = f.dataset.view === view;
    f.classList.toggle('hidden', !active);
    clearFieldErrors(f);
    setAlert(f.querySelector('[data-error]'), '');
    setAlert(f.querySelector('[data-success]'), '');
    if (active) target = f;
  });
  setAlert(target.querySelector('[data-error]'), error ? esc(error) : '');
  setAlert(target.querySelector('[data-success]'), success ? esc(success) : '');
  if (prefill && target.elements.email) target.elements.email.value = prefill;
  if (!dlg.open) dlg.showModal();
  const firstEmpty = [...target.querySelectorAll('input')].find((i) => !i.value);
  (firstEmpty || target.querySelector('input') || target.querySelector('[type="submit"]'))?.focus();
}

/** Kayıttan hemen sonra: doğrulama e-postasının gerçek durumunu anlatan görünüm. */
function showVerifyNotice(user, ve) {
  openAuth('verify-notice');
  const email = `<strong>${esc(user.email)}</strong>`;
  const ttl = state.verificationTtlHours ? ` Bağlantı ${state.verificationTtlHours} saat geçerlidir.` : '';
  let html;
  if (ve?.sent) {
    html = `Hesabınız oluşturuldu. ${email} adresine bir doğrulama bağlantısı gönderdik; hesabınızı etkinleştirmek için e-postadaki butona tıklayın.${ttl}`;
  } else if (ve?.delivery === 'console') {
    html = `Hesabınız oluşturuldu. <strong>Geliştirme modu:</strong> e-posta servisi tanımlı olmadığı için e-posta gönderilmedi; ${email} için doğrulama bağlantısı sunucu konsoluna yazıldı.`;
  } else {
    html = `Hesabınız oluşturuldu, ancak doğrulama e-postası şu anda <strong>gönderilemedi</strong>. Birazdan aşağıdaki bağlantıyla yeniden deneyin.`;
  }
  $('verifyNoticeText').innerHTML = html;
  $('verifyNoticeHint').textContent =
    (ve?.sent ? 'E-posta birkaç dakika içinde gelmezse spam / gereksiz klasörünü kontrol edin. ' : '') +
    'Doğrulamadan da uygulamayı kullanabilirsiniz; yalnızca teklif e-postası gönderme doğrulama gerektirir.';
  startResendCooldown(state.resendCooldownSeconds); // sunucu da kayıttan sonra aynı süreyi bekletir
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const view = form.dataset.view;
  if (view === 'verify-notice') {
    $('authDialog').close();
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  clearFieldErrors(form);
  setAlert(form.querySelector('[data-error]'), '');
  setAlert(form.querySelector('[data-success]'), '');
  const data = Object.fromEntries(new FormData(form).entries());
  setBusy(submit, true);
  form.setAttribute('aria-busy', 'true');
  try {
    if (view === 'login') {
      const { user } = await api('auth/login', { method: 'POST', body: data });
      form.reset();
      await onSignedIn(user);
      $('authDialog').close();
      toast(`Hoş geldiniz, ${user.name}`);
    } else if (view === 'register') {
      const { user, verificationEmail } = await api('auth/register', { method: 'POST', body: data });
      form.reset();
      await onSignedIn(user);
      showVerifyNotice(user, verificationEmail);
    } else if (view === 'forgot') {
      await api('auth/forgot-password', { method: 'POST', body: data });
      // Güvenlik gereği hesabın var olup olmadığı söylenmez
      setAlert(
        form.querySelector('[data-success]'),
        state.mailDelivery
          ? 'Bu adresle kayıtlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi. Gelen kutunuzu (ve spam klasörünü) kontrol edin.'
          : 'Geliştirme modu: e-posta gönderilmez. Bu adresle kayıtlı bir hesap varsa sıfırlama bağlantısı sunucu konsoluna yazıldı.',
      );
    } else if (view === 'reset') {
      const { user } = await api('auth/reset-password', { method: 'POST', body: { token: state.resetToken, password: data.password } });
      state.resetToken = null;
      form.reset();
      await onSignedIn(user);
      $('authDialog').close();
      toast('Şifreniz güncellendi, giriş yapıldı');
    }
  } catch (err) {
    showFormError(form, err);
  } finally {
    setBusy(submit, false);
    form.removeAttribute('aria-busy');
  }
}

/** E-postadaki bağlantılar: #verify=TOKEN ve #reset=TOKEN */
async function handleAuthLink() {
  const m = location.hash.match(/^#(verify|reset)=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!state.auth) return; // statik demo: sunucu yok
  const [, kind, token] = m;
  if (kind === 'reset') {
    state.resetToken = token;
    openAuth('reset');
    return;
  }
  try {
    const { user } = await api('auth/verify-email', { method: 'POST', body: { token } });
    if (state.user && state.user.id === user.id) {
      state.user = user;
      state.verifyNotice = null;
      renderUser();
      if ($('authDialog').open) $('authDialog').close();
    }
    if (state.user) toast('E-posta adresiniz doğrulandı. Teşekkürler!', 4000);
    else openAuth('login', { success: 'E-posta adresiniz doğrulandı. Şimdi giriş yapabilirsiniz.', prefill: user.email });
  } catch (err) {
    const message = err.code === 'INVALID_TOKEN' ? 'Bu doğrulama bağlantısı geçersiz, süresi dolmuş veya daha önce kullanılmış.' : err.message;
    if (state.user && !state.user.emailVerified) {
      state.verifyNotice = `${message} Yeni bir bağlantı isteyin:`;
      renderUser();
    } else if (state.user) {
      toast(message, 4000);
    } else {
      openAuth('login', { error: `${message} Giriş yaptıktan sonra yeni bir bağlantı isteyebilirsiniz.` });
    }
  }
}

// ---- Doğrulama e-postasını tekrar gönder (uyarı satırı ve kayıt sonrası görünüm) ----

const RESEND_LABEL = 'Doğrulama e-postasını tekrar gönder';
let cooldownTimer = null;

/** İki "tekrar gönder" butonunu da geri sayımla devre dışı bırakır (sunucudaki bekleme süresiyle aynı). */
function startResendCooldown(seconds) {
  if (!seconds) return;
  state.resendReadyAt = Date.now() + seconds * 1000;
  clearInterval(cooldownTimer);
  const tick = () => {
    const left = Math.ceil((state.resendReadyAt - Date.now()) / 1000);
    for (const btn of [$('resendVerifyBtn'), $('verifyNoticeResend')]) {
      delete btn.dataset.idleLabel;
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `Tekrar gönder (${left} sn)` : RESEND_LABEL;
    }
    if (left <= 0) clearInterval(cooldownTimer);
  };
  tick();
  cooldownTimer = setInterval(tick, 1000);
}

async function resendVerification(e) {
  const btn = e.currentTarget;
  const noticeForm = btn.closest('.auth-view');
  // Sonuç: kayıt sonrası görünümdeyse pencerede, değilse bildirim olarak
  const feedback = (message, ok) => {
    if (noticeForm) {
      setAlert(noticeForm.querySelector('[data-success]'), ok ? esc(message) : '');
      setAlert(noticeForm.querySelector('[data-error]'), ok ? '' : esc(message));
    } else {
      toast(message, 4000);
    }
  };
  setBusy(btn, true, 'Gönderiliyor…');
  try {
    const r = await api('auth/resend-verification', { method: 'POST' });
    if (r.alreadyVerified) {
      state.user = { ...state.user, emailVerified: true };
      renderUser();
      feedback('E-posta adresiniz zaten doğrulanmış.', true);
      return;
    }
    state.verifyNotice = null;
    renderUser();
    feedback(
      r.sent
        ? `Yeni doğrulama bağlantısı ${state.user.email} adresine gönderildi. Önceki bağlantı artık geçersiz.`
        : 'Geliştirme modu: e-posta gönderilmedi; yeni doğrulama bağlantısı sunucu konsoluna yazıldı.',
      true,
    );
    startResendCooldown(state.resendCooldownSeconds);
  } catch (err) {
    if (err.code === 'RATE_LIMITED' && err.retryAfter) {
      startResendCooldown(Math.min(err.retryAfter, 3600));
      feedback(`Yeni doğrulama e-postası için ${waitText(err.retryAfter)} bekleyin.`, false);
    } else {
      feedback(err.message, false);
    }
  } finally {
    if (!(state.resendReadyAt > Date.now())) setBusy(btn, false);
  }
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
  $('sendBtn').addEventListener('click', sendEmail);

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsDialog').addEventListener('close', onSettingsClose);

  // Hesap
  const authDlg = $('authDialog');
  authDlg.querySelectorAll('form').forEach((f) => f.addEventListener('submit', onAuthSubmit));
  authDlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (!b) return;
    // Formdaki e-postayı diğer görünüme taşı (ör. "Bu e-postayla giriş yapın", "Şifremi unuttum")
    const currentEmail = b.closest('.auth-view')?.elements?.email?.value;
    openAuth(b.dataset.goto, { prefill: b.dataset.prefill || currentEmail || undefined });
  });
  // Kullanıcı alanı düzeltmeye başlayınca o alanın hatasını kaldır
  authDlg.addEventListener('input', (e) => {
    const input = e.target;
    if (input.getAttribute?.('aria-invalid') !== 'true') return;
    input.removeAttribute('aria-invalid');
    document.getElementById(input.getAttribute('aria-describedby'))?.remove();
    input.removeAttribute('aria-describedby');
  });
  $('verifyNoticeResend').addEventListener('click', resendVerification);
  // Giriş yapılmadan pencere Esc ile kapatılamasın (sunucu modunda uygulama giriş gerektirir)
  authDlg.addEventListener('cancel', (e) => {
    if (!state.user) e.preventDefault();
  });
  $('logoutBtn').addEventListener('click', logout);
  $('resendVerifyBtn').addEventListener('click', resendVerification);
  // Uygulama açıkken aynı sekmede doğrulama / sıfırlama bağlantısı açılırsa
  if (state.auth) window.addEventListener('hashchange', handleAuthLink);
}

init().catch((err) => {
  console.error(err);
  document.querySelector('.workspace').insertAdjacentHTML('afterbegin', `<div class="alert warn">Uygulama yüklenemedi: ${esc(err.message)}</div>`);
});
