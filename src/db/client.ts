import { PrismaClient } from '@prisma/client';

// A missing DATABASE_URL should never silently kill the dashboard —
// fall back to the default local SQLite file.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';

export const prisma = new PrismaClient();
