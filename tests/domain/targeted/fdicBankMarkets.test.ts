import { describe, expect, it, vi } from 'vitest';
import { FdicBankMarketsClient, rankBankMarkets } from '../../../src/domain/targeted/fdicBankMarkets';

describe('FDIC bank markets', () => {
  it('ranks markets by branch count and attaches area codes', () => {
    const ranked = rankBankMarkets([
      { NAME: 'JPMorgan Chase Bank', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85001' },
      { NAME: 'JPMorgan Chase Bank', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85002' },
      { NAME: 'JPMorgan Chase Bank', CITY: 'Tucson', STALP: 'AZ', ZIP: '85701' },
    ], { 'phoenix|az': ['602'], 'tucson|az': ['520'] });
    expect(ranked[0]).toMatchObject({ city: 'Phoenix', state: 'AZ', branchCount: 2, areaCodes: ['602'] });
  });

  it('derives leading area codes from branch telephone numbers', () => {
    const ranked = rankBankMarkets([
      { NAME: 'JPMorgan Chase Bank, National Association', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85001', TELEPHONE: '6025550100' },
      { NAME: 'JPMorgan Chase Bank, National Association', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85004', TELEPHONE: '(602) 555-0101' },
      { NAME: 'JPMorgan Chase Bank, National Association', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85008', TELEPHONE: '4805550102' },
    ], {});
    expect(ranked[0]).toMatchObject({ city: 'Phoenix', state: 'AZ', areaCodes: ['602', '480'], branchCount: 3 });
  });

  it('calls the official FDIC locations API with an encoded bank filter', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { data: { NAME: 'JPMorgan Chase Bank', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85001' } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const markets = await new FdicBankMarketsClient(fetcher).markets('JPMorgan Chase Bank');
    expect(String(fetcher.mock.calls[0][0])).toContain('api.fdic.gov/banks/locations');
    expect(String(fetcher.mock.calls[0][0])).toContain('filters=NAME%3A%22JPMorgan+Chase+Bank%22');
    expect(markets[0]).toMatchObject({ city: 'Phoenix', state: 'AZ', branchCount: 1 });
  });

  it('uses a stable FDIC certificate filter and requests branch telephones', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
      { data: { NAME: 'JPMorgan Chase Bank, National Association', CITY: 'Phoenix', STALP: 'AZ', ZIP: '85001', TELEPHONE: '6025550100' } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const markets = await new FdicBankMarketsClient(fetcher).markets('JPMorgan Chase Bank, National Association', 25, 628);
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain('filters=CERT%3A628');
    expect(url).toContain('TELEPHONE');
    expect(markets[0].areaCodes).toEqual(['602']);
  });
});
