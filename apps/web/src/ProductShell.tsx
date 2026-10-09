import { type DashboardView } from './dashboard-navigation.js';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CircleHelp,
  Gauge,
  Layers3,
  Plus,
  Settings2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './components/ui/sidebar.js';
import { Button } from './components/ui/button.js';
import { Badge } from './components/ui/badge.js';
import { Separator } from './components/ui/separator.js';
import { LabeledSelect } from './LabeledSelect.js';
import { Input } from './components/ui/input.js';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs.js';
import { ThemeToggle } from './ThemeToggle.js';
interface Project {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}
interface Props {
  children: ReactNode;
  view: DashboardView;
  eyebrow: string;
  title: string;
  description: string;
  project: Project;
  projects: Project[];
  onView: (view: DashboardView) => void;
  onProject: (project: Project) => void;
  onAdd: () => void;
  onLock: () => void;
  accountSession: boolean;
}
const productViews = [
  {
    id: 'analytics' as const,
    label: 'Analytics',
    icon: BarChart3,
    activeViews: ['analytics', 'analytics/setup'] as const,
  },
  { id: 'events' as const, label: 'Events', icon: Zap },
  {
    id: 'backend' as const,
    label: 'Backend',
    icon: Activity,
    activeViews: ['backend', 'backend/logs', 'backend/diagnostics'] as const,
  },
];
const manageViews = [{ id: 'settings' as const, label: 'Settings', icon: Settings2 }];
type NavigationItem = {
  id: DashboardView;
  label: string;
  icon: LucideIcon;
  activeViews?: readonly string[];
};
export function ProductBrand(): JSX.Element {
  return (
    <a
      href="/"
      className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-sm font-semibold tracking-tight"
      aria-label="App Health home"
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <BarChart3 className="size-4" />
      </span>
      App Health
    </a>
  );
}
type WorkspaceSidebarProps = Pick<
  Props,
  'view' | 'project' | 'projects' | 'onProject' | 'onView' | 'onAdd'
>;

