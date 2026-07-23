import net from 'node:net';
import { SocksClient } from 'socks';
import { maskProxyUrl } from '../domain/operatorSettings';

export interface ProxyTestResult {
  proxy: string;
  ok: boolean;
  latencyMs?: number;
  errorCode?: string;
}

const PROBE_HOST = 'www.gstatic.com';
const PROBE_PORT = 80;
const DEFAULT_TIMEOUT_MS = 6000;

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code) return String(code).toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('refused')) return 'connection_refused';
  if (message.includes('auth')) return 'auth_failed';
  return 'connect_failed';
}

function httpConnect(url: URL, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('timed out')));
    socket.once('error', fail);
    socket.once('connect', () => {
      const user = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      const auth = user ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${password}`).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${PROBE_HOST}:${PROBE_PORT} HTTP/1.1\r\nHost: ${PROBE_HOST}:${PROBE_PORT}\r\n${auth}\r\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const statusLine = buffer.split('\r\n', 1)[0] ?? '';
      if (!statusLine) return;
      const statusCode = Number(statusLine.split(' ')[1]);
      socket.destroy();
      if (statusCode >= 200 && statusCode < 300) resolve();
      else reject(new Error(`proxy returned status ${statusCode || 'unknown'}`));
    });
  });
}

async function probe(rawUrl: string, timeoutMs: number): Promise<void> {
  const url = new URL(rawUrl);
  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (scheme === 'socks5' || scheme === 'socks5h') {
    const established = await SocksClient.createConnection({
      command: 'connect',
      destination: { host: PROBE_HOST, port: PROBE_PORT },
      proxy: {
        host: url.hostname,
        port: Number(url.port),
        type: 5,
        userId: decodeURIComponent(url.username) || undefined,
        password: decodeURIComponent(url.password) || undefined,
      },
      timeout: timeoutMs,
    });
    established.socket.destroy();
    return;
  }
  if (scheme === 'http' || scheme === 'https') {
    await httpConnect(url, timeoutMs);
    return;
  }
  throw Object.assign(new Error('unsupported scheme'), { code: 'unsupported_scheme' });
}

export async function testProxy(rawUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProxyTestResult> {
  const started = Date.now();
  try {
    await probe(rawUrl, timeoutMs);
    return { proxy: maskProxyUrl(rawUrl), ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      proxy: maskProxyUrl(rawUrl),
      ok: false,
      latencyMs: Date.now() - started,
      errorCode: errorCode(error),
    };
  }
}

export async function testProxies(urls: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProxyTestResult[]> {
  const results: ProxyTestResult[] = [];
  let index = 0;
  async function worker() {
    while (index < urls.length) {
      const current = index;
      index += 1;
      results[current] = await testProxy(urls[current], timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, urls.length) }, worker));
  return results;
}
