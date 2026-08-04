export interface FdicLocationRow {
  NAME?: string;
  CITY?: string;
  STALP?: string;
  ZIP?: string;
  OFFNAME?: string;
  TELEPHONE?: string;
}

export interface BankMarket {
  bankName: string;
  city: string;
  state: string;
  postalCodes: string[];
  areaCodes: string[];
  branchCount: number;
}

export type AreaCodeIndex = Record<string, string[]>;

export const DEFAULT_AREA_CODE_INDEX: AreaCodeIndex = {
  'phoenix|az': ['602', '480'], 'tucson|az': ['520'], 'avondale|az': ['623'],
  'new york|ny': ['212', '646', '917'], 'los angeles|ca': ['213', '323'], 'chicago|il': ['312', '773'],
  'houston|tx': ['713', '832'], 'dallas|tx': ['214', '469', '972'], 'miami|fl': ['305', '786'],
  'atlanta|ga': ['404', '470'], 'san francisco|ca': ['415', '628'], 'seattle|wa': ['206'],
  'boston|ma': ['617', '857'], 'denver|co': ['303', '720'], 'toronto|on': ['416', '647'],
  'vancouver|bc': ['604', '778'], 'montreal|qc': ['514', '438'],
};

export class FdicBankMarketsError extends Error {
  constructor(public readonly status: number, public readonly retryable: boolean, message: string) {
    super(message);
    this.name = 'FdicBankMarketsError';
  }
}

export function rankBankMarkets(rows: FdicLocationRow[], areaCodeIndex: AreaCodeIndex = DEFAULT_AREA_CODE_INDEX, limit = 25): BankMarket[] {
  const grouped = new Map<string, { market: BankMarket; areaCodeCounts: Map<string, number> }>();
  for (const row of rows) {
    const city = row.CITY?.trim();
    const state = row.STALP?.trim().toUpperCase();
    if (!city || !state) continue;
    const key = `${city.toLowerCase()}|${state.toLowerCase()}`;
    const entry = grouped.get(key) ?? { market: {
      bankName: row.NAME?.trim() ?? '', city, state, postalCodes: [], areaCodes: [], branchCount: 0,
    }, areaCodeCounts: new Map<string, number>() };
    const market = entry.market;
    market.branchCount += 1;
    const postalCode = row.ZIP?.trim();
    if (postalCode && !market.postalCodes.includes(postalCode)) market.postalCodes.push(postalCode);
    const telephone = (row.TELEPHONE ?? '').replace(/\D/g, '');
    const areaCode = telephone.length === 10 ? telephone.slice(0, 3)
      : telephone.length === 11 && telephone.startsWith('1') ? telephone.slice(1, 4) : undefined;
    if (areaCode) entry.areaCodeCounts.set(areaCode, (entry.areaCodeCounts.get(areaCode) ?? 0) + 1);
    grouped.set(key, entry);
  }
  return [...grouped.entries()].map(([key, entry]) => ({
    ...entry.market,
    areaCodes: entry.areaCodeCounts.size
      ? [...entry.areaCodeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code)
      : areaCodeIndex[key] ?? [],
  }))
    .sort((a, b) => b.branchCount - a.branchCount || a.state.localeCompare(b.state) || a.city.localeCompare(b.city))
    .slice(0, limit);
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class FdicBankMarketsClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async markets(bankName: string, limit = 25, fdicCertificate?: number): Promise<BankMarket[]> {
    const url = new URL('https://api.fdic.gov/banks/locations');
    url.searchParams.set('filters', fdicCertificate ? `CERT:${fdicCertificate}` : `NAME:"${bankName.replace(/["\\]/g, '')}"`);
    url.searchParams.set('fields', 'NAME,CERT,CITY,STALP,ZIP,OFFNAME,TELEPHONE');
    url.searchParams.set('limit', '10000');
    url.searchParams.set('format', 'json');
    const response = await this.fetcher(url, {
      headers: { 'user-agent': 'Lead-Gen-X/1.0 targeted-public-business-research' },
      signal: AbortSignal.timeout(15_000),
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 5 * 1024 * 1024) throw new FdicBankMarketsError(response.status, false, 'FDIC response exceeded 5 MB.');
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new FdicBankMarketsError(response.status, retryable, `FDIC locations request failed with HTTP ${response.status}.`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) throw new FdicBankMarketsError(200, false, 'FDIC response exceeded 5 MB.');
    const body = JSON.parse(text) as { data?: Array<FdicLocationRow | { data?: FdicLocationRow }> };
    const rows = (body.data ?? []).map((entry) => 'data' in entry && entry.data ? entry.data : entry as FdicLocationRow);
    return rankBankMarkets(rows, DEFAULT_AREA_CODE_INDEX, limit);
  }
}
