import fs from "node:fs/promises";
import path from "node:path";
import * as acorn from "acorn";
import * as acornWalk from "acorn-walk";
import { transform } from "esbuild";
import { toUrlPath } from "../../src/paths";
import type { UrlPath } from "../../src/paths";
import type { HTTPMethod, RouteConfig } from "./routes";
import type { ExportNamedDeclaration, Identifier } from "estree";

export async function generateConfigFromFileTree({
  baseDir,
  baseURL,
}: {
  baseDir: string;
  baseURL: UrlPath;
}) {
  let routeEntries: RouteConfig[] = [];

  if (!baseURL.startsWith("/")) {
    baseURL = `/${baseURL}` as UrlPath;
  }

  if (baseURL.endsWith("/")) {
    baseURL = baseURL.slice(0, -1) as UrlPath;
  }

  await forEachFile(baseDir, async (filepath) => {
    const ext = path.extname(filepath);
    if (/^\.(mjs|js|ts|tsx|jsx)$/.test(ext)) {
      // transform the code to ensure we're working with vanilla JS + ESM
      const { code } = await transform(await fs.readFile(filepath, "utf-8"), {
        loader: ext === ".ts" ? "ts" : "js",
      });

      // parse each file into an AST and search for module exports that match "onRequest" and friends
      const ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
      });
      acornWalk.simple(ast, {
        ExportNamedDeclaration(_node: unknown) {
          // This dynamic cast assumes that the AST generated by acornWalk will generate nodes that
          // are compatible with the eslint AST nodes.
          const node = _node as ExportNamedDeclaration;

          // this is an array because multiple things can be exported from a single statement
          // i.e. `export {foo, bar}` or `export const foo = "f", bar = "b"`
          const exportNames: string[] = [];

          if (node.declaration) {
            const declaration = node.declaration;

            // `export async function onRequest() {...}`
            if (declaration.type === "FunctionDeclaration" && declaration.id) {
              exportNames.push(declaration.id.name);
            }

            // `export const onRequestGet = () => {}, onRequestPost = () => {}`
            if (declaration.type === "VariableDeclaration") {
              exportNames.push(
                ...declaration.declarations.map(
                  (variableDeclarator) =>
                    (variableDeclarator.id as unknown as Identifier).name
                )
              );
            }
          }

          // `export {foo, bar}`
          if (node.specifiers.length) {
            exportNames.push(
              ...node.specifiers.map(
                (exportSpecifier) =>
                  (exportSpecifier.exported as unknown as Identifier).name
              )
            );
          }

          for (const exportName of exportNames) {
            const [match, method = ""] = (exportName.match(
              /^onRequest(Get|Post|Put|Patch|Delete|Options|Head)?$/
            ) ?? []) as (string | undefined)[];

            if (match) {
              const basename = path.basename(filepath).slice(0, -ext.length);

              const isIndexFile = basename === "index";
              // TODO: deprecate _middleware_ in favor of _middleware
              const isMiddlewareFile =
                basename === "_middleware" || basename === "_middleware_";

              let routePath = path
                .relative(baseDir, filepath)
                .slice(0, -ext.length);

              if (isIndexFile || isMiddlewareFile) {
                routePath = path.dirname(routePath);
              }

              if (routePath === ".") {
                routePath = "";
              }

              routePath = `${baseURL}/${routePath}`;

              routePath = routePath.replace(/\[\[(.+)]]/g, ":$1*"); // transform [[id]] => :id*
              routePath = routePath.replace(/\[(.+)]/g, ":$1"); // transform [id] => :id

              const routeEntry: RouteConfig = {
                routePath: toUrlPath(routePath),
                method: method.toUpperCase() as HTTPMethod,
                [isMiddlewareFile ? "middleware" : "module"]: [
                  `${path.relative(baseDir, filepath)}:${exportName}`,
                ],
              };

              routeEntries.push(routeEntry);
            }
          }
        },
      });
    }
  });

  // Combine together any routes (index routes) which contain both a module and a middleware
  routeEntries = routeEntries.reduce(
    (acc: typeof routeEntries, { routePath, ...rest }) => {
      const existingRouteEntry = acc.find(
        (routeEntry) =>
          routeEntry.routePath === routePath &&
          routeEntry.method === rest.method
      );
      if (existingRouteEntry !== undefined) {
        Object.assign(existingRouteEntry, rest);
      } else {
        acc.push({ routePath, ...rest });
      }
      return acc;
    },
    []
  );

  routeEntries.sort((a, b) => compareRoutes(a, b));

  return {
    routes: routeEntries,
  };
}

// Ensure routes are produced in order of precedence so that
// more specific routes aren't occluded from matching due to
// less specific routes appearing first in the route list.
export function compareRoutes(
  { routePath: routePathA, method: methodA }: RouteConfig,
  { routePath: routePathB, method: methodB }: RouteConfig
) {
  function parseRoutePath(routePath: UrlPath): string[] {
    return routePath.slice(1).split("/").filter(Boolean);
  }

  const segmentsA = parseRoutePath(routePathA);
  const segmentsB = parseRoutePath(routePathB);

  // sort routes with fewer segments after those with more segments
  if (segmentsA.length !== segmentsB.length) {
    return segmentsB.length - segmentsA.length;
  }

  for (let i = 0; i < segmentsA.length; i++) {
    const isWildcardA = segmentsA[i].includes("*");
    const isWildcardB = segmentsB[i].includes("*");
    const isParamA = segmentsA[i].includes(":");
    const isParamB = segmentsB[i].includes(":");

    // sort wildcard segments after non-wildcard segments
    if (isWildcardA && !isWildcardB) return 1;
    if (!isWildcardA && isWildcardB) return -1;

    // sort dynamic param segments after non-param segments
    if (isParamA && !isParamB) return 1;
    if (!isParamA && isParamB) return -1;
  }

  // sort routes that specify an HTTP before those that don't
  if (methodA && !methodB) return -1;
  if (!methodA && methodB) return 1;

  // all else equal, just sort the paths lexicographically
  return routePathA.localeCompare(routePathB);
}

async function forEachFile<T>(
  baseDir: string,
  fn: (filepath: string) => T | Promise<T>
) {
  const searchPaths = [baseDir];
  const returnValues: T[] = [];

  while (isNotEmpty(searchPaths)) {
    const cwd = searchPaths.shift();
    const dir = await fs.readdir(cwd, { withFileTypes: true });
    for (const entry of dir) {
      const pathname = path.join(cwd, entry.name);
      if (entry.isDirectory()) {
        searchPaths.push(pathname);
      } else if (entry.isFile()) {
        returnValues.push(await fn(pathname));
      }
    }
  }

  return returnValues;
}

interface NonEmptyArray<T> extends Array<T> {
  shift(): T;
}
function isNotEmpty<T>(array: T[]): array is NonEmptyArray<T> {
  return array.length > 0;
}
