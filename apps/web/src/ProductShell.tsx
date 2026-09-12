import { useEffect, useRef, type ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CircleHelp,
  Database,
  Layers3,
  ListFilter,
  Plus,
  Settings2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { CapabilityId } from '@app-health/contracts';
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
import { ThemeToggle } from './ThemeToggle.js';
interface Project {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}
interface Props {
  children: ReactNode;
  view: string;
  title: string;
  description: string;
  project: Project;
  projects: Project[];
  onView: (
    view: 'analytics' | 'events' | 'endpoints' | 'logs' | 'data' | 'projects' | 'settings',
  ) => void;
  onProject: (project: Project) => void;
  onAdd: () => void;
  onLock: () => void;
  accountSession: boolean;
  enabledCapabilities?: CapabilityId[];
}
const productViews = [
  {
    id: 'analytics' as const,
    label: 'Web analytics',
    icon: BarChart3,
    capability: 'analytics' as const,
  },
  { id: 'events' as const, label: 'Events', icon: Zap, capability: 'analytics' as const },
];
const healthViews = [
  {
    id: 'endpoints' as const,
    label: 'App health',
    icon: Activity,
    capability: 'endpoints' as const,
  },
  { id: 'logs' as const, label: 'Logs', icon: ListFilter, capability: 'logs' as const },
  {
    id: 'data' as const,
    label: 'Data received',
    icon: Database,
    capability: 'endpoints' as const,
  },
];
const manageViews = [
  { id: 'projects' as const, label: 'Projects', icon: Layers3 },
  { id: 'settings' as const, label: 'Project settings', icon: Settings2 },
];
type NavigationItem = {
  id: 'analytics' | 'events' | 'endpoints' | 'logs' | 'data' | 'projects' | 'settings';
  label: string;
  icon: LucideIcon;
  capability?: CapabilityId;
};
export function ProductBrand(): JSX.Element {
  return (
    <a
      href="/"
      className="flex items-center gap-2.5 text-sm font-semibold tracking-tight"
      aria-label="App Health home"
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
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
  enabledCapabilities,
}: Pick<Props, 'view' | 'onView' | 'onAdd' | 'enabledCapabilities'>): JSX.Element {
  return (
    <Sidebar collapsible="offcanvas" className="border-r">
      <SidebarHeader className="px-5 py-6">
        <ProductBrand />
        <div className="mt-6 flex items-center gap-3 rounded-lg border bg-background p-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-muted">
            <Layers3 className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-xs font-medium">Your workspace</p>
            <p className="text-xs text-muted-foreground">All your products, together</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavigationGroup
          label="Product"
          items={productViews}
          view={view}
          onView={onView}
          enabledCapabilities={enabledCapabilities}
        />
        <NavigationGroup
          label="Monitor"
          items={healthViews}
          view={view}
          onView={onView}
          enabledCapabilities={enabledCapabilities}
        />
        <NavigationGroup label="Manage" items={manageViews} view={view} onView={onView} />
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
  enabledCapabilities,
}: {
  label: string;
  items: readonly NavigationItem[];
  view: string;
  onView: Props['onView'];
  enabledCapabilities?: CapabilityId[];
}): JSX.Element {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup className="px-3">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items
            .filter(
              (item) =>
                !item.capability || enabledCapabilities?.includes(item.capability) !== false,
            )
            .map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  className="h-11 px-3"
                  isActive={view === item.id}
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
}: Pick<Props, 'project' | 'projects' | 'onProject'>): JSX.Element {
  const apps = projects.filter((p, i) => projects.findIndex((row) => row.appId === p.appId) === i);
  const environments = projects.filter((candidate) => candidate.appId === project.appId);
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex">
      <LabeledSelect
        label="Project"
        triggerClassName="h-11 w-full min-w-0 text-xs sm:max-w-44"
        value={project.appId}
        options={apps.map((candidate) => ({ value: candidate.appId, label: candidate.name }))}
        onValueChange={(value) => {
          const next = projects.find((candidate) => candidate.appId === value);
          if (next) onProject(next);
        }}
      />
      <LabeledSelect
        label="Environment"
        triggerClassName="h-11 w-full min-w-0 text-xs sm:max-w-32"
        value={project.environmentId}
        options={environments.map((candidate) => ({
          value: candidate.environmentId,
          label: candidate.environment,
        }))}
        onValueChange={(value) => {
          const next = projects.find((candidate) => candidate.environmentId === value);
          if (next) onProject(next);
        }}
      />
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
  return (
    <SidebarProvider>
      <MobileFocusReturn triggerId={triggerId} />
      <WorkspaceSidebar
        view={props.view}
        onView={props.onView}
        onAdd={props.onAdd}
        enabledCapabilities={props.enabledCapabilities}
      />
      <SidebarInset className="min-w-0 bg-background">
        <header className="flex min-h-18 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger id={triggerId} className="size-11" />
            <Separator orientation="vertical" className="!h-5" />
            <span className="hidden text-xs text-muted-foreground md:inline">Workspace</span>
            <span className="hidden text-xs text-muted-foreground md:inline">/</span>
            <span className="hidden text-xs font-medium lg:inline">{props.title}</span>
          </div>
          <div className="order-last w-full min-w-0 sm:order-none sm:ml-auto sm:w-auto">
            <ProjectPicker
              project={props.project}
              projects={props.projects}
              onProject={props.onProject}
            />
          </div>
          <div className="flex min-w-0 items-center gap-1 sm:gap-3">
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
        <div className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {props.description}
              </p>
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
