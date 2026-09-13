/** Use Analytics Engine's documented IF function for historical source grouping. */
export function analyticsSourceSql(
  expression: 'blob6' | 'blob10' | "IF(blob10 != '', blob10, blob6)",
): string {
  const value = `substring(lower(${expression}), 1, 100)`;
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
  for (const [label, values] of Object.entries(aliases))
    clauses.push([
      `${value} IN (${values
        .split(', ')
        .map((item) => `'${item}'`)
        .join(', ')})`,
      label,
    ]);
  for (const [label, hosts] of Object.entries(domains)) {
    const checks = hosts.flatMap((host) =>
      ['', 'www.', 'm.', 'mobile.', 'old.', 'l.', 'out.', 'news.', 'search.'].flatMap((prefix) => [
        `'${prefix}${host}'`,
        `'${prefix}${host}.'`,
      ]),
    );
    clauses.push([`${value} IN (${checks.join(', ')})`, label]);
  }
  return clauses.reduceRight(
    (otherwise, [condition, label]) => `IF(${condition}, '${label}', ${otherwise})`,
    value,
  );
}
