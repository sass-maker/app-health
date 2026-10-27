import { useEffect, useState, type FormEvent } from 'react';
import { WorkspaceList } from '@app-health/contracts';
import { Button } from '@saas-maker/ui/components/button';
import { Input } from '@saas-maker/ui/components/input';
import { Card, CardContent, CardHeader } from '@saas-maker/ui/components/card';
import { LabeledSelect } from './LabeledSelect.js';
import { ownerFetch } from './lib/owner-fetch.js';
import { selectWorkspace, useWorkspaceScope } from './lib/workspace-scope.js';

type Member = { id: string; name: string; email: string; role: string };
type Invite = {
  id: string;
  email: string;
  role: string;
  accepted_at: number | null;
  revoked_at: number | null;
  expires_at: number;
};
type Token = {
  id: string;
  name: string;
  permission: string;
  revoked_at: number | null;
  expires_at: number;
};
type ProjectScope = { appId: string; environmentId: string; name: string; environment: string };
const scopeKey = (scope: Pick<ProjectScope, 'appId' | 'environmentId'>) =>
  JSON.stringify([scope.appId, scope.environmentId]);
function tokenScopeChoices(
  project: Pick<ProjectScope, 'appId' | 'environmentId'> | undefined,
  projects: ProjectScope[] | undefined,
) {
  const production = (projects ?? []).filter(
    (candidate) => candidate.environment.toLowerCase() === 'production',
  );
  if (!project || production.some((candidate) => scopeKey(candidate) === scopeKey(project)))
    return production;
  const current = projects?.find((candidate) => scopeKey(candidate) === scopeKey(project));
  return [
    ...production,
    {
      ...project,
      name: current?.name ?? 'Selected project',
      environment: current?.environment ?? 'selected environment',
    },
  ];
}
async function read(path: string, token: string, init?: RequestInit) {
  const response = await ownerFetch(path, token, init);
  if (!response.ok)
    throw new Error('Workspace action unavailable. Check your account role and try again.');
  return response.json();
}

