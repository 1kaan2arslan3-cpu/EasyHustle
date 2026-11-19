// Testler için geçici SQLite veritabanı: gerçek migration'larla (prisma migrate deploy) oluşturulur.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, connectDb } from '../../src/db.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const prismaCli = path.join(rootDir, 'node_modules', 'prisma', 'build', 'index.js');

export function migrate(url) {
  return execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: rootDir,
    env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function createTestDb() {
  const dir = path.join(rootDir, 'test', '.tmp');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.db`);
  const url = `file:${file.replaceAll('\\', '/')}`;
  const migrateOutput = migrate(url);
  const db = await createDb(url);
  await connectDb(db, { retries: 1 });
  return {
    db,
    url,
    file,
    migrateOutput,
    async cleanup() {
      await db.$disconnect();
      for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    },
  };
}
