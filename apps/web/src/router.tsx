import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { CiProductShell } from "@/features/ci/ci-product-shell";
import { CiReadinessPage } from "@/features/ci/ci-readiness-page";
import { CiWorkspaceProvider } from "@/features/ci/ci-workspace-context";

export const CI_RUNTIME_PATHS = ["/", "/commercial-industrial"] as const;


function RootLayout() {
  return (
    <CiWorkspaceProvider>
      <CiProductShell>
        <Outlet />
      </CiProductShell>
    </CiWorkspaceProvider>
  );
}


const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: CiReadinessPage,
});

const commercialIndustrialRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/commercial-industrial",
  component: CiReadinessPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  commercialIndustrialRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
