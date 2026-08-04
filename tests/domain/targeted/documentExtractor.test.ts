import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { extractDocumentSections } from '../../../src/domain/targeted/documentExtractor';

function artifact(body: Buffer, contentType: string, url: string) {
  return { body, contentType, finalUrl: url, byteCount: body.length };
}

function spreadsheet(bookType: 'xls' | 'xlsx'): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Company', 'Email'], ['Phoenix Aviation', 'owner@gmail.com'], ['Acme Freight', 'ops@acme.example'],
  ]), 'Contacts');
  return XLSX.write(workbook, { type: 'buffer', bookType });
}

async function docx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')!.file('.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')!.file('document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Contact director@acme.example</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function pdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

describe('extractDocumentSections', () => {
  it('extracts HTML, TXT, and CSV with row provenance', async () => {
    const html = await extractDocumentSections(artifact(Buffer.from('<script>bad@example.com</script><p>Email sales@acme.example</p>'), 'text/html', 'https://acme.example/contact'));
    expect(html.map((section) => section.text).join(' ')).toContain('sales@acme.example');
    expect(html.map((section) => section.text).join(' ')).not.toContain('bad@example.com');

    const txt = await extractDocumentSections(artifact(Buffer.from('Contact support@acme.example'), 'text/plain', 'https://acme.example/contact.txt'));
    expect(txt[0].text).toContain('support@acme.example');

    const csv = await extractDocumentSections(artifact(Buffer.from('Company,Email\nAcme,ops@acme.example\n'), 'text/csv', 'https://acme.example/contact.csv'));
    expect(csv[1]).toMatchObject({ row: 2 });
    expect(csv[1].text).toContain('ops@acme.example');
  });

  it.each(['xls', 'xlsx'] as const)('extracts %s workbook rows with sheet provenance', async (type) => {
    const contentType = type === 'xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const sections = await extractDocumentSections(artifact(spreadsheet(type), contentType, `https://acme.example/contacts.${type}`));
    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ sheet: 'Contacts', row: 2, text: expect.stringContaining('owner@gmail.com') }),
    ]));
  });

  it('extracts DOCX paragraphs', async () => {
    const sections = await extractDocumentSections(artifact(await docx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'https://acme.example/contacts.docx'));
    expect(sections.map((section) => section.text).join(' ')).toContain('director@acme.example');
  });

  it('extracts PDF pages', async () => {
    const sections = await extractDocumentSections(artifact(pdf('Contact pdf@acme.example'), 'application/pdf', 'https://acme.example/contacts.pdf'));
    expect(sections).toEqual([expect.objectContaining({ page: 1, text: expect.stringContaining('pdf@acme.example') })]);
  });

  it('quarantines corrupt and unsupported documents with explicit codes', async () => {
    await expect(extractDocumentSections(artifact(Buffer.from('not a workbook'), 'application/vnd.ms-excel', 'https://acme.example/bad.xls')))
      .rejects.toMatchObject({ code: 'corrupt_document' });
    await expect(extractDocumentSections(artifact(Buffer.from([0, 1, 2]), 'application/octet-stream', 'https://acme.example/file.bin')))
      .rejects.toMatchObject({ code: 'unsupported_document' });
  });
});
