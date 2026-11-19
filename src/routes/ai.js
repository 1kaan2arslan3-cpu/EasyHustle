// /api/status, /api/analyze, /api/draft-email — talep analizi ve e-posta taslağı.
import { Router } from 'express';
import { z } from 'zod';
import { analyzeWithAI, draftEmailWithAI, isAiConfigured, MODEL } from '../ai.js';
import { analyzeRequestDemo, draftEmailTemplate } from '../../public/js/demo-analyzer.js';
import { requireAuth } from '../auth.js';
import { validate } from '../http.js';

// ---- Giriş doğrulama ----------------------------------------------------------------
// Taslak isteği arayüzün kendi ürettiği yapıları taşır; şablon/AI'ın kullandığı alanlar zorunlu ve tipli,
// diğer alanlar korunur (looseObject). Bozuk veri 500 yerine 400 VALIDATION_ERROR alır.

const text = (max) => z.string().max(max);
const optText = (max) => text(max).nullable().optional();

const RequestSchema = z.object({
  from: text(500).optional().default(''),
  subject: text(500).optional().default(''),
  body: z.string({ error: 'Talep metni zorunludur.' }).max(50_000, 'Talep metni en fazla 50.000 karakter olabilir.'),
});

const AnalyzeSchema = RequestSchema.extend({
  body: RequestSchema.shape.body.refine((s) => s.trim().length > 0, 'Talep metni boş olamaz.'),
});

const AnalysisSchema = z.looseObject({
  customer: z.looseObject({ company: optText(300), contactName: optText(300), email: optText(300) }).nullable().optional(),
  items: z.array(z.looseObject({ requestedText: text(2000), productCode: optText(50) })).max(200),
  incoterm: optText(20),
  destination: optText(300),
  paymentTerms: optText(500),
  deadline: optText(200),
  urgency: optText(20),
  missingInfo: z.array(text(1000)).max(100).optional().default([]),
});

const QuoteLineSchema = z.looseObject({
  code: text(50),
  name: text(300),
  unit: text(30),
  quantity: z.number().finite().nonnegative(),
  unitPrice: z.number().finite(),
  total: z.number().finite(),
  quantityAssumed: z.boolean().optional(),
});

const QuoteSchema = z.looseObject({
  currency: text(10),
  incoterm: text(20),
  lines: z.array(QuoteLineSchema).max(200),
  subtotal: z.number().finite(),
  extraDiscountPercent: z.number().finite().min(0).max(100),
  extraDiscountAmount: z.number().finite(),
  total: z.number().finite(),
  leadTimeDays: z.number().finite().nullable().optional(),
});

const SettingsSchema = z.looseObject({
  companyName: text(200),
  contactName: text(200),
  email: optText(254),
  phone: optText(50),
  validityDays: z.number().int().min(1).max(365),
  defaultPaymentTerms: optText(300),
});

const DraftSchema = z.object({
  request: RequestSchema,
  analysis: AnalysisSchema,
  quote: QuoteSchema,
  settings: SettingsSchema,
});

export function aiRouter({ catalog, email, verification, aiLimiter }) {
  const r = Router();

  r.get('/status', (_req, res) => {
    const ai = isAiConfigured();
    res.json({
      mode: ai ? 'ai' : 'demo',
      model: ai ? MODEL : null,
      auth: true,
      mailDelivery: email.delivers,
      verificationTtlHours: verification.ttlHours,
      resendCooldownSeconds: verification.cooldownSeconds,
    });
  });

  r.post('/analyze', requireAuth, aiLimiter, async (req, res) => {
    const request = validate(AnalyzeSchema, req.body);
    if (!isAiConfigured()) return res.json(analyzeRequestDemo(request, catalog));
    try {
      res.json(await analyzeWithAI(request, catalog));
    } catch (err) {
      console.error('[analyze] AI hatası:', err?.message);
      res.json({ ...analyzeRequestDemo(request, catalog), warning: 'AI analizi başarısız oldu, kural tabanlı analiz kullanıldı.' });
    }
  });

  r.post('/draft-email', requireAuth, aiLimiter, async (req, res) => {
    const payload = validate(DraftSchema, req.body);
    if (!isAiConfigured()) return res.json(draftEmailTemplate(payload));
    try {
      res.json(await draftEmailWithAI(payload));
    } catch (err) {
      console.error('[draft-email] AI hatası:', err?.message);
      res.json({ ...draftEmailTemplate(payload), warning: 'AI taslağı başarısız oldu, şablon kullanıldı.' });
    }
  });

  return r;
}