export function WorkspacePanel({
  ownerToken,
  project,
  projects,
}: {
  ownerToken: string;
  project?: { appId: string; environmentId: string };
  projects?: ProjectScope[];
}) {
  const scope = useWorkspaceScope();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; role: string }[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [name, setName] = useState('');
  const [permission, setPermission] = useState('read');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() =>
    project ? [scopeKey(project)] : [],
  );
  const [fresh, setFresh] = useState<{ value: string; api: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  // Keep the established one-project flow available for a selected non-production environment.
  const availableScopes = tokenScopeChoices(project, projects);
  const availableScopeKeys = availableScopes.map(scopeKey);
  const availableScopeKeySet = new Set(availableScopeKeys);
  const activeSelectedScopes = selectedScopes.filter((key) => availableScopeKeySet.has(key));
  const availableScopeSignature = availableScopeKeys.join('\u0000');
  useEffect(() => {
    if (project) setSelectedScopes([scopeKey(project)]);
  }, [project?.appId, project?.environmentId]);
  useEffect(() => {
    setSelectedScopes((current) => current.filter((key) => availableScopeKeySet.has(key)));
  }, [availableScopeSignature]);
  useEffect(() => {
    if (!open || ownerToken) return;
    const controller = new AbortController();
    setError('');
    void (async () => {
      const listed = WorkspaceList.parse(
        await read('/v1/workspaces', ownerToken, { signal: controller.signal }),
      );
      if (controller.signal.aborted) return;
      setWorkspaces(listed.workspaces);
      if (scope.role !== 'owner') return;
      const [people, invitations, keys] = await Promise.all([
        read('/v1/workspace/members', ownerToken, { signal: controller.signal }),
        read('/v1/workspace/invites', ownerToken, { signal: controller.signal }),
        read('/v1/workspace/api-tokens', ownerToken, { signal: controller.signal }),
      ]);
      if (!controller.signal.aborted) {
        setMembers(people.members);
        setInvites(invitations.invites);
        setTokens(keys.tokens);
      }
    })().catch(() => {
      if (!controller.signal.aborted)
        setError('Sign in with your Google account to manage workspaces.');
    });
    return () => controller.abort();
  }, [open, ownerToken, scope.id, scope.role, revision]);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      const result = await read(path, ownerToken, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      setRevision((value) => value + 1);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workspace action failed');
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function invite(event: FormEvent) {
    event.preventDefault();
    setFresh(null);
    const result = await mutate('/v1/workspace/invites', 'POST', { email, role });
    if (result) {
      setFresh({ value: result.url, api: false });
      setEmail('');
    }
  }
  async function createToken(event: FormEvent) {
    event.preventDefault();
    if (!project || activeSelectedScopes.length === 0 || activeSelectedScopes.length > 50) return;
    setFresh(null);
    const result = await mutate('/v1/workspace/api-tokens', 'POST', {
      name,
      permission,
      scopes: activeSelectedScopes.map((value) => {
        const [appId, environmentId] = JSON.parse(value) as [string, string];
        return { app_id: appId, environment_id: environmentId };
      }),
    });
    if (result) {
      setFresh({ value: result.token, api: true });
      setName('');
      if (project) setSelectedScopes([scopeKey(project)]);
    }
  }
  async function downloadSkill() {
    if (!fresh?.api) return;
    try {
      const response = await ownerFetch('/v1/integration/skill', fresh.value);
      if (!response.ok) throw new Error();
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'SKILL.md';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Integration skill could not download.');
    }
  }
  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">workspace, team & API access</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Your current role is {scope.role}. Workspace API tokens are separate from ingest keys.
            </p>
          </div>
          <Button variant="outline" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'hide workspace access' : 'manage workspace access'}
          </Button>
        </div>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-5">
          <LabeledSelect
            label="Selected workspace"
            value={scope.id || 'personal'}
            onValueChange={(value) => selectWorkspace(value === 'personal' ? '' : value)}
            options={[
              { value: 'personal', label: 'My personal workspace' },
              ...workspaces.map((workspace) => ({
                value: workspace.id,
                label: `${workspace.name} · ${workspace.role}`,
              })),
            ]}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {scope.role === 'owner' && !ownerToken ? (
            <>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">team members</h3>
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs"
                  >
                    <span className="min-w-0 flex-1 break-all">
                      {member.name} · {member.email}
                    </span>
                    {member.role === 'owner' ? (
                      <span>owner</span>
                    ) : (
                      <>
                        <LabeledSelect
                          label={`Role for ${member.email}`}
                          value={member.role}
                          onValueChange={(value) =>
                            void mutate(
                              `/v1/workspace/members/${encodeURIComponent(member.id)}`,
                              'PUT',
                              { role: value },
                            )
                          }
                          options={[
                            { value: 'viewer', label: 'viewer' },
                            { value: 'editor', label: 'editor' },
                          ]}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              `/v1/workspace/members/${encodeURIComponent(member.id)}`,
                              'DELETE',
                            )
                          }
                        >
                          remove
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <form onSubmit={(event) => void invite(event)} className="space-y-3 border-t pt-4">
                <h3 className="text-sm font-medium">invite a verified email</h3>
                <p className="text-xs text-muted-foreground">
                  Copy a one-time link. It expires in seven days. No email is sent.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="email"
                    aria-label="Invite email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    maxLength={254}
                  />
                  <LabeledSelect
                    label="Invite role"
                    value={role}
                    onValueChange={setRole}
                    options={[
                      { value: 'viewer', label: 'viewer' },
                      { value: 'editor', label: 'editor' },
                    ]}
                  />
                  <Button type="submit" disabled={busy}>
                    create invite link
                  </Button>
                </div>
              </form>
              {invites
                .filter(
                  (entry) =>
                    !entry.accepted_at && !entry.revoked_at && entry.expires_at > Date.now(),
                )
                .map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <span className="break-all">
                      {entry.email} · {entry.role}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void mutate(`/v1/workspace/invites/${entry.id}`, 'DELETE')}
                    >
                      revoke invite
                    </Button>
                  </div>
                ))}
              <form
                onSubmit={(event) => void createToken(event)}
                className="space-y-3 border-t pt-4"
              >
                <h3 className="text-sm font-medium">analytics API token</h3>
                <p className="text-xs text-muted-foreground">
                  Restricted to selected project and environment scopes. Expires in 90 days. Manage
                  permission changes goals, funnels and segments only.
                </p>
                {project ? (
                  <fieldset className="space-y-2">
                    <legend className="text-xs font-medium">API token project scopes</legend>
                    <p className="text-xs text-muted-foreground">
                      Choose up to 50 project and environment pairs. Only production environments
                      are listed, except the currently selected environment when it is not
                      production.
                    </p>
                    <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
                      {availableScopes.map((candidate) => {
                        const value = scopeKey(candidate);
                        const checked = activeSelectedScopes.includes(value);
                        return (
                          <label
                            key={value}
                            className="flex cursor-pointer items-center gap-3 rounded-md p-2 text-sm hover:bg-muted/50"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={busy || (!checked && activeSelectedScopes.length >= 50)}
                              onChange={(event) => {
                                const shouldSelect = event.currentTarget.checked;
                                setSelectedScopes((current) => {
                                  const valid = current.filter((key) =>
                                    availableScopeKeySet.has(key),
                                  );
                                  if (!shouldSelect) return valid.filter((key) => key !== value);
                                  return valid.length < 50 && !valid.includes(value)
                                    ? [...valid, value]
                                    : valid;
                                });
                              }}
                              className="size-4 accent-primary"
                            />
                            <span>{candidate.name}</span>
                            <span className="text-muted-foreground">· {candidate.environment}</span>
                          </label>
                        );
                      })}
                    </div>
                    <p aria-live="polite" className="text-xs text-muted-foreground">
                      {activeSelectedScopes.length} of 50 scopes selected
                    </p>
                  </fieldset>
                ) : null}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    aria-label="API token name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={80}
                    placeholder="Research assistant"
                  />
                  <LabeledSelect
                    label="API token permission"
                    value={permission}
                    onValueChange={setPermission}
                    options={[
                      { value: 'read', label: 'read analytics' },
                      { value: 'manage', label: 'manage definitions' },
                    ]}
                  />
                  <Button
                    type="submit"
                    disabled={
                      busy ||
                      !project ||
                      activeSelectedScopes.length === 0 ||
                      activeSelectedScopes.length > 50
                    }
                  >
                    create API token
                  </Button>
                </div>
              </form>
              {tokens
                .filter((entry) => !entry.revoked_at && entry.expires_at > Date.now())
                .map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <span>
                      {entry.name} · {entry.permission}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void mutate(`/v1/workspace/api-tokens/${entry.id}`, 'DELETE')}
                    >
                      revoke token
                    </Button>
                  </div>
                ))}
              {fresh ? (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                  <p className="text-sm font-medium">
                    Copy this {fresh.api ? 'API token' : 'invitation link'} now. It is shown once.
                  </p>
                  <textarea
                    aria-label="One-time credential"
                    className="w-full rounded-md border bg-background p-3 font-mono text-xs"
                    readOnly
                    value={fresh.value}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(fresh.value)
                          .catch(() => setError('Select the credential above to copy it.'))
                      }
                    >
                      copy
                    </Button>
                    {fresh.api ? (
                      <Button type="button" variant="outline" onClick={() => void downloadSkill()}>
                        download integration SKILL.md
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" onClick={() => setFresh(null)}>
                      hide credential
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Only workspace owners manage invitations, members and API tokens.
            </p>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

const PENDING_INVITE = 'app-health-pending-invite';
function pendingInvite() {
  try {
    const match = /^#invite=(ahi_[a-f0-9]{64})$/.exec(location.hash);
    if (match) {
      sessionStorage.setItem(PENDING_INVITE, match[1]);
      history.replaceState(null, '', `${location.pathname}${location.search}#settings`);
    }
    return sessionStorage.getItem(PENDING_INVITE);
  } catch {
    return null;
  }
}
export function PendingInvitation() {
  const [token, setToken] = useState(pendingInvite);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!token) return null;
  async function accept() {
    setBusy(true);
    setError('');
    try {
      const result = await read('/v1/invites/accept', '', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      sessionStorage.removeItem(PENDING_INVITE);
      setToken(null);
      selectWorkspace(result.workspace_id);
    } catch {
      setError(
        'Sign in with the invited Google email. The invitation may have expired or been revoked.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border-b bg-muted/40 px-4 py-3 text-sm">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <p>A workspace invitation is ready. Sign in with the invited email, then accept.</p>
        <Button size="sm" disabled={busy} onClick={() => void accept()}>
          accept workspace invitation
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            sessionStorage.removeItem(PENDING_INVITE);
            setToken(null);
          }}
        >
          dismiss
        </Button>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
