import { match } from "path-to-regexp";
import type { HTTPMethod } from "./routes";

/* TODO: Grab these from @cloudflare/workers-types instead */
type Params<P extends string = string> = Record<P, string | string[]>;

type EventContext<Env, P extends string, Data> = {
  request: Request;
  functionPath: string;
  waitUntil: (promise: Promise<unknown>) => void;
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  env: Env & { ASSETS: { fetch: typeof fetch } };
  params: Params<P>;
  data: Data;
};

type EventPluginContext<Env, P extends string, Data, PluginArgs> = {
  request: Request;
  functionPath: string;
  waitUntil: (promise: Promise<unknown>) => void;
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  _next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  env: Env & { ASSETS: { fetch: typeof fetch } };
  params: Params<P>;
  data: Data;
  pluginArgs: PluginArgs;
};

declare type PagesFunction<
  Env = unknown,
  P extends string = string,
  Data extends Record<string, unknown> = Record<string, unknown>
> = (context: EventContext<Env, P, Data>) => Response | Promise<Response>;

declare type PagesPluginFunction<
  Env = unknown,
  P extends string = string,
  Data extends Record<string, unknown> = Record<string, unknown>,
  PluginArgs = unknown
> = (
  context: EventPluginContext<Env, P, Data, PluginArgs>
) => Response | Promise<Response>;
/* end @cloudflare/workers-types */

type RouteHandler = {
  routePath: string;
  method?: HTTPMethod;
  modules: PagesFunction[];
  middlewares: PagesFunction[];
};

// inject `routes` via ESBuild
declare const routes: RouteHandler[];
// define `__PLUGIN_NAME__` and `__PLUGIN_ASSETS_DIRECTORY__` via ESBuild
declare const __PLUGIN_NAME__: string;
declare const __PLUGIN_ASSETS_DIRECTORY__: string;

// expect an ASSETS fetcher binding pointing to the asset-server stage
type FetchEnv = {
  [name: string]: { fetch: typeof fetch };
  ASSETS: { fetch: typeof fetch };
};

function* executeRequest(
  request: Request,
  _env: FetchEnv,
  relativePathname: string
) {
  // First, iterate through the routes (backwards) and execute "middlewares" on partial route matches
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }

    const routeMatcher = match(route.routePath, { end: false });
    const matchResult = routeMatcher(relativePathname);
    if (matchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params as Params,
          path: matchResult.path,
        };
      }
    }
  }

  // Then look for the first exact route match and execute its "modules"
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }

    const routeMatcher = match(route.routePath, { end: true });
    const matchResult = routeMatcher(relativePathname);
    if (matchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params as Params,
          path: matchResult.path,
        };
      }
      break;
    }
  }
}

export const name = __PLUGIN_NAME__;
export const assetsDirectory = __PLUGIN_ASSETS_DIRECTORY__;

export default function (pluginArgs) {
  const onRequest: PagesPluginFunction = async (workerContext) => {
    let { request } = workerContext;
    const { env, next, data } = workerContext;

    const url = new URL(request.url);
    const basePath = workerContext.functionPath;
    const relativePathname = `/${url.pathname.split(basePath)[1]}`;

    const handlerIterator = executeRequest(request, env, relativePathname);
    const pluginNext = async (input?: RequestInfo, init?: RequestInit) => {
      if (input !== undefined) {
        request = new Request(input, init);
      }

      const result = handlerIterator.next();
      // Note we can't use `!result.done` because this doesn't narrow to the correct type
      if (result.done == false) {
        const { handler, params, path } = result.value;
        const context = {
          request,
          functionPath: workerContext.functionPath + path,
          next: pluginNext,
          _next: next,
          params,
          data,
          pluginArgs,
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
        };

        const response = await handler(context);

        // https://fetch.spec.whatwg.org/#null-body-status
        return new Response(
          [101, 204, 205, 304].includes(response.status) ? null : response.body,
          response
        );
      } else if (__PLUGIN_ASSETS_DIRECTORY__ !== undefined && "ASSETS" in env) {
        request = new Request(
          `http://fakehost/cdn-cgi/pages-plugins/${__PLUGIN_NAME__}${relativePathname}`,
          request
        );
        return env.ASSETS.fetch(request);
      } else {
        return next();
      }
    };

    return pluginNext();
  };

  return onRequest;
}
