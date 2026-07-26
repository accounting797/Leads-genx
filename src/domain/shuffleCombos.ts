/**
 * Nova's Shuffle — precision filter combos, one option per filter.
 *
 * Research-backed pairing logic (cold-outreach 2026 playbooks): the highest
 * reply odds come from tight ICP slices — ONE role, ONE industry, ONE metro
 * per run — where the role actually answers their own email (owner-led SMBs)
 * or holds budget (C-level at mid-size). Fast-growth SMBs (11–200) with
 * founder/C-level titles convert best; trades and local services are the
 * most owner-reachable industries in the US.
 *
 * The library rotates so consecutive runs explore fresh slices, and once
 * every combo has been tried, Nova re-ranks by which combos actually
 * produced leads for THIS user — learning from outcomes, not vibes.
 */

export interface ShuffleCombo {
  id: string;
  label: string;
  /** One Google-lane role/keyword (from suggestions.googleMaps.searchTemplates). */
  searchTerm: string;
  /** One industry (from suggestions.businessCategories). */
  category: string;
  /** One company-name suffix keyword (from suggestions.googleMaps.companyTypes). */
  companyType: string;
  /** One metro. */
  location: string;
  /** One Sales Navigator headcount bucket (for LinkedIn-source runs). */
  headcount: string;
  /** Why this pairing wins — shown to the user in plain words. */
  rationale: string;
}

export const SHUFFLE_COMBOS: ShuffleCombo[] = [
  { id: 'owner-roofing-houston', label: 'Roofing owners — Houston', searchTerm: 'Owner', category: 'Roofing', companyType: 'Contractors', location: 'Houston, TX', headcount: '1-10', rationale: 'Owner-led roofers answer their own phone and email — the highest reply odds in local trades.' },
  { id: 'owner-hvac-phoenix', label: 'HVAC owners — Phoenix', searchTerm: 'Owner', category: 'HVAC', companyType: 'Services', location: 'Phoenix, AZ', headcount: '1-10', rationale: 'Phoenix heat keeps HVAC booked out; owners buy anything that saves them time.' },
  { id: 'ceo-construction-dallas', label: 'Construction CEOs — Dallas', searchTerm: 'CEO', category: 'Construction', companyType: 'Group', location: 'Dallas, TX', headcount: '11-50', rationale: 'Dallas is the fastest-building metro in the US — growth budgets are open.' },
  { id: 'owner-dental-tampa', label: 'Dental practice owners — Tampa', searchTerm: 'Owner', category: 'Dental Clinics', companyType: 'Professionals', location: 'Tampa, FL', headcount: '1-10', rationale: 'Practice owners make every purchase decision themselves — no gatekeepers.' },
  { id: 'manager-vet-denver', label: 'Vet practice managers — Denver', searchTerm: 'Practice Manager', category: 'Veterinary Services', companyType: 'LLC', location: 'Denver, CO', headcount: '11-50', rationale: 'The practice manager runs the business side of every vet clinic — one title, full access.' },
  { id: 'owner-trucking-atlanta', label: 'Trucking owners — Atlanta', searchTerm: 'Owner', category: 'Trucking', companyType: 'LLC', location: 'Atlanta, GA', headcount: '1-10', rationale: 'Atlanta is the Southeast freight hub; small fleet owners decide fast.' },
  { id: 'gm-autorepair-nashville', label: 'Auto-repair GMs — Nashville', searchTerm: 'General Manager', category: 'Auto Repair', companyType: 'Services', location: 'Nashville, TN', headcount: '1-10', rationale: 'GMs run the shop day-to-day and sign for tools and services.' },
  { id: 'owner-landscaping-charlotte', label: 'Landscaping owners — Charlotte', searchTerm: 'Owner', category: 'Landscaping & Lawn Care', companyType: 'Services', location: 'Charlotte, NC', headcount: '1-10', rationale: 'Recurring-revenue trade with owner-operators who answer email personally.' },
  { id: 'ceo-manufacturing-columbus', label: 'Manufacturing CEOs — Columbus', searchTerm: 'CEO', category: 'Manufacturing', companyType: 'Inc', location: 'Columbus, OH', headcount: '51-200', rationale: 'Mid-size manufacturers have budget and a single decision-maker at the top.' },
  { id: 'owner-realestate-sacramento', label: 'Real-estate agency owners — Sacramento', searchTerm: 'Owner', category: 'Real Estate Agencies', companyType: 'Group', location: 'Sacramento, CA', headcount: '11-50', rationale: 'Broker-owners buy marketing and software for the whole agency in one yes.' },
  { id: 'sales-oilgas-houston', label: 'Oil & gas sales leaders — Houston', searchTerm: 'Sales', category: 'Oil & Gas', companyType: 'Corp', location: 'Houston, TX', headcount: '51-200', rationale: 'The energy capital — sales leaders here control vendor spend directly.' },
  { id: 'purchasing-manufacturing-columbus', label: 'Manufacturing purchasing — Columbus', searchTerm: 'Purchasing', category: 'Manufacturing', companyType: 'Inc', location: 'Columbus, OH', headcount: '51-200', rationale: 'Purchasing is literally paid to talk to vendors — warmest cold audience there is.' },
  { id: 'owner-restaurants-austin', label: 'Restaurant owners — Austin', searchTerm: 'Owner', category: 'Restaurants & Food Service', companyType: 'LLC', location: 'Austin, TX', headcount: '1-10', rationale: 'Austin’s food scene keeps expanding; independent owners decide on the spot.' },
  { id: 'office-legal-raleigh', label: 'Law-firm office managers — Raleigh', searchTerm: 'Office Manager', category: 'Legal Services', companyType: 'Firm', location: 'Raleigh, NC', headcount: '11-50', rationale: 'Office managers control every service contract a law firm signs.' },
  { id: 'owner-plumbing-jacksonville', label: 'Plumbing owners — Jacksonville', searchTerm: 'Owner', category: 'Plumbing', companyType: 'Contractors', location: 'Jacksonville, FL', headcount: '1-10', rationale: 'Emergency-trade owners live on their phones — fast replies, fast deals.' },
  { id: 'ceo-renewable-denver', label: 'Renewable-energy CEOs — Denver', searchTerm: 'CEO', category: 'Renewable Energy', companyType: 'Corp', location: 'Denver, CO', headcount: '11-50', rationale: 'Funded, fast-growing sector with CEOs actively building their vendor stack.' },
  { id: 'ops-warehousing-slc', label: 'Warehouse operations — Salt Lake City', searchTerm: 'Operations', category: 'Warehousing & Distribution', companyType: 'LLC', location: 'Salt Lake City, UT', headcount: '51-200', rationale: 'Utah’s logistics boom means ops leaders with open budgets and hiring plans.' },
  { id: 'owner-accounting-okc', label: 'Accounting-firm owners — Oklahoma City', searchTerm: 'Owner', category: 'Accounting Firms', companyType: 'Firm', location: 'Oklahoma City, OK', headcount: '1-10', rationale: 'Owner-CPAs buy efficiency tools the moment the math makes sense.' },
  { id: 'marketing-medspa-tampa', label: 'Med-spa marketing leads — Tampa', searchTerm: 'Marketing', category: 'Medical Spas & Aesthetics', companyType: 'LLC', location: 'Tampa, FL', headcount: '11-50', rationale: 'High-margin aesthetics businesses outspend everyone on growth.' },
  { id: 'owner-electrical-dallas', label: 'Electrical contractors — Dallas', searchTerm: 'Owner', category: 'Electrical Contractors', companyType: 'Contractors', location: 'Dallas, TX', headcount: '1-10', rationale: 'Construction boom + licensed trade = owners too busy to ignore good offers.' },
  { id: 'hr-staffing-chicago', label: 'Staffing HR leads — Chicago', searchTerm: 'Human Resources', category: 'Staffing & Recruiting', companyType: 'Agency', location: 'Chicago, IL', headcount: '11-50', rationale: 'Recruiters live in their inbox — the most email-responsive role in B2B.' },
  { id: 'ceo-solar-phoenix', label: 'Solar CEOs — Phoenix', searchTerm: 'CEO', category: 'Solar Energy', companyType: 'Corp', location: 'Phoenix, AZ', headcount: '11-50', rationale: 'The sunniest market in America, led by founders spending growth capital.' },
  { id: 'owner-insurance-nashville', label: 'Insurance agency owners — Nashville', searchTerm: 'Owner', category: 'Insurance Agencies', companyType: 'Agency', location: 'Nashville, TN', headcount: '1-10', rationale: 'Agency owners personally buy leads and software — and reply in kind.' },
  { id: 'finance-healthcare-atlanta', label: 'Healthcare finance leads — Atlanta', searchTerm: 'Finance', category: 'Healthcare', companyType: 'Group', location: 'Atlanta, GA', headcount: '51-200', rationale: 'Finance holds the budget keys in every healthcare group — one title, real money.' },
];

