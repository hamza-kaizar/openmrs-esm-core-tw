import { RouteHandlerCallbackOptions } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { getOrCreateDefaultRouter } from "workbox-routing/utils/getOrCreateDefaultRouter";
import { validMethods } from "workbox-routing/utils/constants";
import { CacheOnly, NetworkFirst, NetworkOnly } from "workbox-strategies";
import { indexUrl, omrsCacheName } from "./constants";
import { ServiceWorkerDb } from "./storage";
import {
  getOmrsHeader,
  parseOmrsOfflineResponseBodyHeader,
  parseOmrsOfflineResponseStatusHeader,
} from "./http-header-utils";
import {
  OmrsOfflineCachingStrategy,
  omrsOfflineCachingStrategyHttpHeaderName,
} from "@openmrs/esm-offline/src/service-worker-http-headers";
import uniq from "lodash-es/uniq";

const offlineEncryptionPlugin = {
  cachedResponseWillBeUsed: async ({
    cacheName,
    request,
    matchOptions,
    cachedResponse,
    event,
    state,
  }) => {
    var responseClone = cachedResponse.clone();
    var resHeaders = responseClone.headers;
    var isEncrypted = resHeaders.has("encryption");
    if (isEncrypted) {
      var resJson = await responseClone.json().then((json) => json);
      var decryptedData = atob(resJson["content"]);
      var decryptedJson = JSON.parse(decryptedData);
      return new Response(JSON.stringify(decryptedJson), {
        headers: resHeaders,
      });
    }
    return cachedResponse;
  },
  cacheWillUpdate: async ({ request, response, event, state }) => {
    // Return `response`, a different `Response` object, or `null`.
    console.log("cacheWillUpdate");
    var responseClone = response.clone();
    var contentType;
    if (request.url.includes("fhir")) {
      var resHeaders = new Headers(responseClone.headers);
      contentType = resHeaders.get("content-type");
      if (contentType == "application/fhir+json;charset=UTF-8") {
        resHeaders.append("encryption", "true");
        var resJson = await responseClone.json().then((json) => json);
        var encryptedData = btoa(JSON.stringify(resJson));
        var encryptedJson = { content: encryptedData };
        return new Response(JSON.stringify(encryptedJson), {
          headers: resHeaders,
        });
      }
    }
    return response;
  },
};

const networkOnly = new NetworkOnly();
const cacheOnly = new CacheOnly({
  cacheName: omrsCacheName,
  plugins: [offlineEncryptionPlugin],
});
const networkFirst = new NetworkFirst({
  cacheName: omrsCacheName,
  plugins: [offlineEncryptionPlugin],
});

const defaultStrategy: OmrsOfflineCachingStrategy =
  "network-only-or-cache-only";
const knownStrategyHandlers: Record<
  OmrsOfflineCachingStrategy,
  (options: RouteHandlerCallbackOptions) => Promise<Response>
> = {
  ["network-first"]: (options) => networkFirst.handle(options),
  ["network-only-or-cache-only"]: async (
    options: RouteHandlerCallbackOptions
  ) => {
    try {
      return await networkOnly.handle(options);
    } catch (e) {
      return await cacheOnly.handle(options);
    }
  },
};

/**
 * Registers required Workbox routes used by the service worker to provide offline functionality.
 */
export function registerAllOmrsRoutes() {
  // Navigation requests are, when unresolvable via network (i.e. when offline), routed back
  // to the SPA's index (which should always be precached).
  // This ensures that the page loads correctly when a new navigation occurs to pages
  // like `/openmrs/spa/anything/nested`.
  registerRoute(
    ({ request }) => request.mode === "navigate",
    navigationHandler
  );

  // Fallback routing behavior.
  // Checks if a dynamic route registration exists and, if so, handles it using a Network First approach.
  // Otherwise falls back to a NetworkOnly - CacheOnly behavior.
  //
  // The latter ensures that:
  // a) precached files (like the app shell and files resolved from the importmap) are returned when offline.
  // b) anything else (e.g. API requests) is not cached.
  const router = getOrCreateDefaultRouter();
  for (const method of validMethods) {
    router.setDefaultHandler(defaultHandler, method);
  }
}

async function navigationHandler(options: RouteHandlerCallbackOptions) {
  try {
    return await networkOnly.handle(options);
  } catch (e) {
    const cache = await caches.open(omrsCacheName);
    const response = await cache.match(indexUrl);
    return response ?? Response.error();
  }
}

async function defaultHandler(options: RouteHandlerCallbackOptions) {
  const { request } = options;
  const handlerKey =
    options.request.method === "GET"
      ? await getHandlerKey(options)
      : defaultStrategy;
  const handler =
    knownStrategyHandlers[handlerKey] ?? knownStrategyHandlers[defaultStrategy];

  try {
    return await handler(options);
  } catch (e) {
    console.warn(
      "[SW] Could not handle the request to %s (using handler %s).",
      request.url,
      handlerKey,
      e
    );

    return new Response(parseOmrsOfflineResponseBodyHeader(request.headers), {
      status: parseOmrsOfflineResponseStatusHeader(request.headers),
    });
  }
}

async function getHandlerKey({ request }: RouteHandlerCallbackOptions) {
  return (
    getHandlerKeyFromHeaders(request.headers) ??
    (await getHandlerKeyFromDynamicRouteRegistrations(request.url))
  );
}

function getHandlerKeyFromHeaders(headers: Headers) {
  return getOmrsHeader(headers, omrsOfflineCachingStrategyHttpHeaderName);
}

async function getHandlerKeyFromDynamicRouteRegistrations(url: string) {
  const db = new ServiceWorkerDb();
  const allDynamicRouteRegistrations =
    await db.dynamicRouteRegistrations.toArray();
  const strategies = uniq(
    allDynamicRouteRegistrations
      .filter((route) => new RegExp(route.pattern).test(url))
      .map((route) => route.strategy ?? "network-first")
  );

  if (strategies.length <= 1) {
    return strategies[0];
  } else {
    // Multiple routes can match the URL (multiple RegExps can match).
    // In that case, prioritize the available strategies. When in doubt, cache the resource again.
    const priorities: Array<OmrsOfflineCachingStrategy> = [
      "network-first",
      "network-only-or-cache-only",
    ];

    return (
      priorities.find((prioritizedStrategy) =>
        strategies.some((strategy) => strategy === prioritizedStrategy)
      ) ?? defaultStrategy
    );
  }
}
