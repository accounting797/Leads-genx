import { BankMarket } from './fdicBankMarkets';

export interface OsmBankElement {
  tags?: Record<string, string | undefined>;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const PROVINCES: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'nova scotia': 'NS', ontario: 'ON',
  'prince edward island': 'PE', quebec: 'QC', saskatchewan: 'SK',
  'northwest territories': 'NT', nunavut: 'NU', yukon: 'YT',
};

const CITY_AREA_CODES: Record<string, string[]> = {
  'toronto|on': ['416', '647', '437'], 'ottawa|on': ['613', '343'],
  'mississauga|on': ['905', '289', '365'], 'brampton|on': ['905', '289', '365'],
  'hamilton|on': ['905', '289', '365'], 'london|on': ['519', '226', '548'],
  'montreal|qc': ['514', '438', '263'], 'quebec city|qc': ['418', '581', '367'],
  'vancouver|bc': ['604', '778', '236', '672'], 'surrey|bc': ['604', '778', '236', '672'],
  'victoria|bc': ['250', '778', '236', '672'], 'calgary|ab': ['403', '587', '825'],
  'edmonton|ab': ['780', '587', '825'], 'winnipeg|mb': ['204', '431', '584'],
  'halifax|ns': ['902', '782'], 'saskatoon|sk': ['306', '639', '474'],
  'regina|sk': ['306', '639', '474'],
};

function provinceCode(value: string | undefined): string | undefined {
  const cleaned = (value ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(cleaned)) return cleaned.toUpperCase();
  return PROVINCES[cleaned.toLowerCase()];
}

function areaCodeFromPhone(value: string | undefined): string | undefined {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 10) return digits.slice(0, 3);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
  return undefined;
}

export function rankCanadianBankMarkets(
  elements: OsmBankElement[],
  bankName: string,
  limit = 25,
): BankMarket[] {
  const grouped = new Map<string, { market: BankMarket; areaCodes: Map<string, number> }>();
  for (const element of elements) {
    const tags = element.tags ?? {};
    const city = tags['addr:city']?.trim();
    const state = provinceCode(tags['addr:province'] ?? tags['addr:state']);
    if (!city || !state) continue;
    const key = `${city.toLowerCase()}|${state.toLowerCase()}`;
    const entry = grouped.get(key) ?? {
      market: { bankName, city, state, postalCodes: [], areaCodes: [], branchCount: 0 },
      areaCodes: new Map<string, number>(),
    };
    entry.market.branchCount += 1;
    const postal = tags['addr:postcode']?.trim().toUpperCase();
    if (postal && !entry.market.postalCodes.includes(postal)) entry.market.postalCodes.push(postal);
    const areaCode = areaCodeFromPhone(tags.phone ?? tags['contact:phone']);
    if (areaCode) entry.areaCodes.set(areaCode, (entry.areaCodes.get(areaCode) ?? 0) + 1);
    grouped.set(key, entry);
  }
  return [...grouped.entries()].map(([key, entry]) => ({
    ...entry.market,
    areaCodes: entry.areaCodes.size
      ? [...entry.areaCodes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code)
      : CITY_AREA_CODES[key] ?? [],
  })).sort((a, b) => b.branchCount - a.branchCount || a.state.localeCompare(b.state) || a.city.localeCompare(b.city))
    .slice(0, Math.min(100, Math.max(1, limit)));
}

function overpassPattern(bankName: string): string {
  return bankName.replace(/[\\"^$.*+?()[\]{}|]/g, '\\$&');
}

export class CanadianBankMarketsClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async markets(bankName: string, limit = 25): Promise<BankMarket[]> {
    const pattern = overpassPattern(bankName);
    const query = `[out:json][timeout:25];area["ISO3166-1"="CA"][admin_level=2]->.ca;(nwr["amenity"="bank"]["name"~"${pattern}",i](area.ca);nwr["amenity"="atm"]["operator"~"${pattern}",i](area.ca););out tags;`;
    const response = await this.fetcher('https://overpass-api.de/api/interpreter', {
      method: 'POST', headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'user-agent': 'Lead-Gen-X/1.0 targeted-public-business-research',
      }, body: query, signal: AbortSignal.timeout(30_000),
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 5 * 1024 * 1024) throw new Error('Canadian bank market response exceeded 5 MB.');
    if (!response.ok) throw new Error(`Canadian bank market request failed with HTTP ${response.status}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) throw new Error('Canadian bank market response exceeded 5 MB.');
    const body = JSON.parse(text) as { elements?: OsmBankElement[] };
    return rankCanadianBankMarkets(body.elements ?? [], bankName, limit);
  }
}
