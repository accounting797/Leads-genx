function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function formatEmailsTxt(leads: Record<string, unknown>[]): string {
  const emails: string[] = [];
  const seen = new Set<string>();

  for (const lead of leads) {
    const email = text(lead.email).trim().toLowerCase();
    if (email && !seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }

  return emails.join('\n');
}

type ExportableLead = Record<string, unknown>;

export function formatLeadsTxt(leads: ExportableLead[]): string {
  const header =
    'Type | Name | Title/Category | Company | Email | Phone | Website/Profile | Location/Address | Rating | Reviews';

  const rows = leads.map((lead) => {
    const name = lead.leadType === 'business' ? lead.companyName : lead.fullName;
    const titleOrCategory = lead.leadType === 'business' ? lead.categoryName : lead.jobTitle;
    const url = lead.leadType === 'business' ? lead.website || lead.placeUrl : lead.profileUrl;
    const location = lead.leadType === 'business' ? lead.address : lead.location;

    return [
      lead.leadType,
      name,
      titleOrCategory,
      lead.companyName,
      lead.email,
      lead.phone,
      url,
      location,
      lead.rating,
      lead.reviewsCount,
    ]
      .map(text)
      .join(' | ');
  });

  return [header, ...rows].join('\n');
}

function escapeCsvField(val: unknown): string {
  const str = text(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatLeadsCsv(leads: ExportableLead[]): string {
  const headers = [
    'Lead Type',
    'Name',
    'Title / Category',
    'Company',
    'Email',
    'Phone',
    'Website / Profile',
    'Location / Address',
    'Rating',
    'Reviews Count',
    'Contact Quality',
    'Quality Reason',
  ];

  const rows = leads.map((lead) => {
    const name = lead.leadType === 'business' ? lead.companyName : lead.fullName;
    const titleOrCategory = lead.leadType === 'business' ? lead.categoryName : lead.jobTitle;
    const url = lead.leadType === 'business' ? lead.website || lead.placeUrl : lead.profileUrl;
    const location = lead.leadType === 'business' ? lead.address : lead.location;

    return [
      lead.leadType,
      name,
      titleOrCategory,
      lead.companyName,
      lead.email,
      lead.phone,
      url,
      location,
      lead.rating,
      lead.reviewsCount,
      lead.contactQuality,
      lead.qualityReason,
    ].map(escapeCsvField).join(',');
  });

  return [headers.map(escapeCsvField).join(','), ...rows].join('\n');
}

export function formatCodexCsv(leads: ExportableLead[]): string {
  const headers = [
    'Title',
    'Category Name',
    'Address',
    'Phone',
    'Website',
    'Rating',
    'Reviews Count',
    'Place URL',
    'Place ID',
    'Email',
    'Business Identity Key',
    'Search String',
  ];

  const rows = leads.map((lead) => {
    const emails = text(lead.email);
    return [
      lead.companyName || lead.fullName,
      lead.categoryName,
      lead.address,
      lead.phone,
      lead.website || lead.placeUrl,
      lead.rating,
      lead.reviewsCount,
      lead.placeUrl,
      (lead as Record<string, unknown>).placeId,
      emails,
      lead.businessIdentityKey,
      (lead as Record<string, unknown>).searchString,
    ].map(escapeCsvField).join(',');
  });

  return [headers.map(escapeCsvField).join(','), ...rows].join('\n');
}

export function formatLeadsJson(leads: ExportableLead[]): string {
  const cleanLeads = leads.map((lead) => ({
    id: lead.id,
    leadSource: lead.leadSource,
    leadType: lead.leadType,
    name: lead.leadType === 'business' ? lead.companyName : lead.fullName,
    titleOrCategory: lead.leadType === 'business' ? lead.categoryName : lead.jobTitle,
    companyName: lead.companyName,
    email: lead.email,
    phone: lead.phone,
    website: lead.website || lead.profileUrl || lead.placeUrl,
    location: lead.address || lead.location,
    rating: lead.rating ?? null,
    reviewsCount: lead.reviewsCount ?? null,
    contactQuality: lead.contactQuality || 'qualified',
    qualityReason: lead.qualityReason ?? null,
    createdAt: lead.createdAt,
  }));

  return JSON.stringify(cleanLeads, null, 2);
}

