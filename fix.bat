@echo off
echo ==========================================
echo   Leads-GenX Emergency Fix
echo ==========================================
echo.
echo This will reset the repo to a working state,
echo add missing files, fix the budget bug, and rebuild.
echo.

set SERVER_IP=45.141.215.33
set SERVER_USER=root

echo [1/1] Connecting to server %SERVER_IP%...
echo When prompted, enter your server password.
echo.

ssh %SERVER_USER%@%SERVER_IP% "cd /var/www/Leads-genx && git reset --hard 2bf87636 && echo '--- Adding missing files ---' && cat > src/db/client.ts << 'DBEOF'
import { PrismaClient } from '@prisma/client';
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
DBEOF

cat > src/utils/asyncHandler.ts << 'ASYNCEOF'
import { Request, Response, NextFunction } from 'express';
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
ASYNCEOF

echo '--- Fixing budget bug ---' && sed -i 's/filters.publicSearchRequestBudget ?? 1_200/filters.publicSearchRequestBudget !== undefined ? filters.publicSearchRequestBudget : 1_200/g' src/domain/targeted/service.ts && echo '--- Rebuilding ---' && npm run build && echo '--- Restarting ---' && pm2 restart leads-genx && echo '--- Testing ---' && curl -s http://localhost:4177/api/targeted/campaigns && echo '' && echo '--- DONE ---'"

echo.
echo ==========================================
echo   Fix command sent!
echo ==========================================
echo.
echo If you see errors above, paste them here.
echo.
pause
