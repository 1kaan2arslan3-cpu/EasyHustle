// Prisma CLI yapılandırması (migrate, generate, studio).
// .env dosyası Node'un yerleşik process.loadEnvFile() ile yüklenir; dotenv gerekmez.
import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { resolveDatabaseUrl } from './src/database-url.js';

try {
  process.loadEnvFile(path.join(import.meta.dirname, '.env'));
} catch {
  /* .env yoksa ortam değişkenleri kullanılır */
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: resolveDatabaseUrl(process.env.DATABASE_URL, import.meta.dirname) },
});
