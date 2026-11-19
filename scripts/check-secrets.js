// Commit / push öncesi gizli bilgi taraması.
//   npm run check:secrets              → repoya girecek dosyalar (.gitignore uygulanır)
//   npm run check:secrets -- --history → + Git geçmişindeki tüm nesneler (.git/objects)
//
// Bulunan değerler ASLA yazdırılmaz (yalnızca 3 karakterlik ön ek + uzunluk). Bulgu varsa çıkış kodu 1.
// Ayrıca yerel .env dosyasındaki dolu değerlerin (anahtarlar, şifreli bağlantı adresleri) repoya girecek
// herhangi bir dosyada veya geçmişte geçip geçmediği birebir kontrol edilir.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withHistory = process.argv.includes('--history');

// ---- Desenler -------------------------------------------------------------------------
const PATTERNS = [
  ['Resend API anahtarı', /\bre_[A-Za-z0-9_]{20,}/g],
  ['Anthropic API anahtarı', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI API anahtarı', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['AWS erişim anahtarı', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['Stripe gizli anahtar', /\b[sr]k_live_[A-Za-z0-9]{20,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API anahtarı', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Özel anahtar (PEM)', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['Şifreli bağlantı adresi', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:[^\s@/'"`]{3,}@[^\s'"`]+/gi],
];
// Test / örnek değerleri (bunlar gerçek sır değildir)
const PLACEHOLDER = /test|example|x{4,}|placeholder|dummy|fake|sample|ornek|örnek|kullanici|sifre|user(name)?:|:pass(word)?@|<|\$\{|\*{3}/i;

// Genel "anahtar = değer" ataması (test klasörü hariç: testlerde sahte şifreler bilerek var)
const ASSIGNMENT = /\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi;

// Repoda OLMAMASI gereken dosya adları (.gitignore'dan kaçmışsa bulgu)
const SENSITIVE_NAME = /^(\.env(\..+)?|.+\.env|.+\.(pem|key|p12|pfx|jks|db|sqlite3?)|id_(rsa|ed25519).*|credentials\.json|\.npmrc|\.netrc)$/i;
const SENSITIVE_ALLOW = new Set(['.env.example']);

// Yalnızca türü belli eden ön ek (ör. "re_", "sk-") gösterilir; anahtarın kendisinden karakter sızmaz
const mask = (s) => `${s.slice(0, 3)}****(${s.length} karakter)`;

// ---- .gitignore (repo için yeterli, basit uygulama) ----------------------------------------
function loadIgnore() {
  const rules = [];
  const file = path.join(root, '.gitignore');
  if (!existsSync(file)) return rules;
  for (let line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    const rx = line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    rules.push({ negate, dirOnly, regex: new RegExp(anchored ? `^${rx}$` : `(^|/)${rx}$`) });
  }
  return rules;
}
const RULES = loadIgnore();
function ignored(rel, isDir) {
  let result = false;
  for (const r of RULES) {
    if (r.dirOnly && !isDir) continue;
    if (r.regex.test(rel)) result = !r.negate;
  }
  return result;
}

function walk(dir = '', out = []) {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (name === '.git') continue;
    const full = path.join(root, rel);
    const isDir = statSync(full).isDirectory();
    if (ignored(rel, isDir)) continue;
    if (isDir) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// ---- Yerel .env'deki gerçek değerler (yalnızca bellekte; asla yazdırılmaz) ----------------
function localSecretValues() {
  const values = [];
  for (const f of ['.env', '.env.local', '.env.development', '.env.production']) {
    const p = path.join(root, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\r\n]*?)"?\s*$/i);
      if (!m) continue;
      const [, key, value] = m;
      // Gizli olmayan ayarları atla
      if (!value || value.length < 8 || /^(NODE_ENV|PORT|APP_URL|APP_NAME|CORS_ORIGINS|TRUST_PROXY|COOKIE_SAMESITE|EMAIL_VERIFICATION_TTL_HOURS|CLAUDE_MODEL|CLAUDE_EFFORT|DEMO_MODE|MAIL_FROM|MAIL_REPLY_TO|RESEND_API_URL)$/.test(key)) continue;
      if (key === 'DATABASE_URL' && value.startsWith('file:')) continue;
      values.push({ key, value, file: f });
    }
  }
  return values;
}

function scanText(label, text, { generic = true } = {}) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, rx] of PATTERNS) {
      for (const m of line.matchAll(rx)) {
        if (PLACEHOLDER.test(m[0])) continue;
        findings.push({ where: `${label}:${i + 1}`, what: name, value: mask(m[0]) });
      }
    }
    if (generic) {
      for (const m of line.matchAll(ASSIGNMENT)) {
        if (PLACEHOLDER.test(m[2]) || /process\.env|config\.|\$\{/.test(line)) continue;
        findings.push({ where: `${label}:${i + 1}`, what: `"${m[1]}" ataması`, value: mask(m[2]) });
      }
    }
    for (const s of SECRETS) {
      if (line.includes(s.value)) findings.push({ where: `${label}:${i + 1}`, what: `${s.file} içindeki ${s.key} değeri`, value: mask(s.value) });
    }
  });
  return findings;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const SECRETS = localSecretValues();

// ---- 1) Repoya girecek dosyalar ------------------------------------------------------------
const files = walk();
const findings = [];
const sensitiveFiles = [];
for (const rel of files) {
  const base = rel.split('/').pop();
  if (SENSITIVE_NAME.test(base) && !SENSITIVE_ALLOW.has(base)) sensitiveFiles.push(rel);
  const buf = readFileSync(path.join(root, rel));
  if (isBinary(buf)) continue;
  findings.push(...scanText(rel, buf.toString('utf8'), { generic: !rel.startsWith('test/') }));
}

// .gitignore'un gerçekten koruduğu dosyalar
const mustIgnore = ['.env', '.env.local', '.env.production', 'data/dev.db', 'src/generated/prisma/client.ts', 'node_modules/x', 'key.pem'];
const notIgnored = mustIgnore.filter((rel) => {
  const parts = rel.split('/');
  return !parts.some((_, i) => ignored(parts.slice(0, i + 1).join('/'), i < parts.length - 1)) && !ignored(rel, false);
});
const mustKeep = ['.env.example', 'public/data/catalog.json', 'public/data/sample-requests.json', 'prisma/migrations/x/migration.sql'];
const wronglyIgnored = mustKeep.filter((rel) => {
  const parts = rel.split('/');
  return parts.some((_, i) => ignored(parts.slice(0, i + 1).join('/'), i < parts.length - 1));
});

// ---- 2) Git geçmişi (gevşek nesneler) ---------------------------------------------------------
const history = { objects: 0, packs: 0, findings: [] };
if (withHistory) {
  const objDir = path.join(root, '.git', 'objects');
  if (existsSync(objDir)) {
    for (const d of readdirSync(objDir)) {
      if (d === 'pack') {
        history.packs = readdirSync(path.join(objDir, d)).filter((f) => f.endsWith('.pack')).length;
        continue;
      }
      if (!/^[0-9a-f]{2}$/.test(d)) continue;
      for (const f of readdirSync(path.join(objDir, d))) {
        const raw = inflateSync(readFileSync(path.join(objDir, d, f)));
        history.objects++;
        const nul = raw.indexOf(0);
        const type = raw.subarray(0, nul).toString().split(' ')[0];
        const body = raw.subarray(nul + 1);
        if (type === 'tree' || isBinary(body)) continue;
        history.findings.push(...scanText(`git:${type}:${d}${f.slice(0, 6)}`, body.toString('utf8'), { generic: true }));
      }
    }
    for (const f of ['COMMIT_EDITMSG', 'config', 'logs/HEAD']) {
      const p = path.join(root, '.git', f);
      if (existsSync(p)) history.findings.push(...scanText(`.git/${f}`, readFileSync(p, 'utf8')));
    }
  }
}

// ---- Rapor ---------------------------------------------------------------------------------
const ok = (b) => (b ? 'TAMAM' : 'SORUN');
console.log(`Taranan dosya (repoya girecek): ${files.length}`);
console.log(`Yerel .env'den karşılaştırılan gizli değer sayısı: ${SECRETS.length} (değerler yazdırılmaz)`);
console.log(`[${ok(!notIgnored.length)}] .gitignore gizli dosyaları koruyor${notIgnored.length ? ` — korunmayan: ${notIgnored.join(', ')}` : ''}`);
console.log(`[${ok(!wronglyIgnored.length)}] Gerekli dosyalar yanlışlıkla yok sayılmıyor${wronglyIgnored.length ? ` — yok sayılan: ${wronglyIgnored.join(', ')}` : ''}`);
console.log(`[${ok(!sensitiveFiles.length)}] Repoya girecek hassas dosya yok${sensitiveFiles.length ? ` — ${sensitiveFiles.join(', ')}` : ''}`);
console.log(`[${ok(!findings.length)}] Dosyalarda gizli bilgi bulunmadı`);
findings.forEach((f) => console.log(`    ${f.where}  ${f.what}  ${f.value}`));
if (withHistory) {
  console.log(`[${ok(!history.findings.length)}] Git geçmişi: ${history.objects} nesne tarandı${history.packs ? `, ${history.packs} paket dosyası TARANAMADI (git gerekir)` : ''}`);
  history.findings.forEach((f) => console.log(`    ${f.where}  ${f.what}  ${f.value}`));
}
const failed = notIgnored.length || wronglyIgnored.length || sensitiveFiles.length || findings.length || history.findings.length || history.packs;
console.log(failed ? '\nSONUÇ: Bulgular var — commit/push ÖNCESİ giderin.' : '\nSONUÇ: Temiz.');
process.exit(failed ? 1 : 0);
