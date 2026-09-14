/**
 * Seed script. Phase 0 has no domain data worth seeding — users arrive in
 * Phase 1, rooms in Phase 2. Kept wired up from the start so later phases only
 * add to the body, and so `pnpm db:seed` is a working connection check today.
 */
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('DATABASE_URL is not set; copy .env.example to .env');
}

// Prisma 7 has no schema-level url, so the client is always adapter-driven.
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main(): Promise<void> {
  await prisma.$connect();
  console.warn('seed: connected; nothing to seed in phase 0');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
