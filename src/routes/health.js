// GET /api/health — sağlık kontrolü (izleme servisleri, yük dengeleyiciler, deploy kontrolleri için).
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { pingDb } from '../db.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export function healthRouter({ db, env }) {
  const r = Router();
  r.get('/health', async (_req, res) => {
    let database = 'ok';
    try {
      await pingDb(db);
    } catch {
      database = 'error';
    }
    const healthy = database === 'ok';
    res.set('Cache-Control', 'no-store');
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'error',
      service: pkg.name,
      version: pkg.version,
      environment: env,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: { database },
    });
  });
  return r;
}
