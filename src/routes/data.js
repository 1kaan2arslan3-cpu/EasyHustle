// /api/settings, /api/quotes, /api/email — giriş yapmış kullanıcının verileri.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { EmailSendError } from '../email/service.js';
import { HttpError, validate } from '../http.js';

// ---- Şemalar -------------------------------------------------------------------

const SettingsSchema = z.object({
  companyName: z.string({ error: 'Firma adı zorunludur.' }).trim().min(1, 'Firma adı zorunludur.').max(200),
  contactName: z.string({ error: 'Yetkili / imza zorunludur.' }).trim().min(1, 'Yetkili / imza zorunludur.').max(200),
  email: z.string().trim().max(254).optional().default(''),
  phone: z.string().trim().max(50).optional().default(''),
  validityDays: z.coerce.number().int().min(1, 'Teklif geçerliliği en az 1 gün olmalı.').max(365),
  defaultPaymentTerms: z.string().trim().max(300).optional().default(''),
});

const obj = z.record(z.string(), z.unknown());
const QuoteSchema = z.object({
  request: z.object({ from: z.string().max(500).default(''), subject: z.string().max(500).default(''), body: z.string().max(50000) }),
  analysis: obj,
  quoteInput: obj,
  email: obj.nullable().optional().default(null),
  total: z.number().finite(),
  currency: z.string().min(1).max(10),
});
const ImportSchema = z.object({ quotes: z.array(QuoteSchema.extend({ savedAt: z.string().optional() })).max(50) });
const StatusSchema = z.object({ status: z.enum(['draft', 'sent', 'accepted', 'rejected']) });

const SendSchema = z.object({
  to: z.string({ error: 'Alıcı zorunludur.' }).trim().email('Alıcı için geçerli bir e-posta adresi girin.'),
  subject: z
    .string({ error: 'Konu zorunludur.' })
    .trim()
    .min(1, 'Konu zorunludur.')
    .max(300)
    .refine((s) => !/[\r\n\u0000]/.test(s), 'Konu satır sonu içeremez.'),
  body: z.string({ error: 'İçerik zorunludur.' }).min(1, 'İçerik zorunludur.').max(50000),
  quoteId: z.string().max(100).nullable().optional(),
});

// ---- Dönüştürücüler -------------------------------------------------------------

function settingsOut(row) {
  if (!row) return null;
  return {
    companyName: row.companyName,
    contactName: row.contactName,
    email: row.email || '',
    phone: row.phone || '',
    validityDays: row.validityDays,
    defaultPaymentTerms: row.defaultPaymentTerms || '',
  };
}

/** Arayüzün beklediği teklif biçimi (localStorage kayıtlarıyla aynı alanlar). */
function quoteOut(row) {
  return {
    id: row.id,
    savedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    request: row.request,
    analysis: row.analysis,
    quoteInput: row.quoteInput,
    email: row.email ?? null,
    total: row.total,
    currency: row.currency,
  };
}

function quoteData(q) {
  const customer = q.analysis?.customer && typeof q.analysis.customer === 'object' ? q.analysis.customer : {};
  return {
    customerCompany: typeof customer.company === 'string' ? customer.company : null,
    customerEmail: typeof customer.email === 'string' ? customer.email : null,
    subject: (typeof q.email?.subject === 'string' && q.email.subject) || q.request.subject || null,
    request: q.request,
    analysis: q.analysis,
    quoteInput: q.quoteInput,
    email: q.email ?? undefined,
    total: q.total,
    currency: q.currency,
  };
}

// ---- Router ---------------------------------------------------------------------

