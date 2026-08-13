#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function extractEmails(text) {
  const normalized = String(text)
    .replace(/\s*(?:\[at\]|\(at\)|\bat\b)\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\bdot\b)\s*/gi, '.');
  return [...new Set((normalized.match(EMAIL_PATTERN) || [])
    .map((email) => email.toLowerCase().replace(/[),.;:]+$/, '')))]
    .filter((email) => isValidEmail(email) && !email.includes('example.'))
    .sort();
}

function isValidEmail(email) {
  const match = /^([^@]+)@([^.@]+(?:\.[^.@]+)+)$/.exec(email);
  if (!match || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) return false;
  return match[2].split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

async function readDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: await fs.readFile(filePath) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.xls' || ext === '.xlsx') {
    const workbook = XLSX.read(await fs.readFile(filePath), { type: 'buffer', cellDates: false });
    return workbook.SheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join('\n');
  }
  throw new Error(`Unsupported document type: ${ext}`);
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Usage: node scripts/extract-document-emails.cjs <file>...');
  const outputDir = path.resolve('outputs/document-email-extraction');
  await fs.mkdir(outputDir, { recursive: true });
  const bySource = {};
  const all = new Set();
  for (const file of files) {
    const emails = extractEmails(await readDocument(file));
    bySource[path.basename(file)] = emails.length;
    emails.forEach((email) => all.add(email));
  }
  const sorted = [...all].sort();
  await fs.writeFile(path.join(outputDir, 'emails.txt'), sorted.join('\n') + (sorted.length ? '\n' : ''));
  await fs.writeFile(path.join(outputDir, 'emails.csv'), ['email', ...sorted].join('\n') + '\n');
  await fs.writeFile(path.join(outputDir, 'extraction-summary.json'), JSON.stringify({
    mode: 'email-only',
    files: bySource,
    totalUniqueEmails: sorted.length,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ totalUniqueEmails: sorted.length, bySource }, null, 2));
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
