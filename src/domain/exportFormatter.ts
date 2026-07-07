function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
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
