import { TargetedCountry } from './types';

export interface GeographySelection {
  country: TargetedCountry;
  areaCodes: string[];
  states: string[];
  cities: string[];
  postalCodes: string[];
}

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

// Area codes most likely to occur in the initial high-density bank and business markets.
const AREA_CODE_STATE: Record<string, string> = {
  '202': 'DC', '212': 'NY', '213': 'CA', '214': 'TX', '215': 'PA', '216': 'OH', '305': 'FL',
  '312': 'IL', '313': 'MI', '404': 'GA', '407': 'FL', '408': 'CA', '410': 'MD', '415': 'CA',
  '416': 'ON', '469': 'TX', '480': 'AZ', '503': 'OR', '504': 'LA', '512': 'TX', '514': 'QC',
  '520': 'AZ', '602': 'AZ', '604': 'BC', '613': 'ON', '617': 'MA', '647': 'ON', '702': 'NV',
  '704': 'NC', '713': 'TX', '718': 'NY', '720': 'CO', '801': 'UT', '804': 'VA', '813': 'FL',
  '818': 'CA', '832': 'TX', '850': 'FL', '905': 'ON', '916': 'CA', '917': 'NY', '919': 'NC',
  '949': 'CA', '954': 'FL', '972': 'TX',
};

function clean(values: unknown): string[] {
  return Array.isArray(values)
    ? [...new Set(values.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

export function validateGeography(value: Partial<GeographySelection>): GeographySelection {
  const country = value.country ?? 'US';
  if (country !== 'US' && country !== 'CA') throw new Error('Targeted geography country must be US or CA.');
  const areaCodes = clean(value.areaCodes).map((code) => code.replace(/\D/g, ''));
  const states = clean(value.states).map((state) => state.toUpperCase());
  const cities = clean(value.cities);
  const postalCodes = clean(value.postalCodes).map((code) => code.toUpperCase());

  for (const areaCode of areaCodes) {
    if (!/^\d{3}$/.test(areaCode)) throw new Error(`Area code ${areaCode || '(blank)'} must contain exactly three digits.`);
    const expectedState = AREA_CODE_STATE[areaCode];
    if (expectedState && states.length && !states.includes(expectedState)) {
      throw new Error(`Area code ${areaCode} belongs to ${STATE_NAMES[expectedState] ?? expectedState}, not ${states.join(', ')}.`);
    }
  }
  const regionType = country === 'US' ? /^[A-Z]{2}$/ : /^[A-Z]{2}$/;
  if (states.some((state) => !regionType.test(state))) throw new Error('States and provinces must use two-letter abbreviations.');

  return { country, areaCodes, states, cities, postalCodes };
}

export function stateForAreaCode(areaCode: string): string | undefined {
  return AREA_CODE_STATE[areaCode];
}
