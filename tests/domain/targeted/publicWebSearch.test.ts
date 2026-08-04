import { describe, expect, it, vi } from 'vitest';
import { discoverPublicDocumentLinks, PublicWebSearchClient } from '../../../src/domain/targeted/publicWebSearch';

describe('PublicWebSearchClient', () => {
  it('returns unique public result URLs from the bounded HTML search endpoint', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.example%2Fcontacts.pdf">PDF</a>
      <a class="result__a" href="https://other.example/leads.xlsx">XLSX</a>
      <a class="result__a" href="https://other.example/leads.xlsx">duplicate</a>`;
    const fetcher = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const urls = await new PublicWebSearchClient(fetcher).search('phone 602 Phoenix AZ filetype:pdf', 20);
    expect(urls).toEqual(['https://acme.example/contacts.pdf', 'https://other.example/leads.xlsx']);
    expect(String(fetcher.mock.calls[0][0])).toContain('html.duckduckgo.com/html');
  });

  it('rejects oversized or non-HTML search responses', async () => {
    const fetcher = vi.fn(async () => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json', 'content-length': '2' },
    }));
    await expect(new PublicWebSearchClient(fetcher).search('contacts', 10)).rejects.toThrow(/HTML/i);
  });

  it('discovers public document links from a targeted business website', () => {
    const links = discoverPublicDocumentLinks(`
      <a href="/downloads/contacts.pdf">Directory</a>
      <a href="https://cdn.acme.example/leads.xlsx#sheet">Workbook</a>
      <a href="/about">HTML page</a>
    `, 'https://acme.example/contact');
    expect(links).toEqual([
      'https://acme.example/downloads/contacts.pdf',
      'https://cdn.acme.example/leads.xlsx',
    ]);
  });
});
