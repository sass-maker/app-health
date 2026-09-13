/** Keep source grouping compact and shallow for Analytics Engine's SQL parser. */
export function analyticsSourceSql(
  expression: 'blob6' | 'blob10' | "IF(blob10 != '', blob10, blob6)",
): string {
  const compact = expression.replaceAll(' ', '');
  const value = `substring(lower(${compact}),1,100)`;
  const dot = `position('.' IN ${compact})`;
  const prefixes = "'www.','m.','mobile.','old.','l.','out.','news.','search.'";
  const host = `IF(substring(${value},1,${dot}) IN (${prefixes}),substring(${value},${dot}+1),${value})`;
  const aliases: Record<string, string> = {
    Reddit: 'reddit, redd.it',
    X: 'x, twitter, x-twitter',
    Facebook: 'fb, facebook',
    Instagram: 'ig, instagram',
    LinkedIn: 'li, lnkd, linkedin',
    YouTube: 'yt, youtube',
    TikTok: 'tt, tiktok',
    Google: 'google',
    Bing: 'bing',
    DuckDuckGo: 'duckduckgo',
    Yahoo: 'yahoo',
    Baidu: 'baidu',
    Yandex: 'yandex',
  };
  const domains: Record<string, string[]> = {
    Reddit: ['reddit.com', 'redd.it'],
    X: ['x.com', 'twitter.com', 't.co'],
    Facebook: ['facebook.com'],
    Instagram: ['instagram.com'],
    LinkedIn: ['linkedin.com'],
    YouTube: ['youtube.com', 'youtu.be'],
    TikTok: ['tiktok.com'],
    Google: ['google.com', 'google.co.uk', 'google.ca', 'google.com.au', 'google.co.in'],
    Bing: ['bing.com'],
    DuckDuckGo: ['duckduckgo.com'],
    Yahoo: ['yahoo.com', 'search.yahoo.com'],
    Baidu: ['baidu.com'],
    Yandex: ['yandex.ru', 'yandex.com'],
  };
  const clauses: Array<[string, string]> = [[`${value} = ''`, 'Unknown']];
  for (const [label, hosts] of Object.entries(domains)) {
    const checks = hosts.flatMap((domain) => [`'${domain}'`, `'${domain}.'`]);
    const names = aliases[label]
      .split(', ')
      .map((item) => `'${item}'`)
      .join(',');
    clauses.push([`${value} IN (${names}) OR ${host} IN (${checks.join(',')})`, label]);
  }
  return `CASE ${clauses.map(([condition, label]) => `WHEN ${condition} THEN '${label}'`).join(' ')} ELSE ${value} END`;
}
