export type ShuffleSource = 'google_maps' | 'sales_navigator';

export interface ShuffleCombo {
  id: string;
  label: string;
  city: string;
  rationale: string;
  googleMaps: { searchTerm: string; category: string; companyType: string };
  salesNavigator: { title: string; industry: string; headcount: string };
}

export interface ComboStat {
  runs: number;
  leads: number;
}

export interface ShuffleRequest {
  source: ShuffleSource;
  recentComboIds?: string[];
  recentCities?: string[];
  currentComboId?: string;
}

export interface ShufflePick {
  combo: ShuffleCombo;
  filters: Record<string, string[]>;
  freshTerritory: boolean;
  combosTried: number;
  combosTotal: number;
  updatedHistory: { comboIds: string[]; cities: string[]; currentComboId: string };
  note: string;
}

function combo(
  id: string,
  label: string,
  city: string,
  searchTerm: string,
  category: string,
  companyType: string,
  title: string,
  industry: string,
  headcount: string,
  rationale: string,
): ShuffleCombo {
  return {
    id,
    label,
    city,
    rationale,
    googleMaps: { searchTerm, category, companyType },
    salesNavigator: { title, industry, headcount },
  };
}

export const SHUFFLE_COMBOS: ShuffleCombo[] = [
  combo('owner-roofing-houston', 'Roofing owners — Houston', 'Houston, TX', 'Owner', 'Roofing', 'Contractors', 'Owner', 'Construction', '1-10', 'Owner-led roofers are reachable decision-makers in a strong local-trade market.'),
  combo('owner-hvac-phoenix', 'HVAC owners — Phoenix', 'Phoenix, AZ', 'Owner', 'HVAC', 'Services', 'Owner', 'Facilities Services', '1-10', 'Phoenix heat keeps HVAC demand high and owner-led firms buy quickly.'),
  combo('ceo-construction-dallas', 'Construction CEOs — Dallas', 'Dallas, TX', 'CEO', 'Construction', 'Group', 'CEO', 'Construction', '11-50', 'Dallas construction growth creates active budgets and accessible executives.'),
  combo('owner-dental-tampa', 'Dental practice owners — Tampa', 'Tampa, FL', 'Owner', 'Dental Clinics', 'Professionals', 'Owner', 'Medical Practices', '1-10', 'Independent practice owners control purchasing without a long approval chain.'),
  combo('manager-vet-denver', 'Vet practice managers — Denver', 'Denver, CO', 'Practice Manager', 'Veterinary Services', 'LLC', 'Practice Manager', 'Medical Practices', '11-50', 'Practice managers control the operational side of growing veterinary clinics.'),
  combo('owner-trucking-atlanta', 'Trucking owners — Atlanta', 'Atlanta, GA', 'Owner', 'Trucking', 'LLC', 'Owner', 'Truck Transportation', '1-10', 'Atlanta is a freight hub with many small fleets led directly by owners.'),
  combo('gm-autorepair-nashville', 'Auto-repair GMs — Nashville', 'Nashville, TN', 'General Manager', 'Auto Repair', 'Services', 'General Manager', 'Automotive', '1-10', 'General managers run daily shop operations and approve practical services.'),
  combo('owner-landscaping-charlotte', 'Landscaping owners — Charlotte', 'Charlotte, NC', 'Owner', 'Landscaping & Lawn Care', 'Services', 'Owner', 'Facilities Services', '1-10', 'Recurring-revenue landscaping firms provide direct access to owners.'),
  combo('ceo-manufacturing-columbus', 'Manufacturing CEOs — Columbus', 'Columbus, OH', 'CEO', 'Manufacturing', 'Inc', 'CEO', 'Manufacturing', '51-200', 'Mid-market manufacturers combine real budgets with identifiable executives.'),
  combo('owner-realestate-sacramento', 'Real-estate owners — Sacramento', 'Sacramento, CA', 'Owner', 'Real Estate Agencies', 'Group', 'Owner', 'Real Estate', '11-50', 'Broker-owners purchase tools and marketing for their entire agency.'),
  combo('sales-oilgas-houston', 'Oil and gas sales leaders — Houston', 'Houston, TX', 'Sales', 'Oil & Gas', 'Corp', 'Sales Director', 'Oil and Gas', '51-200', 'Houston energy firms concentrate revenue leaders and vendor activity.'),
  combo('purchasing-manufacturing-columbus', 'Manufacturing purchasing — Columbus', 'Columbus, OH', 'Purchasing', 'Manufacturing', 'Inc', 'Purchasing Manager', 'Manufacturing', '51-200', 'Purchasing leaders are explicitly responsible for evaluating vendors.'),
  combo('owner-restaurants-austin', 'Restaurant owners — Austin', 'Austin, TX', 'Owner', 'Restaurants & Food Service', 'LLC', 'Owner', 'Hospitality', '1-10', 'Austin has a dense independent restaurant market with direct owner access.'),
  combo('office-legal-raleigh', 'Law-firm office managers — Raleigh', 'Raleigh, NC', 'Office Manager', 'Legal Services', 'Firm', 'Office Manager', 'Legal Services', '11-50', 'Office managers coordinate the service contracts used by growing firms.'),
  combo('owner-plumbing-jacksonville', 'Plumbing owners — Jacksonville', 'Jacksonville, FL', 'Owner', 'Plumbing', 'Contractors', 'Owner', 'Construction', '1-10', 'Emergency-trade owners are accessible and make purchasing decisions quickly.'),
  combo('ceo-renewable-denver', 'Renewable-energy CEOs — Denver', 'Denver, CO', 'CEO', 'Renewable Energy', 'Corp', 'CEO', 'Renewable Energy Power Generation', '11-50', 'Fast-growing renewable firms are actively building vendor relationships.'),
  combo('ops-warehousing-slc', 'Warehouse operations — Salt Lake City', 'Salt Lake City, UT', 'Operations', 'Warehousing & Distribution', 'LLC', 'Operations Director', 'Warehousing and Storage', '51-200', 'Utah logistics growth creates active operational needs and budgets.'),
  combo('owner-accounting-okc', 'Accounting-firm owners — Oklahoma City', 'Oklahoma City, OK', 'Owner', 'Accounting Firms', 'Firm', 'Owner', 'Accounting', '1-10', 'Owner-led accounting firms respond well to measurable efficiency offers.'),
  combo('marketing-medspa-tampa', 'Med-spa marketing leads — Tampa', 'Tampa, FL', 'Marketing', 'Medical Spas & Aesthetics', 'LLC', 'Marketing Director', 'Medical Practices', '11-50', 'High-margin aesthetics businesses maintain active customer-acquisition budgets.'),
  combo('owner-electrical-dallas', 'Electrical contractors — Dallas', 'Dallas, TX', 'Owner', 'Electrical Contractors', 'Contractors', 'Owner', 'Construction', '1-10', 'Dallas growth keeps licensed electrical owners busy and commercially active.'),
  combo('hr-staffing-chicago', 'Staffing HR leads — Chicago', 'Chicago, IL', 'Human Resources', 'Staffing & Recruiting', 'Agency', 'HR Director', 'Staffing and Recruiting', '11-50', 'Staffing leaders work in communication-heavy roles and are highly reachable.'),
  combo('ceo-solar-phoenix', 'Solar CEOs — Phoenix', 'Phoenix, AZ', 'CEO', 'Solar Energy', 'Corp', 'CEO', 'Renewable Energy Power Generation', '11-50', 'Phoenix solar firms pair a strong market with growth-focused executives.'),
  combo('owner-insurance-nashville', 'Insurance agency owners — Nashville', 'Nashville, TN', 'Owner', 'Insurance Agencies', 'Agency', 'Owner', 'Insurance', '1-10', 'Agency owners personally purchase leads, software, and growth services.'),
  combo('finance-healthcare-atlanta', 'Healthcare finance leads — Atlanta', 'Atlanta, GA', 'Finance', 'Healthcare', 'Group', 'Finance Director', 'Hospitals and Health Care', '51-200', 'Finance leaders hold purchasing authority across expanding healthcare groups.'),
];

