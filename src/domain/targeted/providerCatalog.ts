export interface ProviderMatch {
  id: string;
  label: string;
  group: 'office' | 'google' | 'other' | 'security';
  matchType: 'visible_domain' | 'mx_suffix' | 'mx_contains';
  pattern: string;
  catalogVersion: '2026-08-03';
}

const VERSION = '2026-08-03' as const;

function visible(id: string, label: string, group: ProviderMatch['group'], ...domains: string[]): ProviderMatch[] {
  return domains.map((pattern) => ({ id, label, group, matchType: 'visible_domain', pattern, catalogVersion: VERSION }));
}

function mx(
  id: string,
  label: string,
  group: ProviderMatch['group'],
  matchType: 'mx_suffix' | 'mx_contains',
  ...patterns: string[]
): ProviderMatch[] {
  return patterns.map((pattern) => ({ id, label, group, matchType, pattern, catalogVersion: VERSION }));
}

const CATALOG: readonly ProviderMatch[] = Object.freeze([
  ...mx('microsoft_365', 'Microsoft 365', 'office', 'mx_suffix', 'mail.protection.outlook.com'),
  ...mx('google_workspace', 'Google Workspace', 'google', 'mx_contains', 'google.com', 'googlemail.com'),
  ...mx('zoho', 'Zoho Mail', 'office', 'mx_contains', 'zoho.com', 'zohomail.com'),
  ...mx('godaddy', 'GoDaddy Email', 'office', 'mx_contains', 'secureserver.net'),
  ...mx('fastmail', 'Fastmail', 'office', 'mx_contains', 'messagingengine.com'),
  ...mx('proton_business', 'Proton Business', 'office', 'mx_contains', 'protonmail.ch'),
  ...mx('rackspace', 'Rackspace Email', 'office', 'mx_contains', 'emailsrvr.com'),
  ...mx('mimecast', 'Mimecast', 'security', 'mx_contains', 'mimecast.com'),
  ...mx('proofpoint', 'Proofpoint', 'security', 'mx_contains', 'pphosted.com', 'proofpoint.com'),
  ...mx('cisco_ironport', 'Cisco Secure Email / IronPort', 'security', 'mx_contains', 'iphmx.com', 'cisco.com'),
  ...mx('barracuda', 'Barracuda', 'security', 'mx_contains', 'barracudanetworks.com'),
  ...mx('spamtitan', 'SpamTitan', 'security', 'mx_contains', 'spamtitan.com'),

  ...visible('gmail', 'Gmail', 'google', 'gmail.com', 'googlemail.com'),
  ...visible('outlook', 'Outlook / Hotmail', 'office', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com'),
  ...visible('yahoo', 'Yahoo Mail', 'other', 'yahoo.com', 'ymail.com', 'rocketmail.com'),
  ...visible('aol', 'AOL Mail', 'other', 'aol.com'),
  ...visible('comcast', 'Comcast / Xfinity', 'other', 'comcast.net'),
  ...visible('att', 'AT&T Mail', 'other', 'att.net', 'sbcglobal.net', 'bellsouth.net'),
  ...visible('verizon', 'Verizon Mail', 'other', 'verizon.net'),
  ...visible('cox', 'Cox Mail', 'other', 'cox.net'),
  ...visible('spectrum', 'Spectrum / Charter', 'other', 'spectrum.net', 'charter.net', 'twc.com', 'rr.com'),
  ...visible('icloud', 'iCloud Mail', 'other', 'icloud.com', 'me.com', 'mac.com'),
  ...visible('gmx', 'GMX', 'other', 'gmx.com', 'gmx.us', 'gmx.ca'),
  ...visible('mail_com', 'Mail.com', 'other', 'mail.com'),
]);

function hostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

export function providerCatalog(): readonly ProviderMatch[] {
  return CATALOG;
}

export function visibleDomainProvider(email: string): ProviderMatch | undefined {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return undefined;
  const domain = hostname(email.slice(at + 1));
  return CATALOG.find((entry) => entry.matchType === 'visible_domain' && domain === entry.pattern);
}

export function mxInfrastructureProvider(hosts: string[]): ProviderMatch[] {
  const normalized = hosts.map(hostname).filter(Boolean);
  const matches = CATALOG.filter((entry) => {
    if (entry.matchType === 'visible_domain') return false;
    return normalized.some((host) => entry.matchType === 'mx_suffix'
      ? host === entry.pattern || host.endsWith(`.${entry.pattern}`)
      : host.includes(entry.pattern));
  });
  return matches.filter((entry, index) => matches.findIndex((candidate) => candidate.id === entry.id) === index);
}
