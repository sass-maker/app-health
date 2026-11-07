import { URL } from 'node:url';

const HOUR = 3_600_000;
const definitions = [
  [
    'runtime-telemetry',
    'App Health runtime telemetry',
    'App Health SDKs and instrumented applications',
    'Workspace health and logs APIs · not connected here',
    'Existing Backend reports remain separate. This operations preview has not aggregated qualified production endpoint or application-log feeds.',
  ],
  [
    'github-ci',
    'Builds and checks',
    'GitHub Actions',
    'GitHub Actions health collector',
    'Default branch and pull requests remain separate. Missing exact-head runs may be explained by path filters.',
  ],
  [
    'github-schedules',
    'Scheduled workflows',
    'GitHub Actions scheduler',
    'GitHub Actions health collector',
    'Latest scheduled results are retained with their dates. A manual success does not prove scheduled execution.',
  ],
  [
    'github-security',
    'Repository security alerts',
    'GitHub Dependabot and code scanning',
    'GitHub security APIs',
    'Open alerts are untriaged findings, not confirmed exploits. Denied access is unavailable coverage, not zero findings.',
  ],
  [
    'deployments',
    'Production deployments',
    'Cloudflare Pages and Workers',
    'Provider deployment inventory',
    'A different Git SHA is an investigation item, not proof of an outage or a required redeploy.',
  ],
  [
    'probes',
    'Production availability',
    'Public production hosts',
    'External HTTP probe',
    'HTTP availability only. This does not qualify sign-in, useful output, save, or recovery.',
  ],
  [
    'collectors',
    'Data collector health',
    'Site Health collectors',
    'Site Health evidence-status API',
    'Freshness follows each source cadence. Collector state is distinct from the product being monitored.',
  ],
  [
    'usage',
    'Automatic usage feeds',
    'App Health and local first-party counters',
    'Site Health readiness API',
    'Audience proxies and event counts do not establish meaningful product use or people.',
  ],
  [
    'runners',
    'Local task receipts',
    'Fleet Workspace',
    'Managed workspace status',
    'Task receipts are not an automatic repair connection. Idle writers are not failed products.',
  ],
  [
    'browser-errors',
    'Browser exceptions',
    'Product browser runtimes',
    'Not connected',
    'Existing browser logs need a qualified exception adapter and per-product live delivery proof.',
  ],
  [
    'native-diagnostics',
    'Native crash diagnostics',
    'Installed native applications',
    'Not connected',
    'Native diagnostics are not inferred from website or browser traffic.',
  ],
  [
    'repairs',
    'Automatic repairs',
    'Repair executor',
    'Not connected',
    'No automatic repairs are running from this dashboard.',
  ],
];
const clean = (value, maximum = 1200) =>
  String(value ?? '')
    .replace(/\b(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\/(?:Users|home|private|tmp)\/[^\s"'<>]+/g, '[private path]')
    .slice(0, maximum);
const iso = (value) =>
  Number.isFinite(Date.parse(value ?? '')) ? new Date(value).toISOString() : null;
const unique = (rows) => [...new Map(rows.map((row) => [row.id, row])).values()];
const fresh = (value, now, maximum = HOUR) =>
  !iso(value) ? 'missing' : Date.parse(now) - Date.parse(value) > maximum ? 'stale' : 'current';
const evidence = (url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return undefined;
    if (
      [...parsed.searchParams.keys()].some((key) =>
        /token|secret|password|key|authorization/i.test(key),
      )
    )
      return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
};

export function catalogProjects(catalog) {
  if (!Array.isArray(catalog?.projects)) throw new Error('Catalog projects are required');
  return catalog.projects
    .filter((p) => ['active', 'primary'].includes(p.lifecycle?.status))
    .map((p) => {
      if (
        typeof p.id !== 'string' ||
        typeof p.name !== 'string' ||
        !['public', 'internal'].includes(p.purpose?.audience) ||
        !['product', 'experiment', 'platform'].includes(p.classification?.kind)
      )
        throw new Error('Active catalog classification is incomplete');
      return {
        id: p.id,
        name: p.name,
        audience: p.purpose.audience,
        kind: p.classification.kind,
        repository:
          p.repositories?.url?.replace(/^https:\/\/github.com\//, '').replace(/\/$/, '') ?? '',
        localPath: p.repositories?.localPath ?? p.repo ?? '',
      };
    });
}
function createBuilder(projects, now) {
  const feeds = [],
    observations = [];
  const families = definitions.map(([id, name, producer, collector, limitations]) => ({
    id,
    name,
    producer,
    collector,
    connected: false,
    limitations,
  }));
  const familyMap = new Map(families.map((family) => [family.id, family]));
  return {
    projects,
    now,
    feeds,
    observations,
    families,
    add(familyId, data) {
      const family = familyMap.get(familyId);
      const feed = {
        producer: family.producer,
        collector: family.collector,
        collectedAt: now,
        observedAt: null,
        freshness: 'missing',
        health: 'unknown',
        summary: '',
        limitations: family.limitations,
        projectIds: [],
        ...data,
        familyId,
      };
      if (feed.health !== 'unavailable') family.connected = true;
      feeds.push(feed);
      return feed;
    },
    observe(feed, data) {
      observations.push({
        id: `${feed.id}:finding`,
        feedId: feed.id,
        projectId: feed.projectIds.length === 1 ? feed.projectIds[0] : null,
        scope: 'production',
        severity: 'warning',
        status: 'open',
        title: feed.name,
        detail: feed.summary,
        observedAt: feed.observedAt,
        ...(feed.evidenceUrl ? { evidenceUrl: feed.evidenceUrl } : {}),
        ...data,
      });
    },
  };
}
function runHealth(run) {
  if (!run) return 'unknown';
  if (run.status !== 'completed') return 'running';
  if (['failure', 'timed_out', 'action_required'].includes(run.conclusion)) return 'failing';
  if (run.conclusion === 'success') return 'healthy';
  return 'unknown';
}
function addWorkflow(builder, repository, workflow, scheduled, collectedAt) {
  const ids = builder.projects
    .filter((p) => p.repository.toLowerCase() === repository.repository.toLowerCase())
    .map((p) => p.id);
  const currentGenerated =
    workflow.generated &&
    workflow.latest?.branch === repository.branch &&
    workflow.latest?.sha === repository.sha
      ? workflow.latest
      : null;
  const run = scheduled ? workflow.schedule : (workflow.defaultBranch ?? currentGenerated);
  const exactHead = run?.sha === repository.sha;
  const observedAt = iso(run?.updatedAt ?? run?.createdAt);
  let health = runHealth(run);
  if (!scheduled && !exactHead) health = 'unknown';
  const disabled = workflow.state !== 'active';
  if (disabled) health = 'attention';
  const scope = scheduled ? 'schedule' : 'main';
  const detail = disabled
    ? 'Workflow is disabled. Check intended owner policy before enabling.'
    : !run
      ? 'No matching run retained; coverage is unverified.'
      : `Latest ${scope} run: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}. ${exactHead ? 'At the observed main revision.' : 'Older revision; current-main acceptance is separate.'}`;
  const feed = builder.add(scheduled ? 'github-schedules' : 'github-ci', {
    id: `github:${repository.repository}:${workflow.id}:${scope}`,
    name: `${repository.repository} · ${workflow.name}`,
    projectIds: ids,
    collectedAt,
    observedAt,
    freshness: fresh(collectedAt, builder.now),
    health,
    summary: detail,
    ...(evidence(run?.url) ? { evidenceUrl: evidence(run.url) } : {}),
  });
  if (health !== 'healthy')
    builder.observe(feed, {
      scope,
      severity: health === 'failing' ? 'error' : health === 'unknown' ? 'info' : 'warning',
      status: health === 'running' ? 'running' : health === 'unknown' ? 'unknown' : 'open',
    });
}
function addPullRequests(builder, repository, collectedAt) {
  for (const pr of repository.pullRequests ?? []) {
    const current = (pr.runs ?? []).filter((run) => run.sha === pr.head);
    const failing = current.find((run) => runHealth(run) === 'failing');
    const running = current.find((run) => runHealth(run) === 'running');
    const chosen = failing ?? running ?? current[0];
    const ids = builder.projects
      .filter((p) => p.repository.toLowerCase() === repository.repository.toLowerCase())
      .map((p) => p.id);
    const feed = builder.add('github-ci', {
      id: `github:${repository.repository}:pr:${pr.number}`,
      name: `${repository.repository} · PR ${pr.number}`,
      projectIds: ids,
      collectedAt,
      observedAt: iso(chosen?.updatedAt),
      freshness: fresh(collectedAt, builder.now),
      health: runHealth(chosen),
      summary: `${current.length} check runs at the retained PR head. Pull-request results do not establish production health.`,
      evidenceUrl: evidence(pr.url),
    });
    if (feed.health !== 'healthy')
      builder.observe(feed, {
        scope: 'pull-request',
        severity: failing ? 'error' : 'info',
        status: running && !failing ? 'running' : failing ? 'open' : 'unknown',
      });
  }
}
function normalizeGithub(builder, github) {
  if (!github) return;
  const collectedAt = iso(github.completedAt ?? github.observedAt);
  for (const repository of github.repositories ?? []) {
    if (
      !builder.projects.some(
        (p) => p.repository.toLowerCase() === repository.repository.toLowerCase(),
      )
    )
      continue;
    for (const workflow of repository.workflows ?? []) {
      if ((workflow.schedules ?? []).length || workflow.triggers?.includes('schedule'))
        addWorkflow(builder, repository, workflow, true, collectedAt);
      if (
        !workflow.triggers?.length ||
        workflow.triggers.some((trigger) =>
          ['push', 'pull_request', 'workflow_call'].includes(trigger),
        ) ||
        (!workflow.triggers.includes('schedule') && workflow.triggers.includes('workflow_dispatch'))
      )
        addWorkflow(builder, repository, workflow, false, collectedAt);
    }
    addPullRequests(builder, repository, collectedAt);
    for (const run of repository.ongoing ?? []) {
      if (Date.parse(builder.now) - Date.parse(run.createdAt) < 24 * HOUR) continue;
      const ids = builder.projects
        .filter((p) => p.repository.toLowerCase() === repository.repository.toLowerCase())
        .map((p) => p.id);
      const feed = builder.add('github-ci', {
        id: `github:${repository.repository}:ongoing:${run.id}`,
        name: `${repository.repository} · run ${run.id}`,
        projectIds: ids,
        collectedAt,
        observedAt: iso(run.updatedAt),
        freshness: fresh(collectedAt, builder.now),
        health: 'attention',
        summary: `Run remains ${run.status} for over a day. Inspect runner or environment approval before cancelling.`,
        evidenceUrl: evidence(run.url),
      });
      builder.observe(feed, { scope: 'main' });
    }
  }
}
function normalizeDeployments(builder, deployments) {
  for (const target of deployments?.targets ?? []) {
    const project = builder.projects.find((p) => p.id === target.project);
    if (!project) continue;
    const collectedAt = iso(deployments.generatedAt ?? deployments.observedAt);
    const exact = target.currentParity === 'exact';
    const detail = exact
      ? 'Deployed source matches the main revision captured by the inventory.'
      : target.currentParity === 'different'
        ? `Deployed ${target.deployed ?? 'unknown'}; main ${target.currentMain?.slice(0, 12) ?? 'unknown'}. Source impact needs review before release.`
        : 'Deployment source identity is unverified.';
    const feed = builder.add('deployments', {
      id: `deployment:${target.project}:${target.kind}:${target.target}`,
      name: `${project.name} · ${target.target}`,
      projectIds: [project.id],
      collectedAt,
      observedAt: iso(target.observedAt),
      freshness: fresh(collectedAt, builder.now, 24 * HOUR),
      health: exact ? 'healthy' : 'unknown',
      summary: detail,
      evidenceUrl: evidence(target.repository ? `https://github.com/${target.repository}` : ''),
    });
    if (!exact)
      builder.observe(feed, {
        severity: 'info',
        status: 'unknown',
        title: `${project.name}: deployment source review`,
      });
  }
}
function normalizeProbes(builder, probes) {
  for (const result of probes?.results ?? []) {
    if (!builder.projects.some((p) => p.id === result.projectId)) continue;
    const collectedAt = iso(probes.generatedAt);
    const observedAt = iso(result.observedAt);
    const health = ['healthy', 'failing'].includes(result.status) ? result.status : 'unknown';
    const feed = builder.add('probes', {
      id: `probe:${result.id}`,
      name: clean(result.name ?? result.projectId),
      projectIds: [result.projectId],
      collectedAt,
      observedAt,
      freshness: fresh(observedAt, builder.now),
      health,
      summary: clean(
        result.detail ??
          `HTTP ${result.httpStatus ?? 'unknown'}${result.durationMs != null ? ` · ${Math.round(result.durationMs)} ms` : ''}`,
      ),
      evidenceUrl: evidence(result.url),
    });
    if (health !== 'healthy')
      builder.observe(feed, {
        severity: health === 'failing' ? 'error' : 'warning',
        status: health === 'unknown' ? 'unknown' : 'open',
      });
  }
}
function normalizeSiteHealth(builder, siteHealth) {
  if (!siteHealth) return;
  for (const [id, source] of Object.entries(siteHealth.evidence?.sources ?? {})) {
    const state = source.state;
    const feed = builder.add('collectors', {
      id: `collector:${id}`,
      name: `Site Health · ${id}`,
      projectIds: [],
      collectedAt: iso(siteHealth.evidence.generatedAt),
      observedAt: iso(source.observedAt),
      maximumAgeMs: source.cadence === 'daily' ? 24 * HOUR : 7 * 24 * HOUR,
      freshness: state === 'fresh' ? 'current' : source.observedAt ? 'stale' : 'missing',
      health:
        state === 'fresh'
          ? 'healthy'
          : ['failed', 'unavailable'].includes(state)
            ? 'failing'
            : state === 'refreshing'
              ? 'running'
              : 'unknown',
      summary: `${clean(state)} · ${source.resultCount ?? 'unknown'} readings · ${clean(source.cadence)} cadence. ${clean(source.failure?.message ?? '')}`,
      limitations: `${definitions.find(([key]) => key === 'collectors')[4]} ${source.period ? `Source window: ${clean(JSON.stringify(source.period), 200)}` : ''}`,
    });
    if (feed.health !== 'healthy')
      builder.observe(feed, {
        scope: 'collector',
        severity: feed.health === 'failing' ? 'error' : 'warning',
        status: feed.health === 'running' ? 'running' : 'open',
        title: `${id}: ${state} collector evidence`,
      });
  }
  for (const project of siteHealth.readiness?.projects ?? []) {
    if (!builder.projects.some((p) => p.id === project.id)) continue;
    const row = project.evidence?.find((e) =>
      ['monthly-local-proxy', 'monthly-browser-proxy'].includes(e.id),
    );
    if (!row) continue;
    const state = row.measurement?.state;
    const feed = builder.add('usage', {
      id: `usage:${project.id}`,
      name: `${project.name} · automatic usage`,
      producer: clean(row.source),
      projectIds: [project.id],
      collectedAt: iso(siteHealth.readiness.generatedAt),
      observedAt: iso(row.observedAt),
      freshness: state === 'current' ? 'current' : state === 'stale' ? 'stale' : 'missing',
      health: state === 'current' ? 'healthy' : 'unknown',
      summary:
        row.value === null
          ? 'Usage reading unavailable; this is not zero use.'
          : `${row.value} ${clean(row.unit)} in the retained source window.`,
      limitations: clean(`${row.gap ?? ''} Window: ${row.window ?? 'unknown'}`),
    });
    if (feed.freshness !== 'current')
      builder.observe(feed, {
        scope: 'collector',
        title: `${project.name}: ${feed.freshness} usage evidence`,
      });
  }
}
function normalizeRunners(builder, workspace) {
  for (const writer of workspace?.workspaces ?? []) {
    if (!['active', 'open'].includes(writer.state)) continue;
    const basename = String(writer.repo ?? '')
      .split('/')
      .pop();
    const project = builder.projects.find((p) => p.localPath === basename);
    if (!project) continue;
    const failed = Number.isInteger(writer.lastExitCode) && writer.lastExitCode !== 0;
    const feed = builder.add('runners', {
      id: `runner:${writer.id}`,
      name: `${project.name} · ${clean(writer.id, 150)}`,
      projectIds: [project.id],
      collectedAt: iso(workspace.generatedAt ?? workspace.observedAt),
      observedAt: iso(writer.heartbeatAt),
      freshness: fresh(workspace.generatedAt ?? workspace.observedAt, builder.now, 24 * HOUR),
      health: failed ? 'attention' : 'unknown',
      summary: `${clean(writer.task, 300)}${failed ? ` Last managed command exited ${writer.lastExitCode}.` : ' Active writer; execution or repair status is not inferred.'}`,
    });
    if (failed)
      builder.observe(feed, {
        scope: 'local',
        title: `${project.name}: task command needs review`,
        severity: 'warning',
      });
  }
}
function unavailableSource(
  builder,
  familyId,
  name,
  collectedAt,
  detail = 'Collection failed. No healthy or zero-finding conclusion is available.',
) {
  const feed = builder.add(familyId, {
    id: `${familyId}:unavailable:${name}`,
    name: clean(name),
    projectIds: builder.projects.map((project) => project.id),
    collectedAt: iso(collectedAt),
    health: 'unavailable',
    summary: clean(detail),
  });
  builder.observe(feed, {
    scope: 'collector',
    title: `${name}: source unavailable`,
    severity: 'warning',
    status: 'unknown',
  });
}
function normalizeSecurity(builder, security) {
  for (const repository of security?.repositories ?? []) {
    const ids = builder.projects
      .filter((p) => p.repository.toLowerCase() === repository.repository.toLowerCase())
      .map((p) => p.id);
    if (!ids.length) continue;
    for (const key of ['dependabot', 'codeScanning']) {
      const source = repository[key];
      if (!source) continue;
      const available = source.status === 'available';
      const alerts = source.alerts ?? [];
      const feed = builder.add('github-security', {
        id: `security:${repository.repository}:${key}`,
        name: `${repository.repository} · ${key === 'codeScanning' ? 'code scanning' : 'Dependabot'}`,
        projectIds: ids,
        collectedAt: iso(security.generatedAt),
        observedAt: iso(repository.observedAt),
        freshness: available ? fresh(security.generatedAt, builder.now) : 'missing',
        health: !available ? 'unavailable' : alerts.length ? 'attention' : 'healthy',
        summary: available
          ? `${alerts.length} open untriaged alerts in the API response.`
          : `Security API unavailable${source.httpStatus ? ` (HTTP ${source.httpStatus})` : ''}. Finding count is unknown.`,
        evidenceUrl: `https://github.com/${repository.repository}/security`,
      });
      if (!available)
        builder.observe(feed, {
          scope: 'collector',
          title: `${repository.repository}: security access unavailable`,
          severity: 'warning',
          status: 'unknown',
        });
      for (const alert of alerts)
        builder.observe(feed, {
          id: `${feed.id}:alert:${alert.id}`,
          scope: 'security',
          severity: ['critical', 'high', 'error'].includes(alert.severity) ? 'error' : 'warning',
          title: clean(alert.title),
          detail: `Untriaged ${clean(alert.severity ?? 'unknown severity')} ${key === 'codeScanning' ? 'code-scanning' : 'dependency'} finding. ${alert.packageName ? `Package: ${clean(alert.packageName)}.` : ''}`,
          observedAt: iso(alert.observedAt ?? repository.observedAt),
          evidenceUrl: evidence(alert.url),
        });
    }
  }
}
export function buildOperationsSnapshot({
  catalog,
  github,
  deployments,
  probes,
  siteHealth,
  workspace,
  security,
  now = new Date().toISOString(),
}) {
  const projects = catalogProjects(catalog);
  const builder = createBuilder(projects, now);
  normalizeGithub(builder, github);
  normalizeDeployments(builder, deployments);
  normalizeProbes(builder, probes);
  normalizeSiteHealth(builder, siteHealth);
  normalizeRunners(builder, workspace);
  normalizeSecurity(builder, security);
  for (const [input, families] of [
    [github, ['github-ci', 'github-schedules']],
    [deployments, ['deployments']],
    [probes, ['probes']],
    [workspace, ['runners']],
    [siteHealth, ['collectors', 'usage']],
    [security, ['github-security']],
  ])
    if (input?.unavailable)
      for (const familyId of families)
        unavailableSource(builder, familyId, definitions.find(([key]) => key === familyId)[1], now);
  return {
    schemaVersion: 'operations.v1',
    generatedAt: now,
    projects: projects.map(({ id, name, audience, kind }) => ({ id, name, audience, kind })),
    families: builder.families,
    feeds: unique(builder.feeds),
    observations: unique(builder.observations),
  };
}