function projectApps(projects: Project[]): Project[] {
  return [...new Map(projects.map((item) => [item.appId, item])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function projectForApp(app: Project, current: Project, projects: Project[]): Project {
  if (app.appId === current.appId) return current;
  return (
    projects.find((item) => item.appId === app.appId && item.environment === 'production') ?? app
  );
}

function ProjectNavigation({
  view,
  project,
  projects,
  onProject,
  onView,
}: WorkspaceSidebarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const { setOpenMobile } = useSidebar();
  const apps = useMemo(() => projectApps(projects), [projects]);
  const matches = apps.filter((item) =>
    item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <SidebarGroup className="px-3">
      <SidebarGroupLabel className="justify-between">
        Projects <span className="tabular-nums">{apps.length}</span>
      </SidebarGroupLabel>
      <Input
        aria-label="Search projects"
        placeholder="Search projects…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="mb-2 h-9"
      />
      <SidebarGroupContent>
        <SidebarMenu>
          {matches.map((app) => (
            <SidebarMenuItem key={app.appId}>
              <SidebarMenuButton
                isActive={view !== 'overview' && view !== 'speed' && project.appId === app.appId}
                title={app.name}
                onClick={() => {
                  onProject(projectForApp(app, project, projects));
                  if (view === 'overview' || view === 'speed') onView('analytics');
                  setOpenMobile(false);
                }}
              >
                <span className="truncate">{app.name}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        {!matches.length ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">No projects match your search.</p>
        ) : null}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function WorkspaceSidebar(props: WorkspaceSidebarProps): JSX.Element {
  return (
    <Sidebar
      collapsible="offcanvas"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById('workspace-navigation-trigger')?.focus();
      }}
    >
      <SidebarHeader className="px-4 py-4">
        <ProductBrand />
      </SidebarHeader>
      <SidebarContent>
        <NavigationGroup
          label="Workspace"
          items={[
            { id: 'overview', label: 'Daily briefing', icon: Layers3 },
            { id: 'speed', label: 'Speed', icon: Gauge },
          ]}
          view={props.view}
          onView={props.onView}
        />
        <ProjectNavigation {...props} />
        <WorkspaceSidebarFooter onAdd={props.onAdd} />
      </SidebarContent>
    </Sidebar>
  );
}

function WorkspaceSidebarFooter({ onAdd }: Pick<Props, 'onAdd'>): JSX.Element {
  return (
    <div className="mt-auto px-3 pb-3">
      <Button
        variant="ghost"
        className="w-full justify-start"
        aria-label="Add another project"
        onClick={() => {
          window.appHealth?.track('project_add_started');
          void window.appHealth?.flush?.();
          onAdd();
        }}
      >
        <Plus />
        Add project
      </Button>
      <a
        href="/#integration"
        className="flex min-h-11 items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground"
      >
        <CircleHelp className="size-4" />
        Help with setup
        <ArrowUpRight className="ml-auto size-3" />
      </a>
    </div>
  );
}

function NavigationGroup({
  label,
  items,
  view,
  onView,
}: {
  label: string;
  items: readonly NavigationItem[];
  view: DashboardView;
  onView: Props['onView'];
}): JSX.Element {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup className="px-3">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                className="h-9 px-3"
                isActive={item.activeViews?.includes(view) ?? view === item.id}
                onClick={() => {
                  onView(item.id);
                  setOpenMobile(false);
                }}
              >
                <item.icon />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
function ProjectPicker({
  project,
  projects,
  onProject,
  view,
}: Pick<Props, 'project' | 'projects' | 'onProject' | 'view'>): JSX.Element {
  const environments = projects.filter((candidate) => candidate.appId === project.appId);
  return (
    <div role="group" aria-label="Project context" className="flex min-w-0 items-center gap-3">
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={view === 'overview' || view === 'speed' ? 'Portfolio' : project.name}
      >
        {view === 'overview' || view === 'speed' ? 'Portfolio' : project.name}
      </span>
      {view !== 'overview' && view !== 'speed' ? (
        <LabeledSelect
          label="Environment"
          triggerClassName="h-9 w-28 text-xs"
          value={project.environmentId}
          options={environments.map((candidate) => ({
            value: candidate.environmentId,
            label: candidate.environment,
          }))}
          onValueChange={(value) => {
            const next = environments.find((candidate) => candidate.environmentId === value);
            if (next) onProject(next);
          }}
        />
      ) : null}
    </div>
  );
}

export function ProductShell(props: Props): JSX.Element {
  const triggerId = 'workspace-navigation-trigger';
  return (
    <SidebarProvider>
      <WorkspaceSidebar
        view={props.view}
        project={props.project}
        projects={props.projects}
        onProject={props.onProject}
        onView={props.onView}
        onAdd={props.onAdd}
      />
      <SidebarInset className="min-w-0 overflow-hidden bg-background">
        <header className="sticky top-0 z-20 flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-4 py-2 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger id={triggerId} className="size-11" />
            <Separator orientation="vertical" className="!h-5" />
          </div>
          <div className="order-last w-full min-w-0 sm:order-none sm:mr-auto sm:w-auto">
            <ProjectPicker
              project={props.project}
              projects={props.projects}
              onProject={props.onProject}
              view={props.view}
            />
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-3">
            <ThemeToggle />
            <Button
              variant="ghost"
              className="h-11 px-2 text-xs text-muted-foreground"
              onClick={props.onLock}
            >
              {props.accountSession ? 'Sign out' : 'Lock'}
            </Button>
          </div>
        </header>
        <div className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8 lg:py-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3.5">
              <div className="min-w-0">
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {props.eyebrow}
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">{props.title}</h1>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  {props.description}
                </p>
              </div>
            </div>
            {import.meta.env.DEV ? (
              <Badge variant="outline" className="mt-1 shrink-0 text-xs font-normal">
                Local preview
              </Badge>
            ) : null}
          </div>
          {props.view !== 'overview' && props.view !== 'speed' ? (
            <Tabs
              value={props.view.split('/')[0]}
              onValueChange={(value) => props.onView(value as DashboardView)}
              className="mb-6"
            >
              <TabsList aria-label="Project reports" className="w-full self-start sm:w-auto">
                {[...productViews, ...manageViews].map((item) => (
                  <TabsTrigger key={item.id} value={item.id}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}
          {props.children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
