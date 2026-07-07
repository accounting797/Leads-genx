import { createApp } from './app';
import { prisma } from './db/client';

const port = Number(process.env.PORT || 4177);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`Leads-GenX running on http://localhost:${port}`);
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
