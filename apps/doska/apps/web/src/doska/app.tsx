import { resourceCreateSearch } from "./resource-create-state";
import { DoskaOverview } from "./overview";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { DoskaShell } from "./shell";
import { DoskaTaskSearch } from "./task-search";
import { DoskaStartPage } from "./start-page";
import { DoskaMyTasks } from "./my-tasks";
import { DoskaProjects } from "./project-list";
import { DoskaBoard } from "./board";
import { DoskaInvitationInbox } from "./invitation-inbox";
import { DoskaManagedProjects } from "./managed-projects";
const root = createRootRoute({ component: DoskaShell });
const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: DoskaStartPage,
});
const myTasks = createRoute({
  getParentRoute: () => root,
  path: "/my-tasks",
  component: DoskaMyTasks,
});
const search = createRoute({
  getParentRoute: () => root,
  path: "/search",
  component: DoskaTaskSearch,
});
const overview = createRoute({
  getParentRoute: () => root,
  path: "/overview",
  component: DoskaOverview,
});
const projects = createRoute({
  getParentRoute: () => root,
  path: "/projects",
  validateSearch: resourceCreateSearch,
  component: () => <DoskaProjects resourceSearch={projects.useSearch()} />,
});
const invitations = createRoute({
  getParentRoute: () => root,
  path: "/invitations",
  component: DoskaInvitationInbox,
});
const management = createRoute({
  getParentRoute: () => root,
  path: "/management",
  component: DoskaManagedProjects,
});
const project = createRoute({
  getParentRoute: () => root,
  path: "/projects/$projectId",
  validateSearch: (search: Record<string, unknown>) => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
    panel: search.panel === "members" ? ("members" as const) : undefined,
  }),
  component: () => <DoskaBoard projectId={project.useParams().projectId} />,
});
const router = createRouter({
  routeTree: root.addChildren([
    home,
    myTasks,
    overview,
    search,
    projects,
    project,
    invitations,
    management,
  ]),
  basepath: import.meta.env.BASE_URL,
});
export function DoskaApp() {
  return <RouterProvider router={router} />;
}
