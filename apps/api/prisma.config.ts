import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer auto-loads .env. The single .env lives at the monorepo
// root so the API, the web app, and docker compose all read one file.
// fileURLToPath, not URL.pathname: on Windows the latter yields
// "/D:/Web%20Developement/...", which fs cannot open.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // process.env rather than Prisma's strict env() helper: `prisma generate`
  // needs no database and must work in the Docker build, where .env is
  // deliberately absent. migrate/studio still fail clearly if it is unset.
  datasource: {
    url: process.env['DATABASE_URL'],
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