export interface ComboStat {
  runs: number;
  leads: number;
}

export interface ShufflePick {
  combo: ShuffleCombo;
  /** True when this combo has never been tried by the user — fresh territory. */
  freshTerritory: boolean;
  combosTried: number;
  combosTotal: number;
  /** Nova's one-liner explaining the pick. */
  note: string;
}

/**
 * Picks the next combo: unseen slices first (stable library order), then —
 * once everything has been tried — the combo with the best leads-per-run
 * for THIS user. Learning from outcomes, not vibes.
 */
export function pickNextCombo(stats: Record<string, ComboStat>): ShufflePick {
  const tried = Object.keys(stats).filter((id) => stats[id].runs > 0);
  const unseen = SHUFFLE_COMBOS.filter((combo) => !(combo.id in stats) || stats[combo.id].runs === 0);

  if (unseen.length > 0) {
    const combo = unseen[0];
    return {
      combo,
      freshTerritory: true,
      combosTried: tried.length,
      combosTotal: SHUFFLE_COMBOS.length,
      note: `Fresh territory — slice ${tried.length + 1} of ${SHUFFLE_COMBOS.length}. One term, one category, one location: precision mode.`,
    };
  }

  let best = SHUFFLE_COMBOS[0];
  let bestYield = -1;
  for (const combo of SHUFFLE_COMBOS) {
    const stat = stats[combo.id];
    const yieldPerRun = stat ? stat.leads / Math.max(1, stat.runs) : 0;
    if (yieldPerRun > bestYield) {
      bestYield = yieldPerRun;
      best = combo;
    }
  }
  const bestStat = stats[best.id];
  return {
    combo: best,
    freshTerritory: false,
    combosTried: tried.length,
    combosTotal: SHUFFLE_COMBOS.length,
    note: `Full rotation done — running back your best performer (${bestStat?.leads ?? 0} leads across ${bestStat?.runs ?? 0} runs). Nova learns.`,
  };
}
