import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { createApp } from './app';
import { prisma } from './db/client';
import { backupSqliteDatabase } from './db/backup';
import { appendErrorLogToFile, safeErrorMessage } from './domain/errorLogger';

const execAsync = promisify(exec);
const port = Number(process.env.PORT || 4177);

// A stray background promise must never take the whole server down. Log it
// and keep serving — a dashboard that stays up beats one that dies silently.
process.on('unhandledRejection', (reason) => {
  const message = safeErrorMessage(reason);
  console.error(`Unhandled promise rejection: ${message}`);
  try {
    appendErrorLogToFile({ 
      source: 'process', 
      severity: 'error', 
      message: `unhandledRejection: ${message}` 
    });
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

// Self-migrate on boot so updates that add tables/columns apply cleanly.
// Use async exec instead of sync to avoid blocking the event loop.
async function runMigrations() {
  try {
    console.log('[Server] Running database migrations...');
    const { stdout, stderr } = await execAsync(
      'npx prisma db push --skip-generate --accept-data-loss',
      {
        cwd: path.join(__dirname, '..'),
        timeout: 60000,
      }
    );
    if (stdout) console.log('[Server] Migration output:', stdout.trim());
    if (stderr) console.warn('[Server] Migration stderr:', stderr.trim());
    console.log('[Server] Database migrations completed.');
  } catch (error) {
    console.warn(`[Server] Schema sync skipped: ${safeErrorMessage(error)}`);
    console.warn('[Server] If this is the first run, ensure Prisma is initialized.');
  }
}

async function startServer() {
  // Run migrations before starting server
  await runMigrations();

  const backupPath = backupSqliteDatabase(process.env.DATABASE_URL);
  if (backupPath) console.log(`[Server] Database backup saved to ${backupPath}`);

  const app = createApp({ recoverOnStartup: true });

  const server = app.listen(port, () => {
    console.log(`[Server] Leads-GenX running on http://localhost:${port}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${port} is already in use — an older server is still running.`);
      console.error('[Server] Stop it with: npx pm2 stop leads-genx || killall node');
    } else {
      console.error(`[Server] Server failed to start: ${error.message}`);
    }
    process.exit(1);
  });

  async function shutdown() {
    console.log('[Server] Shutting down gracefully...');
    server.close(() => {
      console.log('[Server] HTTP server closed.');
    });
    await prisma.$disconnect();
    console.log('[Server] Database disconnected.');
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
}

// Start the server
void startServer();
