/** Project source fields once, then use a shallow tree within AE parser/size limits. */
export function analyticsSourceFrom(source: string): string {
  const raw = "IF(blob10!='',blob10,blob6)";
  const value = `substring(lower(${raw}),1,100)`;
  const dot = `position('.' IN ${raw})`;
  const prefixes = "'www.','m.','mobile.','old.','l.','out.','news.','search.'";
  const host = `IF(substring(${value},1,${dot}) IN (${prefixes}),substring(${value},${dot}+1),${value})`;
  return `FROM (SELECT *, ${sourceClassification()} AS normalized_source FROM (SELECT *, ${value} AS source_value, ${host} AS source_host ${source}))`;
}

function sourceClassification(): string {
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
  const clauses: Array<[string, string]> = [["source_value = ''", 'Unknown']];
  for (const [label, hosts] of Object.entries(domains)) {
    const checks = hosts.flatMap((domain) => [`'${domain}'`, `'${domain}.'`]);
    const names = aliases[label]
      .split(', ')
      .map((item) => `'${item}'`)
      .join(',');
    clauses.push([`source_value IN (${names}) OR source_host IN (${checks.join(',')})`, label]);
  }
  return conditionalTree(clauses);
}

function conditionalTree(clauses: Array<[string, string]>): string {
  if (clauses.length === 1) {
    const [condition, label] = clauses[0];
    return `IF(${condition},'${label}',source_value)`;
  }
  const middle = Math.ceil(clauses.length / 2);
  const left = clauses.slice(0, middle);
  const right = clauses.slice(middle);
  const condition = left.map(([check]) => `(${check})`).join(' OR ');
  return `IF(${condition},${conditionalTree(left)},${conditionalTree(right)})`;
}
