export function demoItemsForQuery(query) {
  const company = extractCompany(query);
  const normalizedCompany = titleCase(company);
  const location = extractLocation(query) || 'Bay Area';
  const role = extractRole(query) || 'founder';
  const targetLabel = company ? `at ${normalizedCompany}` : `in ${location}`;
  const titleSuffix = company ? `at ${normalizedCompany}` : `Armenian ${role} in ${location}`;

  return [
    {
      url: 'https://example.com/demo/ani-martirosyan',
      title: `Ani Martirosyan | ${titleSuffix}`,
      description: `Demo candidate. Armenian founder-friendly engineer with Yerevan roots, currently listed ${targetLabel}.`,
      text: `Ani Martirosyan is an Armenian ${role} ${targetLabel}. Her public bio mentions Armenia, Yerevan, AI work, founder community, and Armenian events in ${location}.`,
      demo: true,
    },
    {
      url: 'https://example.com/demo/aram-petrosian',
      title: `Aram Petrosian | GTM ${titleSuffix}`,
      description: `Demo candidate. Sales and partnerships profile with Armenian surname signal and public Armenia-related community mentions.`,
      text: `Aram Petrosian is a GTM operator and Armenian community member ${targetLabel}. Public snippets mention Armenian professional groups, AI startups, and founder events in ${location}.`,
      demo: true,
    },
    {
      url: 'https://example.com/demo/narine-hakobyan',
      title: `Narine Hakobyan | AI ${titleSuffix}`,
      description: `Demo candidate. AI operations profile with Yerevan education signal and Armenian language/community references.`,
      text: `Narine Hakobyan works in AI research operations ${targetLabel}. Sources mention Yerevan, Armenian, local founder meetups, and startup activity in ${location}.`,
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

function extractLocation(query) {
  const locations = ['Santa Clara', 'San Francisco', 'Bay Area', 'Silicon Valley', 'San Jose', 'Palo Alto', 'Mountain View', 'Yerevan', 'Armenia'];
  return locations.find((location) => new RegExp(`\\b${location}\\b`, 'i').test(query)) || '';
}

function extractRole(query) {
  if (/\b(ai|ml|machine learning)\b/i.test(query) && /\bfounders?\b/i.test(query)) return 'AI founder';
  if (/\bfounders?\b/i.test(query)) return 'founder';
  if (/\bsales|gtm|account executive\b/i.test(query)) return 'sales leader';
  if (/\bengineer|developer|software\b/i.test(query)) return 'engineer';
  if (/\bproduct\b/i.test(query)) return 'product leader';
  return '';
}

function titleCase(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
