import { describe, expect, it, vi } from 'vitest';
import { CanadianBankMarketsClient, rankCanadianBankMarkets } from '../../../src/domain/targeted/canadianBankMarkets';

describe('Canadian bank markets', () => {
  it('ranks public branch and ATM locations by city and derives area codes', () => {
    const markets = rankCanadianBankMarkets([
      { tags: { name: 'RBC Royal Bank', amenity: 'bank', 'addr:city': 'Toronto', 'addr:province': 'Ontario', 'addr:postcode': 'M5H 2N2', phone: '+1 416-555-0100' } },
      { tags: { operator: 'RBC', amenity: 'atm', 'addr:city': 'Toronto', 'addr:province': 'ON', 'addr:postcode': 'M5J 2T3', phone: '647-555-0101' } },
      { tags: { name: 'RBC Royal Bank', amenity: 'bank', 'addr:city': 'Ottawa', 'addr:province': 'ON', 'addr:postcode': 'K1P 1J1', phone: '613-555-0102' } },
    ], 'RBC Royal Bank', 25);
    expect(markets[0]).toMatchObject({ city: 'Toronto', state: 'ON', branchCount: 2, areaCodes: ['416', '647'] });
    expect(markets[0].postalCodes).toEqual(['M5H 2N2', 'M5J 2T3']);
  });

  it('queries the bounded public OpenStreetMap data service for the selected bank', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ elements: [
      { tags: { name: 'RBC Royal Bank', amenity: 'bank', 'addr:city': 'Toronto', 'addr:province': 'ON', 'addr:postcode': 'M5H 2N2' } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const markets = await new CanadianBankMarketsClient(fetcher).markets('RBC Royal Bank', 25);
    expect(String(fetcher.mock.calls[0][0])).toContain('overpass-api.de/api/interpreter');
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('RBC Royal Bank');
    expect(markets[0]).toMatchObject({ city: 'Toronto', state: 'ON' });
  });
});
