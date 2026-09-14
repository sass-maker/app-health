import { ANALYTICS_SOURCE_HOSTS, ANALYTICS_SOURCE_ALIASES } from '@app-health/contracts';

/** Project source fields once, then use a shallow tree within AE parser/size limits. */
export function analyticsSourceFrom(source: string): string {
  const raw = "IF(blob17!='' OR blob10!='',blob10,blob6)";
  const value = `substring(lower(${raw}),1,100)`;
  const dot = `position('.' IN ${raw})`;
  const prefixes = "'www.','m.','mobile.','old.','l.','out.','news.','search.'";
  const host = `IF(substring(${value},1,${dot}) IN (${prefixes}),substring(${value},${dot}+1),${value})`;
  return `FROM (SELECT *, ${value} AS source_value, ${host} AS source_host ${source})`;
}

export function analyticsSourceSql(): string {
  return conditionalTree(sourceClauses());
}

export function analyticsSourceFilter(source: string): string {
  const condition = sourceClauses().find(([, label]) => label === source)?.[0];
  return condition ? `(${condition})` : `source_value = '${source.replaceAll("'", "''")}'`;
}

function sourceClauses(): Array<[string, string]> {
  const clauses: Array<[string, string]> = [["source_value = ''", 'Unknown']];
  for (const [label, hosts] of ANALYTICS_SOURCE_HOSTS) {
    const checks = hosts.flatMap((domain) => [`'${domain}'`, `'${domain}.'`]);
    const directHosts = hosts
      .filter((host) => /^(news|search)\./.test(host))
      .flatMap((host) => [`'${host}'`, `'${host}.'`]);
    const names = [
      ...directHosts,
      ...Object.entries(ANALYTICS_SOURCE_ALIASES)
        .filter(([, target]) => target === label)
        .map(([alias]) => `'${alias}'`),
    ].join(',');
    clauses.push([
      `${names ? `source_value IN (${names}) OR ` : ''}source_host IN (${checks.join(',')})`,
      label,
    ]);
  }
  return clauses;
}

function conditionalTree(clauses: Array<[string, string]>): string {
  if (clauses.length <= 5) {
    return clauses.reduceRight(
      (fallback, [condition, label]) => `IF(${condition},'${label}',${fallback})`,
      'source_value',
    );
  }
  const middle = Math.ceil(clauses.length / 2);
  const left = clauses.slice(0, middle);
  const right = clauses.slice(middle);
  const condition = left.map(([check]) => `(${check})`).join(' OR ');
  return `IF(${condition},${conditionalTree(left)},${conditionalTree(right)})`;
}
