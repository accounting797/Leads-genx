import fs from 'fs';
import path from 'path';
import { redactSecrets } from './redact';

export interface ErrorLogInput {
  runId?: number;
  requestId?: string;
  source: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  details?: unknown;
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactSecrets(message));
}

export function appendErrorLogToFile(error: ErrorLogInput): void {
  const logDir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const line = JSON.stringify(redactSecrets({ ...error, createdAt: new Date().toISOString() }));
  fs.appendFileSync(path.join(logDir, 'app.log'), `${line}\n`);
}