/** @param {{ db: import('../db.js').Db }} deps */
export function dataRouter({ db, email, sendLimiter }) {
  const r = Router();
  // Yalnızca bu router'ın yolları için giriş zorunlu (bilinmeyen uçlar 404 alsın, 401 değil)
  r.use(['/settings', '/quotes', '/email'], requireAuth);

  const findQuote = (userId, id) => db.quote.findFirst({ where: { id, userId } });
  const newQuoteId = () => `teklif-${randomUUID()}`;

  // ---- Firma ayarları ----
  r.get('/settings', async (req, res) => {
    res.json({ settings: settingsOut(await db.companySettings.findUnique({ where: { userId: req.user.id } })) });
  });

  r.put('/settings', async (req, res) => {
    const s = validate(SettingsSchema, req.body);
    await db.companySettings.upsert({ where: { userId: req.user.id }, create: { userId: req.user.id, ...s }, update: s });
    res.json({ settings: s });
  });

  // ---- Teklifler ----
  r.get('/quotes', async (req, res) => {
    const rows = await db.quote.findMany({ where: { userId: req.user.id }, orderBy: { updatedAt: 'desc' }, take: 200 });
    res.json({ quotes: rows.map(quoteOut) });
  });

  r.post('/quotes', async (req, res) => {
    const row = await db.quote.create({ data: { id: newQuoteId(), userId: req.user.id, ...quoteData(validate(QuoteSchema, req.body)) } });
    res.status(201).json({ quote: quoteOut(row) });
  });

  r.put('/quotes/:id', async (req, res) => {
    const data = quoteData(validate(QuoteSchema, req.body));
    const { count } = await db.quote.updateMany({ where: { id: req.params.id, userId: req.user.id }, data });
    if (!count) throw new HttpError(404, 'Teklif bulunamadı.');
    res.json({ quote: quoteOut(await findQuote(req.user.id, req.params.id)) });
  });

  r.patch('/quotes/:id/status', async (req, res) => {
    const { status } = validate(StatusSchema, req.body);
    const { count } = await db.quote.updateMany({ where: { id: req.params.id, userId: req.user.id }, data: { status } });
    if (!count) throw new HttpError(404, 'Teklif bulunamadı.');
    res.json({ quote: quoteOut(await findQuote(req.user.id, req.params.id)) });
  });

  r.delete('/quotes/:id', async (req, res) => {
    const { count } = await db.quote.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
    if (!count) throw new HttpError(404, 'Teklif bulunamadı.');
    res.json({ ok: true });
  });

  // Tarayıcıda (localStorage) kayıtlı tekliflerin hesaba aktarılması
  r.post('/quotes/import', async (req, res) => {
    const { quotes } = validate(ImportSchema, req.body);
    const now = new Date();
    await db.$transaction(
      quotes.map((q) => {
        const ts = q.savedAt && !Number.isNaN(Date.parse(q.savedAt)) ? new Date(q.savedAt) : now;
        return db.quote.create({
          data: { id: newQuoteId(), userId: req.user.id, ...quoteData(q), createdAt: ts, updatedAt: ts },
        });
      }),
    );
    res.json({ imported: quotes.length });
  });

  // ---- Teklif e-postasını gönder ----
  r.post('/email/send', sendLimiter, async (req, res) => {
    if (!req.user.emailVerified) {
      throw new HttpError(403, 'E-posta gönderebilmek için önce hesabınızın e-posta adresini doğrulayın.');
    }
    const data = validate(SendSchema, req.body);
    const quote = data.quoteId ? await findQuote(req.user.id, data.quoteId) : null;
    if (data.quoteId && !quote) throw new HttpError(404, 'Teklif bulunamadı.');

    const settings = await db.companySettings.findUnique({ where: { userId: req.user.id }, select: { email: true } });
    const replyTo = settings?.email || req.user.email;
    const log = { userId: req.user.id, quoteId: quote?.id ?? null, toAddress: data.to, subject: data.subject };
    let result;
    try {
      result = await email.sendPlain({ to: data.to, subject: data.subject, text: data.body, replyTo });
    } catch (err) {
      if (!(err instanceof EmailSendError)) throw err;
      await db.emailLog.create({ data: { ...log, delivered: false, error: String(err.message).slice(0, 500) } });
      console.error(`[e-posta] Teklif e-postası gönderilemedi (kullanıcı ${req.user.id}): ${err.message}`);
      throw new HttpError(502, 'E-posta gönderilemedi. Lütfen biraz sonra tekrar deneyin.', 'EMAIL_SEND_FAILED');
    }
    await db.emailLog.create({ data: { ...log, delivered: result.sent, providerMessageId: result.id } });
    if (quote && result.sent) {
      await db.quote.update({ where: { id: quote.id }, data: { status: 'sent' } });
    }
    res.json({ ok: true, delivered: result.sent, sent: result.sent, delivery: result.delivery });
  });

  return r;
}
