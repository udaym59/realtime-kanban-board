// Prisma config — the Prisma 7-ready replacement for the deprecated
// `package.json#prisma` block.
//
// `dotenv/config` is imported first so `env("DATABASE_URL")` resolves
// against our local .env (Prisma CLI does its own .env load for the
// schema's env() directives, but prisma.config.ts runs as plain TS and
// needs the env populated before `env()` evaluates).

import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
