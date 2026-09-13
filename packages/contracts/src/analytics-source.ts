/**
 * Canonicalise a browser attribution source without retaining URL paths or
 * allowing lookalike hostnames to inherit a known source label.
 */
export function normalizeAnalyticsSource(value: string): string {
  const raw = value.toLowerCase();
  if (!raw) return 'Unknown';

  const source = raw.slice(0, 100);
  if (!source) return 'Unknown';

  for (const [label, hosts] of KNOWN_SOURCES) {
    if (hosts.some((host) => matchesHost(source, host))) return label;
  }
  const alias = SOURCE_ALIASES[source];
  return alias ?? source;
}

/** Categorise a source, with an explicitly supplied campaign medium first. */
export function analyticsSourceChannel(source: string, medium: string): string {
  const normalizedMedium = medium.trim().toLowerCase().replace(/[ _]/g, '-');
  if (/^(cpc|ppc|paid|paidsearch|paid-search|display|cpm)$/.test(normalizedMedium)) return 'Paid';
  if (/^(paid-social|paidsocial)$/.test(normalizedMedium)) return 'Paid';
  if (/^(email|newsletter)$/.test(normalizedMedium)) return 'Email';
  if (/^(social|social-network|social-media)$/.test(normalizedMedium)) return 'Social';
  if (normalizedMedium === 'organic') return 'Organic search';

  if (!source.trim()) return 'Unknown';
  const normalizedSource = normalizeAnalyticsSource(source);
  if (normalizedSource === 'Unknown') return 'Unknown';
  if (SEARCH_SOURCES.has(normalizedSource)) return 'Organic search';
  if (SOCIAL_SOURCES.has(normalizedSource)) return 'Social';
  return 'Referral';
}

function matchesHost(value: string, root: string): boolean {
  return ['', 'www.', 'm.', 'mobile.', 'old.', 'l.', 'out.', 'news.', 'search.'].some(
    (prefix) => value === `${prefix}${root}` || value === `${prefix}${root}.`,
  );
}

const KNOWN_SOURCES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Reddit', ['reddit.com', 'redd.it']],
  ['X', ['x.com', 'twitter.com', 't.co']],
  ['Facebook', ['facebook.com']],
  ['Instagram', ['instagram.com']],
  ['LinkedIn', ['linkedin.com']],
  ['YouTube', ['youtube.com', 'youtu.be']],
  ['TikTok', ['tiktok.com']],
  ['Google', ['google.com', 'google.co.uk', 'google.ca', 'google.com.au', 'google.co.in']],
  ['Bing', ['bing.com']],
  ['DuckDuckGo', ['duckduckgo.com']],
  ['Yahoo', ['yahoo.com', 'search.yahoo.com']],
  ['Baidu', ['baidu.com']],
  ['Yandex', ['yandex.ru', 'yandex.com']],
];

const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  fb: 'Facebook',
  facebook: 'Facebook',
  ig: 'Instagram',
  instagram: 'Instagram',
  li: 'LinkedIn',
  linkedin: 'LinkedIn',
  lnkd: 'LinkedIn',
  reddit: 'Reddit',
  'redd.it': 'Reddit',
  x: 'X',
  twitter: 'X',
  'x-twitter': 'X',
  youtube: 'YouTube',
  yt: 'YouTube',
  tiktok: 'TikTok',
  tt: 'TikTok',
  google: 'Google',
  bing: 'Bing',
  duckduckgo: 'DuckDuckGo',
  yahoo: 'Yahoo',
  baidu: 'Baidu',
  yandex: 'Yandex',
};

const SEARCH_SOURCES = new Set(['Google', 'Bing', 'DuckDuckGo', 'Yahoo', 'Baidu', 'Yandex']);
const SOCIAL_SOURCES = new Set([
  'Reddit',
  'X',
  'Facebook',
  'Instagram',
  'LinkedIn',
  'YouTube',
  'TikTok',
]);
