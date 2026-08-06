@echo off
echo ==========================================
echo   Leads-GenX Targeted Routes Fix
echo ==========================================
echo.

set SERVER_IP=45.141.215.33
set SERVER_USER=root

echo [1/1] Connecting to server %SERVER_IP%...
echo When prompted, enter your server password.
echo.

ssh %SERVER_USER%@%SERVER_IP% "cd /var/www/Leads-genx && echo '=== STEP 1: Restore original targeted routes ===' && git checkout 2bf87636 -- src/routes/targeted.ts src/domain/targeted/service.ts src/domain/targeted/store.ts src/integrations/localMapsScraperClient.ts src/integrations/apifyActorClient.ts src/integrations/actorClient.ts src/app.ts src/domain/runService.ts src/domain/runEngineer.ts src/domain/balancedGoogleMapsRunService.ts && echo '=== STEP 2: Add missing core files ===' && cat > src/db/client.ts << 'DBEOF'
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

echo '=== STEP 3: Fix budget bug only ===' && sed -i 's/filters.publicSearchRequestBudget ?? 1_200/filters.publicSearchRequestBudget !== undefined ? filters.publicSearchRequestBudget : 1_200/g' src/domain/targeted/service.ts && echo '=== STEP 4: Rebuild ===' && npm run build && echo '=== STEP 5: Restart ===' && pm2 restart leads-genx && echo '=== STEP 6: Test ===' && curl -s http://localhost:4177/api/targeted/catalog | head -c 200 && echo '' && echo '=== DONE ==='"

echo.
echo ==========================================
echo   Fix command sent!
echo ==========================================
echo.
pause
