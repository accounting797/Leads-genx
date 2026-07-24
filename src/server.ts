import { execSync } from 'child_process';
import path from 'path';
import { createApp } from './app';
import { prisma } from './db/client';
import { backupSqliteDatabase } from './db/backup';
import { appendErrorLogToFile, safeErrorMessage } from './domain/errorLogger';

const port = Number(process.env.PORT || 4177);

// A stray background promise must never take the whole server down. Log it
// and keep serving — a dashboard that stays up beats one that dies silently.
process.on('unhandledRejection', (reason) => {
  const message = safeErrorMessage(reason);
  console.error(`Unhandled promise rejection: ${message}`);
  try {
    appendErrorLogToFile({ source: 'process', severity: 'error', message: `unhandledRejection: ${message}` });
  } catch {
    // Logging must never crash the process.
  }
});

// A truly unexpected exception leaves the process in an unknown state: log it
// for diagnosis, then exit so the supervisor (systemd / start script) can
// restart the app clean instead of limping along corrupted.
process.on('uncaughtException', (error) => {
  const message = safeErrorMessage(error);
  console.error(`Uncaught exception: ${message}`);
  try {
    appendErrorLogToFile({
      source: 'process',
      severity: 'error',
      message: `uncaughtException: ${message}`,
      details: error.stack,
    });
  } catch {
    // Logging must never crash the process.
  }
  process.exit(1);
});

// Self-migrate on boot so updates that add tables/columns (e.g. accounts)
// apply cleanly even when the update script forgets to run prisma db push.
try {
  execSync('npx prisma db push --skip-generate', {
    cwd: path.join(__dirname, '..'),
    stdio: 'ignore',
  });
} catch (error) {
  console.warn(`Schema sync skipped: ${error instanceof Error ? error.message : error}`);
}

const backupPath = backupSqliteDatabase(process.env.DATABASE_URL);
if (backupPath) console.log(`Database backup saved to ${backupPath}`);

const app = createApp({ recoverOnStartup: true });

const server = app.listen(port, () => {
  console.log(`Leads-GenX running on http://localhost:${port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use — an older server is still running.`);
    console.error('Stop it with: taskkill /F /IM node.exe');
  } else {
    console.error(`Server failed to start: ${error.message}`);
  }
  process.exit(1);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
