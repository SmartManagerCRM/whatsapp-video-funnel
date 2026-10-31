/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// Static application shell ONLY. API responses (which contain customer data and sessions) are never cached:
// requests to /api/ and /webhook/ are not handled here, so they always go to the network.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    allowlist: [/^\/t\/[^/]+\/?$/, /^\/t\/[^/]+\/(?!api\/|webhook\/)/, /^\/owner\/?(?!api\/)/],
    denylist: [/\/api\//, /\/webhook\//],
  }),
);

self.addEventListener("message", (e) => { if (e.data === "SKIP_WAITING") void self.skipWaiting(); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
