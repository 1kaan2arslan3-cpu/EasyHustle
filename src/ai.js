// Claude API ile talep analizi ve e-posta taslağı üretimi.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'medium';

const client = new Anthropic();

export function isAiConfigured() {
  if (process.env.DEMO_MODE === '1') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// ---- Şemalar ---------------------------------------------------------------

const AnalysisSchema = z.object({
  customer: z.object({
    company: z.string().nullable().describe('Müşteri firma adı'),
    contactName: z.string().nullable().describe('Talebi gönderen kişinin adı'),
    email: z.string().nullable(),
    country: z.string().nullable().describe('Türkçe ülke adı'),
    city: z.string().nullable(),
  }),
  summary: z.string().describe('Talebin 1-2 cümlelik Türkçe özeti'),
  items: z.array(
    z.object({
      requestedText: z.string().describe('Müşterinin bu kalem için yazdığı ifade'),
      productCode: z.string().nullable().describe('Katalogdaki eşleşen ürün kodu; emin değilsen null'),
      quantity: z.number().nullable().describe('İstenen miktar; belirtilmemişse null'),
      unit: z.string().describe('adet, takım vb.'),
      note: z.string().nullable().describe('Eşleştirme veya kalemle ilgili kısa not'),
    }),
  ),
  incoterm: z.string().nullable().describe('EXW, FCA, FOB, CFR, CIF, DAP vb. Belirtilmemişse null'),
  destination: z.string().nullable().describe('Teslim/varış noktası'),
  paymentTerms: z.string().nullable(),
  deadline: z.string().nullable().describe('Müşterinin istediği teslim tarihi veya süre'),
  urgency: z.enum(['düşük', 'normal', 'yüksek']),
  missingInfo: z.array(z.string()).describe('Teklifi kesinleştirmek için müşteriden istenmesi gereken bilgiler'),
  salesNotes: z.array(z.string()).describe('Satış ekibine öneriler: müşterinin ek soruları, fırsatlar, riskler'),
});

const EmailSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

// ---- Yardımcılar -----------------------------------------------------------

function catalogForPrompt(catalog) {
  return catalog.products
    .map((p) => `- ${p.code}: ${p.name} — ${p.description}. Birim: ${p.unit}. MOQ: ${p.moq}. Termin: ${p.leadTimeDays} gün.`)
    .join('\n');
}

async function parseWithClaude({ system, user, schema }) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: EFFORT, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Model bu talebi işlemeyi reddetti.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Yanıt token sınırına takıldı.');
  }
  if (!response.parsed_output) {
    throw new Error('Model yanıtı beklenen biçimde değil.');
  }
  return response.parsed_output;
}

// ---- Genel API ------------------------------------------------------------

export async function analyzeWithAI(request, catalog) {
  const system = `Sen bir Türk tekstil ihracat firmasının satış asistanısın. Gelen müşteri e-postalarını analiz edip teklif hazırlığı için yapılandırılmış veri çıkarıyorsun.

Firma ürün kataloğu:
${catalogForPrompt(catalog)}

Kurallar:
- Her talep edilen ürünü katalogdaki en uygun ürün koduyla eşleştir. Ebat/model belirsizse veya katalogda yoksa productCode = null yap ve note alanında açıkla.
- Miktarları sayı olarak ver (ör. "12.000" → 12000). Belirtilmemişse null.
- Fiyat üretme veya tahmin etme; fiyatlar sistem tarafından hesaplanır.
- Yalnızca e-postada yazanları kullan, olmayan bilgiyi uydurma.
- missingInfo: teklifi kesinleştirmek için eksik olan bilgiler (miktar, ebat, Incoterm, ödeme koşulu, teslim tarihi gibi).
- salesNotes: müşterinin ek soruları (renk, logo, numune vb.), aciliyet, satış fırsatları.
- Tüm metinleri Türkçe yaz.`;

  const user = `Gönderen: ${request.from || '-'}
Konu: ${request.subject || '-'}

<email>
${request.body}
</email>`;

  const result = await parseWithClaude({ system, user, schema: AnalysisSchema });
  // Katalogda olmayan kodları temizle
  const codes = new Set(catalog.products.map((p) => p.code));
  for (const item of result.items) {
    if (item.productCode && !codes.has(item.productCode)) item.productCode = null;
  }
  return { ...result, source: 'ai' };
}

export async function draftEmailWithAI({ request, analysis, quote, settings }) {
  const system = `Sen bir Türk ihracat firmasının deneyimli satış temsilcisisin. Müşteriye gönderilecek profesyonel, sıcak ama net bir teklif e-postası yazıyorsun.

Kurallar:
- E-posta Türkçe olsun.
- Fiyatları, miktarları ve toplamları SADECE verilen teklif verisinden al; hiçbir rakamı değiştirme veya yeni rakam ekleme.
- Teklif kalemlerini düz metin olarak okunaklı listele (e-posta istemcilerinde tablo bozulabilir).
- Teslim şekli, ödeme koşulu, termin ve teklif geçerlilik süresini belirt.
- Müşterinin ek sorularına (renk, logo vb.) kısa ve dürüst yanıt ver; bilinmeyen konularda "ayrıca bilgi paylaşacağız" de, söz verme.
- Eksik bilgileri nazikçe sor.
- Miktar belirtilmemiş kalemler MOQ üzerinden fiyatlandırıldıysa bunu belirt.
- İmzayı verilen firma bilgileriyle bitir. Yer tutucu ([...]) bırakma.`;

  const user = `Müşterinin orijinal e-postası:
<email>
Konu: ${request.subject || '-'}
${request.body}
</email>

Analiz:
${JSON.stringify(analysis, null, 2)}

Teklif verisi (fiyatlar ${quote.currency}):
${JSON.stringify(quote, null, 2)}

Firma bilgileri:
${JSON.stringify(settings, null, 2)}`;

  const result = await parseWithClaude({ system, user, schema: EmailSchema });
  return { ...result, source: 'ai' };
}
