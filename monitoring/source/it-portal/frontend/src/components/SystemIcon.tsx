import {
  Activity,
  Archive,
  BellRing,
  BookOpen,
  Boxes,
  BriefcaseBusiness,
  Gauge,
  CircuitBoard,
  Cloud,
  ClipboardList,
  Database,
  FileChartColumn,
  Flame,
  Folder,
  FolderSearch,
  FolderUp,
  GitBranch,
  Globe,
  GraduationCap,
  Headphones,
  Layers,
  LayoutGrid,
  Waypoints,
  Monitor,
  Network,
  PanelsTopLeft,
  RadioTower,
  Route,
  Server,
  ServerCog,
  Shield,
  ShieldCheck,
  ShieldEllipsis,
  SlidersHorizontal,
  SquareTerminal,
  SquareKanban,
} from "lucide-react";
import {
  resolveResourceIcon,
  type IconIdentity,
  type SystemIconKey,
} from "../resourceIcons";

const icons = {
  doska: SquareKanban,
  forms: ClipboardList,
  prometheus: Flame,
  alertmanager: BellRing,
  grafana: Gauge,
  gitea: GitBranch,
  netbox: Network,
  oxidized: Archive,
  dozzle: SquareTerminal,
  dns: ShieldCheck,
  esxi: Layers,
  idrac: ServerCog,
  bmc: CircuitBoard,
  cloud: Cloud,
  netronome: RadioTower,
  academy: GraduationCap,
  rds: Monitor,
  support: Headphones,
  wayline: Route,
  wiki: BookOpen,
  sftp: FolderUp,
  topology: Waypoints,
  docker: Boxes,
  reports: FileChartColumn,
  monitoringAdmin: SlidersHorizontal,
  websitesAdmin: PanelsTopLeft,
  auditor: FolderSearch,
  vega: BriefcaseBusiness,
  proxyEdge: ShieldEllipsis,
  proxy: Shield,
  server: Server,
  network: Network,
  database: Database,
  folder: Folder,
  security: ShieldCheck,
  monitoring: Activity,
  app: LayoutGrid,
  web: Globe,
} satisfies Record<SystemIconKey, typeof Globe>;

/** Decorative SVG: its accessible name belongs to the existing adjacent text. */
export function SystemIcon({
  size = 23,
  ...identity
}: IconIdentity & { size?: number }) {
  const { key } = resolveResourceIcon(identity);
  const Icon = icons[key];
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      focusable="false"
      data-system-icon={key}
    />
  );
}
