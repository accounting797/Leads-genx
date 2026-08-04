export interface DerivedPromptIntent {
  keywords: string[];
  industries: string[];
}

const INDUSTRY_PHRASES = [
  'freight forwarding', 'supply chain', 'real estate', 'financial services', 'information technology',
  'renewable energy', 'oil and gas', 'health care', 'digital marketing', 'food service',
  'logistics', 'aviation', 'aerospace', 'power', 'energy', 'manufacturing', 'construction',
  'transportation', 'trucking', 'shipping', 'warehousing', 'distribution', 'retail', 'wholesale',
  'hospitality', 'healthcare', 'pharmaceutical', 'technology', 'software', 'telecommunications',
  'insurance', 'banking', 'accounting', 'legal', 'education', 'agriculture', 'automotive',
  'security', 'consulting', 'recruitment', 'staffing', 'media', 'entertainment', 'sports',
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'bank', 'banks', 'branch', 'branches', 'business', 'businesses',
  'company', 'companies', 'contact', 'contacts', 'email', 'emails', 'find', 'for', 'from', 'in',
  'industries', 'industry', 'lead', 'leads', 'mail', 'near', 'of', 'people', 'phone', 'public',
  'scrape', 'search', 'the', 'their', 'to', 'top', 'used', 'using', 'with', 'chase', 'wells',
  'fargo', 'pnc', 'rbc', 'td', 'bmo', 'cibc', 'scotiabank', 'truist', 'keybank', 'huntington',
]);

function normalizedPrompt(prompt: string): string {
  return prompt.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function derivePromptIntent(prompt: string): DerivedPromptIntent {
  const normalized = normalizedPrompt(prompt);
  const phrases = INDUSTRY_PHRASES
    .map((phrase) => ({ phrase, index: normalized.indexOf(phrase) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length)
    .filter((entry, index, all) => !all.some((other, otherIndex) => otherIndex < index
      && other.index <= entry.index
      && other.index + other.phrase.length >= entry.index + entry.phrase.length))
    .map((entry) => entry.phrase);

  const keywords = phrases.length ? phrases : [...new Set(normalized.split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word)))].slice(0, 12);
  return { keywords, industries: [...keywords] };
}
