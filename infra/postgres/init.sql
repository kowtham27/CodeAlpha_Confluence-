-- Runs once, on first cluster creation only (empty pgdata volume).
-- Prisma owns all table DDL; this file is strictly for extensions.
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive User.email
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
