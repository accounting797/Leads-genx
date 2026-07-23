import { createApp } from './app';
import { prisma } from './db/client';
import { backupSqliteDatabase } from './db/backup';

const port = Number(process.env.PORT || 4177);

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
