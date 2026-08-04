import mammoth from 'mammoth';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { FetchedArtifact } from './artifactFetcher';

export interface ExtractedSection {
  text: string;
  mediaType: string;
  page?: number;
  sheet?: string;
  row?: number;
}

export class DocumentExtractionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

const MAX_SECTIONS = 20_000;
const MAX_SECTION_CHARS = 50_000;

function bounded(text: string): string {
  return text.replace(/\u0000/g, '').trim().slice(0, MAX_SECTION_CHARS);
}

function htmlText(html: string): string {
  return bounded(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#64;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' '));
}

function isZip(body: Buffer): boolean {
  return body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b && (body[2] === 0x03 || body[2] === 0x05 || body[2] === 0x07);
}

function isOle(body: Buffer): boolean {
  return body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

function typeOf(artifact: FetchedArtifact): 'html' | 'txt' | 'csv' | 'xls' | 'xlsx' | 'docx' | 'pdf' {
  const contentType = artifact.contentType.toLowerCase();
  const path = (() => { try { return new URL(artifact.finalUrl).pathname.toLowerCase(); } catch { return ''; } })();
  if (contentType === 'text/html' || path.endsWith('.html') || path.endsWith('.htm')) return 'html';
  if (contentType === 'application/pdf' || path.endsWith('.pdf')) return 'pdf';
  if (contentType.includes('wordprocessingml') || path.endsWith('.docx')) return 'docx';
  if (contentType.includes('spreadsheetml') || path.endsWith('.xlsx')) return 'xlsx';
  if (contentType === 'application/vnd.ms-excel' || path.endsWith('.xls')) return 'xls';
  if (contentType === 'text/csv' || contentType === 'text/tab-separated-values' || path.endsWith('.csv') || path.endsWith('.tsv')) return 'csv';
  if (contentType === 'text/plain' || path.endsWith('.txt')) return 'txt';
  throw new DocumentExtractionError('unsupported_document', `Unsupported artifact type ${contentType || '(missing)'}.`);
}

function spreadsheetSections(artifact: FetchedArtifact, type: 'xls' | 'xlsx'): ExtractedSection[] {
  if ((type === 'xls' && !isOle(artifact.body)) || (type === 'xlsx' && !isZip(artifact.body))) {
    throw new DocumentExtractionError('corrupt_document', `${type.toUpperCase()} signature is invalid.`);
  }
  try {
    const workbook = XLSX.read(artifact.body, { type: 'buffer', cellFormula: false, cellHTML: false, cellNF: false, dense: true });
    const sections: ExtractedSection[] = [];
    for (const sheet of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(workbook.Sheets[sheet], {
        header: 1, raw: false, blankrows: false, defval: '',
      });
      const headers = (rows[0] ?? []).map((cell) => String(cell ?? '').trim());
      rows.slice(0, MAX_SECTIONS - sections.length).forEach((row, index) => {
        const text = bounded(index === 0
          ? row.map((cell) => String(cell ?? '')).join(' | ')
          : row.map((cell, cellIndex) => headers[cellIndex]
            ? `${headers[cellIndex]}: ${String(cell ?? '')}` : String(cell ?? '')).join(' | '));
        if (text) sections.push({ text, mediaType: artifact.contentType, sheet, row: index + 1 });
      });
      if (sections.length >= MAX_SECTIONS) break;
    }
    if (!sections.length) throw new DocumentExtractionError('corrupt_document', 'Spreadsheet contained no readable rows.');
    return sections;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError('corrupt_document', `Spreadsheet parsing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function pdfSections(artifact: FetchedArtifact): Promise<ExtractedSection[]> {
  if (!artifact.body.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new DocumentExtractionError('corrupt_document', 'PDF signature is invalid.');
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({
      data: new Uint8Array(artifact.body), useSystemFonts: true, useWorkerFetch: false,
      useWasm: false, stopAtErrors: true, maxImageSize: 25_000_000,
    }).promise;
    const sections: ExtractedSection[] = [];
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, MAX_SECTIONS); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = bounded(content.items.map((item) => 'str' in item ? item.str : '').join(' '));
      if (text) sections.push({ text, mediaType: artifact.contentType, page: pageNumber });
    }
    if (!sections.length) throw new DocumentExtractionError('ocr_required', 'PDF contains no extractable text and requires OCR.');
    return sections;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError('corrupt_document', `PDF parsing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export async function extractDocumentSections(artifact: FetchedArtifact): Promise<ExtractedSection[]> {
  const type = typeOf(artifact);
  if (type === 'html') return [{ text: htmlText(artifact.body.toString('utf8')), mediaType: artifact.contentType }].filter((section) => Boolean(section.text));
  if (type === 'txt') return [{ text: bounded(artifact.body.toString('utf8')), mediaType: artifact.contentType }].filter((section) => Boolean(section.text));
  if (type === 'csv') {
    try {
      const delimiter = artifact.finalUrl.toLowerCase().endsWith('.tsv') || artifact.contentType === 'text/tab-separated-values' ? '\t' : ',';
      const rows = parseCsv(artifact.body, { delimiter, bom: true, relax_column_count: true, skip_empty_lines: true, to: MAX_SECTIONS }) as Array<Array<unknown>>;
      const headers = (rows[0] ?? []).map((cell) => String(cell ?? '').trim());
      return rows.map((row, index) => ({
        text: bounded(index === 0
          ? row.map((cell) => String(cell ?? '')).join(' | ')
          : row.map((cell, cellIndex) => headers[cellIndex]
            ? `${headers[cellIndex]}: ${String(cell ?? '')}` : String(cell ?? '')).join(' | ')),
        mediaType: artifact.contentType, row: index + 1,
      })).filter((section) => Boolean(section.text));
    } catch (error) {
      throw new DocumentExtractionError('corrupt_document', `Delimited-text parsing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  if (type === 'xls' || type === 'xlsx') return spreadsheetSections(artifact, type);
  if (type === 'docx') {
    if (!isZip(artifact.body)) throw new DocumentExtractionError('corrupt_document', 'DOCX signature is invalid.');
    try {
      const result = await mammoth.extractRawText({ buffer: artifact.body });
      const sections = result.value.split(/\n+/).map((text, index) => ({
        text: bounded(text), mediaType: artifact.contentType, row: index + 1,
      })).filter((section) => Boolean(section.text)).slice(0, MAX_SECTIONS);
      if (!sections.length) throw new DocumentExtractionError('corrupt_document', 'DOCX contained no readable text.');
      return sections;
    } catch (error) {
      if (error instanceof DocumentExtractionError) throw error;
      throw new DocumentExtractionError('corrupt_document', `DOCX parsing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return pdfSections(artifact);
}
