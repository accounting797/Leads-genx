declare module 'socks' {
  import { Duplex } from 'node:stream';

  export interface SocksProxy {
    host?: string;
    port?: number;
    type?: 4 | 5;
    userId?: string;
    password?: string;
  }

  export interface SocksClientOptions {
    command: 'connect' | 'bind' | 'associate';
    destination: { host: string; port: number };
    proxy: SocksProxy;
    timeout?: number;
  }

  export interface SocksClientEstablishedEvent {
    socket: Duplex;
  }

  export class SocksClient {
    static createConnection(options: SocksClientOptions): Promise<SocksClientEstablishedEvent>;
  }
}
