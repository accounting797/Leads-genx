import { TargetedCountry } from './types';

export interface TargetedBankCatalogEntry {
  id: string;
  label: string;
  country: TargetedCountry;
  fdicName?: string;
  fdicCertificate?: number;
}

const BANKS: TargetedBankCatalogEntry[] = [
  { id: 'chase', label: 'Chase', country: 'US', fdicName: 'JPMorgan Chase Bank, National Association', fdicCertificate: 628 },
  { id: 'wells_fargo', label: 'Wells Fargo', country: 'US', fdicName: 'Wells Fargo Bank, National Association', fdicCertificate: 3511 },
  { id: 'bank_of_america', label: 'Bank of America', country: 'US', fdicName: 'Bank of America, National Association', fdicCertificate: 3510 },
  { id: 'pnc', label: 'PNC Bank', country: 'US', fdicName: 'PNC Bank, National Association', fdicCertificate: 6384 },
  { id: 'us_bank', label: 'U.S. Bank', country: 'US', fdicName: 'U.S. Bank National Association', fdicCertificate: 6548 },
  { id: 'truist', label: 'Truist', country: 'US', fdicName: 'Truist Bank', fdicCertificate: 9846 },
  { id: 'citizens', label: 'Citizens Bank', country: 'US', fdicName: 'Citizens Bank, National Association', fdicCertificate: 57957 },
  { id: 'td', label: 'TD Bank', country: 'US', fdicName: 'TD Bank, National Association', fdicCertificate: 18409 },
  { id: 'capital_one', label: 'Capital One', country: 'US', fdicName: 'Capital One, National Association', fdicCertificate: 4297 },
  { id: 'fifth_third', label: 'Fifth Third Bank', country: 'US', fdicName: 'Fifth Third Bank, National Association', fdicCertificate: 6672 },
  { id: 'regions', label: 'Regions Bank', country: 'US', fdicName: 'Regions Bank', fdicCertificate: 12368 },
  { id: 'keybank', label: 'KeyBank', country: 'US', fdicName: 'KeyBank National Association', fdicCertificate: 17534 },
  { id: 'huntington', label: 'Huntington Bank', country: 'US', fdicName: 'The Huntington National Bank', fdicCertificate: 6560 },
  { id: 'bmo', label: 'BMO Bank', country: 'US', fdicName: 'BMO Bank National Association', fdicCertificate: 16571 },
  { id: 'rbc_canada', label: 'RBC Royal Bank', country: 'CA' },
  { id: 'td_canada', label: 'TD Canada Trust', country: 'CA' },
  { id: 'scotiabank', label: 'Scotiabank', country: 'CA' },
  { id: 'bmo_canada', label: 'BMO Canada', country: 'CA' },
  { id: 'cibc', label: 'CIBC', country: 'CA' },
  { id: 'national_bank_canada', label: 'National Bank of Canada', country: 'CA' },
  { id: 'desjardins', label: 'Desjardins', country: 'CA' },
];

export function targetedBankCatalog(): TargetedBankCatalogEntry[] {
  return BANKS.map((bank) => ({ ...bank }));
}

export function targetedBankById(id: string): TargetedBankCatalogEntry | undefined {
  const bank = BANKS.find((entry) => entry.id === id);
  return bank ? { ...bank } : undefined;
}
