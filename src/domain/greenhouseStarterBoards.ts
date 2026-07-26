export interface StarterGreenhouseBoard {
  boardToken: string;
  companyName: string;
  companyDomain: string;
  industry: string;
  geographies: string[];
}

/**
 * Public board tokens are only candidates. The scan revalidates every seed
 * against Greenhouse before it can appear to a user.
 */
export const STARTER_GREENHOUSE_BOARDS: StarterGreenhouseBoard[] = [
  {
    boardToken: 'stripe',
    companyName: 'Stripe',
    companyDomain: 'stripe.com',
    industry: 'Financial Services',
    geographies: ['United States', 'Remote'],
  },
  {
    boardToken: 'figma',
    companyName: 'Figma',
    companyDomain: 'figma.com',
    industry: 'Software',
    geographies: ['United States', 'Remote'],
  },
  {
    boardToken: 'datadog',
    companyName: 'Datadog',
    companyDomain: 'datadoghq.com',
    industry: 'Software',
    geographies: ['United States', 'Remote'],
  },
  {
    boardToken: 'cloudflare',
    companyName: 'Cloudflare',
    companyDomain: 'cloudflare.com',
    industry: 'Technology',
    geographies: ['United States', 'Remote'],
  },
  {
    boardToken: 'greenhouse',
    companyName: 'Greenhouse',
    companyDomain: 'greenhouse.com',
    industry: 'Human Resources Software',
    geographies: ['United States', 'Remote'],
  },
];
