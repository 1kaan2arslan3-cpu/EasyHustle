import 'dotenv/config';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { analyzeWithAI, draftEmailWithAI, isAiConfigured, MODEL } from './src/ai.js';
import { analyzeRequestDemo, draftEmailTemplate } from './public/js/demo-analyzer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const catalog = JSON.parse(await readFile(path.join(publicDir, 'data', 'catalog.json'), 'utf8'));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

app.get('/api/status', (_req, res) => {
  const ai = isAiConfigured();
  res.json({ mode: ai ? 'ai' : 'demo', model: ai ? MODEL : null });
});

app.post('/api/analyze', async (req, res) => {
  const { from = '', subject = '', body = '' } = req.body || {};
  if (!body.trim()) return res.status(400).json({ error: 'Talep metni boş olamaz.' });
  const request = { from, subject, body };

  if (!isAiConfigured()) return res.json(analyzeRequestDemo(request, catalog));
  try {
    res.json(await analyzeWithAI(request, catalog));
  } catch (err) {
    console.error('[analyze] AI hatası:', err);
    res.json({ ...analyzeRequestDemo(request, catalog), warning: `AI analizi başarısız oldu, demo analiz kullanıldı: ${err.message}` });
  }
});

app.post('/api/draft-email', async (req, res) => {
  const { request, analysis, quote, settings } = req.body || {};
  if (!request || !analysis || !quote || !settings) {
    return res.status(400).json({ error: 'request, analysis, quote ve settings alanları zorunludur.' });
  }
  if (!isAiConfigured()) return res.json(draftEmailTemplate({ request, analysis, quote, settings }));
  try {
    res.json(await draftEmailWithAI({ request, analysis, quote, settings }));
  } catch (err) {
    console.error('[draft-email] AI hatası:', err);
    res.json({ ...draftEmailTemplate({ request, analysis, quote, settings }), warning: `AI taslağı başarısız oldu, şablon kullanıldı: ${err.message}` });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`İhracat Teklif Asistanı → http://localhost:${port}`);
  console.log(isAiConfigured() ? `Mod: AI (${MODEL})` : 'Mod: DEMO (kural tabanlı) — AI için .env dosyasına ANTHROPIC_API_KEY ekleyin.');
});
