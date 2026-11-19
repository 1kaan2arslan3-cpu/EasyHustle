// DATABASE_URL'i tek biçime getirir. Hem uygulama hem Prisma CLI (prisma.config.ts) kullanır,
// böylece göreli SQLite yolu her zaman proje klasörüne göre çözülür (çalışma dizininden bağımsız).
import path from 'node:path';

export const DEFAULT_DATABASE_URL = 'file:./data/dev.db';

/**
 * @param {string|undefined} url   ör. "file:./data/dev.db" veya "postgresql://..."
 * @param {string} rootDir         proje kök dizini
 * @returns {string}               SQLite için mutlak "file:" adresi; diğerleri olduğu gibi
 */
export function resolveDatabaseUrl(url, rootDir) {
  const value = (url || DEFAULT_DATABASE_URL).trim();
  if (!value.startsWith('file:')) return value;
  const file = value.slice('file:'.length);
  if (file === ':memory:') return value;
  return `file:${path.resolve(rootDir, file).replaceAll('\\', '/')}`;
}

/** "file:" adresinden dosya yolunu döner (SQLite değilse null). */
export function sqliteFilePath(url) {
  return url.startsWith('file:') ? url.slice('file:'.length) : null;
}
