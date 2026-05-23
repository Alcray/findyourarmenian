export function demoItemsForQuery(query) {
  const company = extractCompany(query) || 'the target company';
  const normalizedCompany = titleCase(company);

  return [
    {
      url: 'https://example.com/demo/ani-martirosyan',
      title: `Ani Martirosyan - Product Engineer at ${normalizedCompany}`,
      description: `Demo candidate. Armenian founder-friendly engineer with Yerevan roots, currently listed near San Francisco and ${normalizedCompany}.`,
      text: `Ani Martirosyan is a product engineer at ${normalizedCompany}. Her public bio mentions Armenia, Yerevan, and Armenian community work in the Bay Area.`,
      demo: true,
    },
    {
      url: 'https://example.com/demo/aram-petrosian',
      title: `Aram Petrosian - GTM / Sales at ${normalizedCompany}`,
      description: `Demo candidate. Sales and partnerships profile with Armenian surname signal and public Armenia-related community mentions.`,
      text: `Aram Petrosian works on GTM and sales at ${normalizedCompany}. Public snippets mention Armenian professional groups and events in San Francisco.`,
      demo: true,
    },
    {
      url: 'https://example.com/demo/narine-hakobyan',
      title: `Narine Hakobyan - AI Research Operations at ${normalizedCompany}`,
      description: `Demo candidate. AI operations profile with Yerevan education signal and Armenian language/community references.`,
      text: `Narine Hakobyan works in AI research operations at ${normalizedCompany}. Sources mention Yerevan, Armenian, and local founder meetups.`,
      demo: true,
    },
  ];
}

function extractCompany(query) {
  const match = query.match(/\b(?:at|in|from|inside|works at|working at)\s+([a-z0-9 .&-]+)/i);
  const known = ['OpenAI', 'Google', 'Meta', 'Apple', 'Microsoft', 'Amazon', 'NVIDIA', 'ScaleKit', 'Apify']
    .find((company) => new RegExp(`\\b${company}\\b`, 'i').test(query));
  if (!match) return known || '';
  return match[1]
    .replace(/\b(?:sf|san francisco|bay area|armenia|armenian|yerevan)\b.*$/i, '')
    .replace(/\b(?:sales|engineering|engineer|founder|founders|people|person)\b/gi, '')
    .trim() || known || '';
}

function titleCase(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
