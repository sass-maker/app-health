import generated from '../../probe/journeys.json';

const reviewed = new Set(generated.journeys.map((row) => `${row.project}/${row.journey}`));
export function reviewedMonitoringJourney(project: string, journey: string) {
  return reviewed.has(`${project}/${journey}`);
}

import { probeDefinitionRevision } from '@app-health/contracts';
let revisions: Promise<Map<string, string>> | undefined;
export function reviewedMonitoringRevisions() {
  revisions ??= Promise.all(
    generated.journeys.map(
      async (row) => [`${row.project}/${row.journey}`, await probeDefinitionRevision(row)] as const,
    ),
  ).then((rows) => new Map(rows));
  return revisions;
}
