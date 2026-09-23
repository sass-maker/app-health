import { type DashboardView } from './dashboard-navigation.js';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CircleHelp,
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
import { ProjectCommandPicker } from './ProjectCommandPicker.js';
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
      className="flex items-center gap-2.5 text-sm font-semibold tracking-tight"
      aria-label="App Health home"
    >
      <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
        <BarChart3 className="size-4" />
      </span>
      App Health
    </a>
  );
}
function WorkspaceSidebar({
  view,
  onView,
  onAdd,
}: Pick<Props, 'view' | 'onView' | 'onAdd'>): JSX.Element {
  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarHeader className="px-4 py-5">
        <ProductBrand />
      </SidebarHeader>
      <SidebarContent>
        <NavigationGroup
          label="Workspace"
          items={[{ id: 'overview', label: 'Overview', icon: Layers3 }]}
          view={view}
          onView={onView}
        />
        {view !== 'overview' ? (
          <>
            <NavigationGroup label="Products" items={productViews} view={view} onView={onView} />
            <NavigationGroup label="Manage" items={manageViews} view={view} onView={onView} />
          </>
        ) : null}
        <div className="px-5 pt-4">
          <Button
            variant="outline"
            className="h-11 w-full justify-start"
            aria-label="Add another project"
            onClick={onAdd}
          >
            <Plus />
            Add project
          </Button>
        </div>
        <div className="mt-auto p-5">
          <a
            href="/#integration"
            className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <CircleHelp className="size-4" />
            Help with setup
            <ArrowUpRight className="ml-auto size-3" />
          </a>
        </div>
      </SidebarContent>
    </Sidebar>
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
                className="h-10 px-3 data-[active=true]:bg-background data-[active=true]:shadow-sm data-[active=true]:[&>svg]:text-primary"
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
  onView,
  view,
}: Pick<Props, 'project' | 'projects' | 'onProject' | 'onView' | 'view'>): JSX.Element {
  const apps = projects.filter((p, i) => projects.findIndex((row) => row.appId === p.appId) === i);
  const environments = projects.filter((candidate) => candidate.appId === project.appId);
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex">
      <ProjectCommandPicker
        projects={apps}
        selectedId={view === 'overview' ? null : project.appId}
        onSelect={(appId) => {
          if (appId === null) {
            onView('overview');
            return;
          }
          const next =
            appId === project.appId
              ? project
              : projects.find((candidate) => candidate.appId === appId);
          if (next) {
            onProject(next);
            if (view === 'overview') onView('analytics');
          }
        }}
      />
      {view !== 'overview' ? (
        <LabeledSelect
          label="Environment"
          triggerClassName="h-11 w-full min-w-0 text-xs sm:max-w-32"
          value={project.environmentId}
          options={environments.map((candidate) => ({
            value: candidate.environmentId,
            label: candidate.environment,
          }))}
          onValueChange={(value) => {
            const next = projects.find(
              (candidate) => candidate.appId === project.appId && candidate.environmentId === value,
            );
            if (next) onProject(next);
          }}
        />
      ) : null}
    </div>
  );
}

function MobileFocusReturn({ triggerId }: { triggerId: string }) {
  const { openMobile } = useSidebar();
  const wasOpen = useRef(false);
  useEffect(() => {
    const shouldRestore = wasOpen.current && !openMobile;
    wasOpen.current = openMobile;
    if (!shouldRestore) return;
    const timer = window.setTimeout(() => document.getElementById(triggerId)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [openMobile, triggerId]);
  return null;
}
export function ProductShell(props: Props): JSX.Element {
  const triggerId = 'workspace-navigation-trigger';
  const presentation = viewPresentation[props.view.split('/')[0]] ?? viewPresentation.overview;
  const ViewIcon = presentation.icon;
  return (
    <SidebarProvider>
      <MobileFocusReturn triggerId={triggerId} />
      <WorkspaceSidebar view={props.view} onView={props.onView} onAdd={props.onAdd} />
      <SidebarInset className="min-w-0 overflow-hidden bg-background">
        <header className="sticky top-0 z-20 flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background/90 px-4 py-2 backdrop-blur lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger id={triggerId} className="size-11" />
            <Separator orientation="vertical" className="!h-5" />
          </div>
          <div className="order-last w-full min-w-0 sm:order-none sm:mr-auto sm:w-auto">
            <ProjectPicker
              project={props.project}
              projects={props.projects}
              onProject={props.onProject}
              onView={props.onView}
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
              <span
                className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border"
                style={{
                  color: presentation.tone,
                  background: `color-mix(in srgb, ${presentation.tone} 10%, transparent)`,
                  borderColor: `color-mix(in srgb, ${presentation.tone} 22%, transparent)`,
                }}
              >
                <ViewIcon className="size-5" />
              </span>
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
          {props.children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const viewPresentation: Record<string, { icon: LucideIcon; tone: string }> = {
  analytics: { icon: BarChart3, tone: 'var(--chart-1)' },
  events: { icon: Zap, tone: 'var(--chart-4)' },
  backend: { icon: Activity, tone: 'var(--chart-2)' },
  settings: { icon: Settings2, tone: 'var(--primary)' },
  overview: { icon: Layers3, tone: 'var(--primary)' },
};
