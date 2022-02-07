import { resolve } from "path";
import { build } from "esbuild";

type Options = {
  routesModule: string;
  outfile: string;
  minify?: boolean;
  sourcemap?: boolean;
  watch?: boolean;
  pluginName?: string;
  pluginAssetsDirectory?: string;
  onEnd?: () => void;
};

export function buildPlugin({
  routesModule,
  outfile = "bundle.js",
  minify = false,
  sourcemap = false,
  watch = false,
  pluginName,
  pluginAssetsDirectory,
  onEnd = () => {},
}: Options) {
  const entryPoint = resolve(
    __dirname,
    "../pages/functions/template-plugin.ts"
  );

  return build({
    entryPoints: [entryPoint],
    inject: [routesModule],
    bundle: true,
    format: "esm",
    target: "esnext",
    outfile,
    minify,
    sourcemap,
    watch,
    allowOverwrite: true,
    define: {
      __PLUGIN_NAME__: JSON.stringify(pluginName),
      __PLUGIN_ASSETS_DIRECTORY__: JSON.stringify(pluginAssetsDirectory),
    },
    plugins: [
      {
        name: "wrangler notifier and monitor",
        setup(pluginBuild) {
          pluginBuild.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error(
                `${result.errors.length} error(s) and ${result.warnings.length} warning(s) when compiling Worker.`
              );
            } else if (result.warnings.length > 0) {
              console.warn(
                `${result.warnings.length} warning(s) when compiling Worker.`
              );
              onEnd();
            } else {
              console.log("Compiled Worker successfully.");
              onEnd();
            }
          });
        },
      },
    ],
  });
}