const comboById = new Map(SHUFFLE_COMBOS.map((entry) => [entry.id, entry]));
const validCities = new Set(SHUFFLE_COMBOS.map((entry) => entry.city));

function uniqueValid(values: string[] | undefined, valid: Set<string>): string[] {
  return [...new Set((values ?? []).filter((value) => valid.has(value)))];
}

function weightedPick(candidates: ShuffleCombo[], stats: Record<string, ComboStat>, random: () => number): ShuffleCombo {
  const weights = candidates.map((entry) => {
    const stat = stats[entry.id];
    return 1 + (stat ? stat.leads / Math.max(1, stat.runs) : 0);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = Math.min(0.999999999, Math.max(0, random())) * total;
  for (let index = 0; index < candidates.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
}

export function pickNextCombo(
  request: ShuffleRequest,
  stats: Record<string, ComboStat>,
  random: () => number = Math.random,
): ShufflePick {
  const validIds = new Set(comboById.keys());
  let comboIds = uniqueValid(request.recentComboIds, validIds);
  let cities = uniqueValid(request.recentCities, validCities);
  const current = request.currentComboId ? comboById.get(request.currentComboId) : undefined;
  let comboReset = false;
  let cityReset = false;

  let candidates = SHUFFLE_COMBOS.filter((entry) => !comboIds.includes(entry.id));
  if (!candidates.length) {
    comboIds = [];
    cities = [];
    comboReset = true;
    cityReset = true;
    candidates = [...SHUFFLE_COMBOS];
  }

  let cityCandidates = candidates.filter((entry) => !cities.includes(entry.city));
  if (!cityCandidates.length) {
    cities = [];
    cityReset = true;
    cityCandidates = candidates;
  }

  const withoutImmediateRepeat = cityCandidates.filter(
    (entry) => entry.id !== current?.id && entry.city !== current?.city,
  );
  if (withoutImmediateRepeat.length) cityCandidates = withoutImmediateRepeat;

  const allCombosHaveRuns = SHUFFLE_COMBOS.every((entry) => (stats[entry.id]?.runs ?? 0) > 0);
  const selected = allCombosHaveRuns
    ? weightedPick(cityCandidates, stats, random)
    : cityCandidates[Math.min(cityCandidates.length - 1, Math.floor(Math.max(0, random()) * cityCandidates.length))];

  const freshTerritory = (stats[selected.id]?.runs ?? 0) === 0;
  const filters: Record<string, string[]> = request.source === 'sales_navigator'
    ? {
        titles: [selected.salesNavigator.title],
        industries: [selected.salesNavigator.industry],
        geographies: [selected.city],
        headcounts: [selected.salesNavigator.headcount],
      }
    : {
        searchTerms: [selected.googleMaps.searchTerm],
        categoryFilters: [selected.googleMaps.category],
        companyTypes: [selected.googleMaps.companyType],
        locations: [selected.city],
      };

  const updatedComboIds = [...new Set([...(comboReset ? [] : comboIds), selected.id])];
  const updatedCities = [...new Set([...(cityReset ? [] : cities), selected.city])];
  const combosTried = SHUFFLE_COMBOS.filter((entry) => (stats[entry.id]?.runs ?? 0) > 0).length;

  return {
    combo: selected,
    filters,
    freshTerritory,
    combosTried,
    combosTotal: SHUFFLE_COMBOS.length,
    updatedHistory: { comboIds: updatedComboIds, cities: updatedCities, currentComboId: selected.id },
    note: allCombosHaveRuns
      ? `Learned shuffle — ${selected.label} was selected by performance-weighted rotation.`
      : `Fresh shuffle — ${updatedComboIds.length} of ${SHUFFLE_COMBOS.length} combinations dealt in this cycle.`,
  };
}
