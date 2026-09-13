/**
 * Canonicalise a browser attribution source without retaining URL paths or
 * allowing lookalike hostnames to inherit a known source label.
 */
export function normalizeAnalyticsSource(value: string): string {
  const raw = value.toLowerCase();
  if (!raw) return 'Unknown';

  const source = raw.slice(0, 100);
  if (!source) return 'Unknown';

  for (const [label, hosts] of ANALYTICS_SOURCE_HOSTS) {
    if (hosts.some((host) => matchesHost(source, host))) return label;
  }
  const alias = ANALYTICS_SOURCE_ALIASES[source];
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
  if (['ChatGPT', 'Perplexity', 'Claude', 'Gemini'].includes(normalizedSource))
    return 'AI assistants';
  if (SEARCH_SOURCES.has(normalizedSource)) return 'Organic search';
  if (SOCIAL_SOURCES.has(normalizedSource)) return 'Social';
  return 'Referral';
}

function matchesHost(value: string, root: string): boolean {
  return ['', 'www.', 'm.', 'mobile.', 'old.', 'l.', 'out.', 'news.', 'search.'].some(
    (prefix) => value === `${prefix}${root}` || value === `${prefix}${root}.`,
  );
}

export const ANALYTICS_SOURCE_HOSTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Reddit', ['reddit.com', 'redd.it']],
  ['X', ['x.com', 'twitter.com', 't.co']],
  ['Facebook', ['facebook.com', 'fb.com', 'fb.me']],
  ['Instagram', ['instagram.com']],
  ['LinkedIn', ['linkedin.com', 'lnkd.in']],
  ['YouTube', ['youtube.com', 'youtu.be']],
  ['TikTok', ['tiktok.com']],
  [
    'Google',
    [
      'google.com',
      'google.co.uk',
      'google.ca',
      'google.com.au',
      'google.co.in',
      'google.de',
      'google.fr',
      'google.es',
      'google.it',
      'google.co.jp',
      'google.com.br',
      'google.com.mx',
      'google.nl',
      'google.com.sg',
      'com.google.android.googlequicksearchbox',
    ],
  ],
  ['Hacker News', ['news.ycombinator.com']],
  ['Product Hunt', ['producthunt.com']],
  ['ChatGPT', ['chatgpt.com', 'chat.openai.com']],
  ['Perplexity', ['perplexity.ai']],
  ['Claude', ['claude.ai']],
  ['Gemini', ['gemini.google.com']],
  ['Bing', ['bing.com']],
  ['DuckDuckGo', ['duckduckgo.com']],
  ['Yahoo', ['yahoo.com', 'search.yahoo.com']],
  ['Baidu', ['baidu.com']],
  ['Yandex', ['yandex.ru', 'yandex.com']],
];

export const ANALYTICS_SOURCE_ALIASES: Readonly<Record<string, string>> = {
  hn: 'Hacker News',
  hackernews: 'Hacker News',
  'hacker-news': 'Hacker News',
  'hacker news': 'Hacker News',
  producthunt: 'Product Hunt',
  'product-hunt': 'Product Hunt',
  'product hunt': 'Product Hunt',
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  claude: 'Claude',
  gemini: 'Gemini',
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
