export type AgentSetupCapability = 'analytics' | 'logs' | 'endpoints';

export function createAgentSetupPrompt(input: {
  project: { name: string; appId: string; environmentId: string; environment: string };
  capabilities: AgentSetupCapability[];
  publicKey?: string;
  analyticsSnippet?: string;
}): string {
  const { project, capabilities, publicKey, analyticsSnippet } = input;
  const lines = [
    `Set up App Health for project ${JSON.stringify(project.name)} (app_id=${project.appId}, environment_id=${project.environmentId}, environment=${JSON.stringify(project.environment)}).`,
    `Work only in the selected ${JSON.stringify(project.environment)} environment. Use the owner APIs at https://health.sassmaker.com and send writes to https://ingest.sassmaker.com.`,
    `This is an execution task: inspect the repository, identify the runtime and package manager, choose the smallest compatible App Health SDK, implement the integration, and verify a real accepted response (HTTP 202) plus the dashboard receipt. Do not deploy unless the user has already explicitly authorized deployment.`,
    `Capabilities requested: ${capabilities.join(', ')}. Preserve existing application behavior and follow the repository's instructions.`,
    `Read the matching SDK documentation in https://github.com/sass-maker/app-health: docs/operator-browser-setup.md, docs/browser-analytics.md, docs/logs.md, and docs/native-integration.md. Use the hosted tracker for websites, the compatible server SDK for Cloudflare, and the Swift package for Apple apps; do not invent package names or install unrelated capabilities.`,
    `Authentication is required for owner APIs. Do not bypass login, request or print cookies/tokens, or claim completion without authenticated API evidence.`,
    `For browser analytics/logs, reuse the supplied public key when present. Otherwise create an origin-bound public key through authenticated POST /v1/public-keys with app_id=${project.appId}, environment_id=${project.environmentId}, and allowed_origins for the actual app origin. Never expose private server keys. Existing key listings contain metadata only; if the raw public key is unavailable, create an additional public key without revoking working integrations.`,
  ];
  if (publicKey)
    lines.push(
      `Use this public key exactly where needed: ${publicKey}. It is safe for the browser only; never treat it as a private key.`,
    );
  if (analyticsSnippet)
    lines.push(
      `Install this analytics script once, preserving its data-project and data-identity attributes:\n${analyticsSnippet}`,
    );
  if (capabilities.includes('analytics'))
    lines.push(
      `Analytics must record page views and live sessions, plus intentional events such as download.clicked when the app has downloads. Keep bot filtering enabled, verify an accepted 202, and confirm the dashboard shows the received data.`,
    );
  if (capabilities.includes('logs'))
    lines.push(
      `Browser logs must be explicit owner-authored events. Do not capture raw requests, headers, cookies, URLs with secrets, stacks, or identities. Keep private keys in runtime secrets only.`,
    );
  if (capabilities.includes('endpoints'))
    lines.push(
      `Endpoint health must use the server SDK with the private ingest key in the platform secret store. Do not send raw request bodies, query values, headers, cookies, or private key material to the dashboard.`,
    );
  lines.push(
    `When done, report files changed, the exact verification commands, the accepted 202 evidence, and any blocked authentication or deployment step. Do not claim a live deployment from local checks.`,
  );
  return lines.join('\n\n');
}
