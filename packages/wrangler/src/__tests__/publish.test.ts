import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import { setMockResponse, unsetAllMocks } from "./helpers/mock-cfetch";
import { mockConsoleMethods } from "./helpers/mock-console";
import { mockKeyListRequest } from "./helpers/mock-kv";
import { runInTempDir } from "./helpers/run-in-tmp";
import { runWrangler } from "./helpers/run-wrangler";
import writeWranglerToml from "./helpers/write-wrangler-toml";
import type { WorkerMetadata } from "../api/form_data";
import type { KVNamespaceInfo } from "../kv";
import type { FormData, File } from "undici";

describe("publish", () => {
  beforeEach(() => {
    // @ts-expect-error we're using a very simple setTimeout mock here
    jest.spyOn(global, "setTimeout").mockImplementation((fn, _period) => {
      fn();
    });
  });
  mockAccountId();
  mockApiToken();
  runInTempDir();
  const std = mockConsoleMethods();

  afterEach(() => {
    unsetAllMocks();
  });

  it("should resolve wrangler.toml relative to the entrypoint", async () => {
    fs.mkdirSync("./some-path/worker", { recursive: true });
    fs.writeFileSync(
      "./some-path/wrangler.toml",
      TOML.stringify({
        name: "test-name",
        compatibility_date: "2022-01-12",
        vars: { xyz: 123 },
      }),
      "utf-8"
    );
    writeWorkerSource({ basePath: "./some-path/worker" });
    mockUploadWorkerRequest({
      expectedBindings: [
        {
          json: 123,
          name: "xyz",
          type: "json",
        },
      ],
    });
    mockSubDomainRequest();
    await runWrangler("publish ./some-path/worker/index.js");
    expect(std.out).toMatchInlineSnapshot(`
      "Uploaded
      test-name
      (TIMINGS)
      Deployed
      test-name
      (TIMINGS)

      test-name.test-sub-domain.workers.dev"
    `);
    expect(std.err).toMatchInlineSnapshot(`""`);
  });

  describe("entry-points", () => {
    it("should be able to use `index` with no extension as the entry-point (esm)", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest({ expectedType: "esm" });
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to use `index` with no extension as the entry-point (sw)", async () => {
      writeWranglerToml();
      writeWorkerSource({ type: "sw" });
      mockUploadWorkerRequest({ expectedType: "sw" });
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to use the `build.upload.main` config as the entry-point for ESM sources", async () => {
      writeWranglerToml({ build: { upload: { main: "./index.js" } } });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `build.upload.main` relative to the wrangler.toml not cwd", async () => {
      writeWranglerToml({
        build: {
          upload: {
            main: "./foo/index.js",
          },
        },
      });
      writeWorkerSource({ basePath: "foo" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();
      process.chdir("foo");
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `build.upload.main` relative to `build.upload.dir` if format is `modules`", async () => {
      writeWranglerToml({
        build: {
          upload: {
            format: "modules",
            main: "./index.js",
            dir: "./foo",
          },
        },
      });
      writeWorkerSource({ basePath: "./foo" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();
      process.chdir("foo");
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to transpile TypeScript (esm)", async () => {
      writeWranglerToml();
      writeWorkerSource({ format: "ts" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();
      await runWrangler("publish index.ts");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to transpile TypeScript (sw)", async () => {
      writeWranglerToml();
      writeWorkerSource({ format: "ts", type: "sw" });
      mockUploadWorkerRequest({
        expectedEntry: "var foo = 100;",
        expectedType: "sw",
      });
      mockSubDomainRequest();
      await runWrangler("publish index.ts");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should inline referenced text modules into the worker", async () => {
      writeWranglerToml();
      fs.writeFileSync(
        "./index.js",
        `
import txt from './textfile.txt';
export default{
  fetch(){
    return new Response(txt);
  }
}
`
      );
      fs.writeFileSync("./textfile.txt", "Hello, World!");
      mockUploadWorkerRequest({ expectedEntry: "Hello, World!" });
      mockSubDomainRequest();
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to transpile entry-points in sub-directories (esm)", async () => {
      writeWranglerToml();
      writeWorkerSource({ basePath: "./src" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();

      await runWrangler("publish ./src/index.js");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to transpile entry-points in sub-directories (sw)", async () => {
      writeWranglerToml();
      writeWorkerSource({ basePath: "./src", type: "sw" });
      mockUploadWorkerRequest({
        expectedEntry: "var foo = 100;",
        expectedType: "sw",
      });
      mockSubDomainRequest();

      await runWrangler("publish ./src/index.js");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it('should error if a site definition doesn\'t have a "bucket" field', async () => {
      writeWranglerToml({
        // @ts-expect-error we're purposely missing the required `site.bucket` field
        site: {
          "entry-point": "./index.js",
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await expect(
        runWrangler("publish ./index.js")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"A [site] definition requires a \`bucket\` field with a path to the site's public directory."`
      );

      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`
        "A [site] definition requires a \`bucket\` field with a path to the site's public directory.

        [32m%s[0m
        If you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new."
      `);
      expect(std.warn).toMatchInlineSnapshot(`
        "Deprecation notice: The \`site.entry-point\` config field is no longer used.
        The entry-point should be specified via the command line (e.g. \`wrangler publish path/to/script\`) or the \`build.upload.main\` config field.
        Please remove the \`site.entry-point\` field from the \`wrangler.toml\` file."
      `);
    });

    it("should warn if there is a `site.entry-point` configuration", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };

      writeWranglerToml({
        site: {
          "entry-point": "./index.js",
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);

      await runWrangler("publish ./index.js");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        reading assets/file-2.txt...
        uploading as assets/file-2.5938485188.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "Deprecation notice: The \`site.entry-point\` config field is no longer used.
        The entry-point should be specified via the command line (e.g. \`wrangler publish path/to/script\`) or the \`build.upload.main\` config field.
        Please remove the \`site.entry-point\` field from the \`wrangler.toml\` file."
      `);
    });

    it("should error if there is no entry-point specified", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      await expect(
        runWrangler("publish")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Missing entry-point: The entry-point should be specified via the command line (e.g. \`wrangler publish path/to/script\`) or the \`build.upload.main\` config field."`
      );

      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`
        "Missing entry-point: The entry-point should be specified via the command line (e.g. \`wrangler publish path/to/script\`) or the \`build.upload.main\` config field.

        [32m%s[0m
        If you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new."
      `);
    });
  });

  describe("asset upload", () => {
    it("should upload all the files in the directory specified by `config.site.bucket`", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        reading assets/file-2.txt...
        uploading as assets/file-2.5938485188.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("when using a service worker type, it should inline an asset manifest, and bind to a namespace", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource({ type: "sw" });
      writeAssets(assets);
      mockUploadWorkerRequest({
        expectedType: "sw",
        expectedEntry: `const __STATIC_CONTENT_MANIFEST = {"file-1.txt":"assets/file-1.2ca234f380.txt","file-2.txt":"assets/file-2.5938485188.txt"};`,
        expectedBindings: [
          {
            name: "__STATIC_CONTENT",
            namespace_id: "__test-name-workers_sites_assets-id",
            type: "kv_namespace",
          },
        ],
      });
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        reading assets/file-2.txt...
        uploading as assets/file-2.5938485188.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("when using a module worker type, it should add an asset manifest module, and bind to a namespace", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource({ type: "esm" });
      writeAssets(assets);
      mockUploadWorkerRequest({
        expectedBindings: [
          {
            name: "__STATIC_CONTENT",
            namespace_id: "__test-name-workers_sites_assets-id",
            type: "kv_namespace",
          },
        ],
        expectedModules: {
          __STATIC_CONTENT_MANIFEST:
            '{"file-1.txt":"assets/file-1.2ca234f380.txt","file-2.txt":"assets/file-2.5938485188.txt"}',
        },
      });
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        reading assets/file-2.txt...
        uploading as assets/file-2.5938485188.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should make environment specific kv namespace for assets", async () => {
      // This is the same test as the one before this, but with an env arg
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-some-env-workers_sites_assets",
        id: "__test-name-some-env-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest({
        env: "some-env",
        expectedBindings: [
          {
            name: "__STATIC_CONTENT",
            namespace_id: "__test-name-some-env-workers_sites_assets-id",
            type: "kv_namespace",
          },
        ],
      });
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);
      await runWrangler("publish --env some-env");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        reading assets/file-2.txt...
        uploading as assets/file-2.5938485188.txt...
        Uploaded
        test-name (some-env)
        (TIMINGS)
        Deployed
        test-name (some-env)
        (TIMINGS)

        some-env.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should only upload files that are not already in the KV namespace", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      // Put file-1 in the KV namespace
      mockKeyListRequest(kvNamespace.id, ["assets/file-1.2ca234f380.txt"]);
      // Check we do not upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath !== "assets/file-1.txt")
      );
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        skipping - already uploaded
        reading assets/file-2.txt...
        uploading as assets/file-2.5938485188.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should only upload files that match the `site-include` arg", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish --site-include file-1.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should not upload files that match the `site-exclude` arg", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish --site-exclude file-2.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should only upload files that match the `site.include` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
          include: ["file-1.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should not upload files that match the `site.exclude` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
          exclude: ["file-2.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `site-include` arg over `site.include` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
          include: ["file-2.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish --site-include file-1.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `site-exclude` arg over `site.exclude` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
          exclude: ["assets/file-1.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath.endsWith("assets/file-1.txt"))
      );
      await runWrangler("publish --site-exclude file-2.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/file-1.txt...
        uploading as assets/file-1.2ca234f380.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should walk directories except node_modules", async () => {
      const assets = [
        {
          filePath: "assets/directory-1/file-1.txt",
          content: "Content of file-1",
        },
        {
          filePath: "assets/node_modules/file-2.txt",
          content: "Content of file-2",
        },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Only expect file-1 to be uploaded
      mockUploadAssetsToKVRequest(kvNamespace.id, assets.slice(0, 1));
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/directory-1/file-1.txt...
        uploading as assets/directory-1/file-1.2ca234f380.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should skip hidden files and directories except `.well-known`", async () => {
      const assets = [
        {
          filePath: "assets/.hidden-file.txt",
          content: "Content of hidden-file",
        },
        {
          filePath: "assets/.hidden/file-1.txt",
          content: "Content of file-1",
        },
        {
          filePath: "assets/.well-known/file-2.txt",
          content: "Content of file-2",
        },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Only expect file-2 to be uploaded
      mockUploadAssetsToKVRequest(kvNamespace.id, assets.slice(2));
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/.well-known/file-2.txt...
        uploading as assets/.well-known/file-2.5938485188.txt...
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should error if the asset is over 25Mb", async () => {
      const assets = [
        {
          filePath: "assets/large-file.txt",
          // This file is greater than 25MiB when base64 encoded but small enough to be uploaded.
          content: "X".repeat(25 * 1024 * 1024 * 0.8 + 1),
        },
        {
          filePath: "assets/too-large-file.txt",
          content: "X".repeat(25 * 1024 * 1024 + 1),
        },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
          exclude: ["assets/file-1.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);

      await expect(
        runWrangler("publish")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"File assets/too-large-file.txt is too big, it should be under 25 MiB. See https://developers.cloudflare.com/workers/platform/limits#kv-limits"`
      );

      expect(std.out).toMatchInlineSnapshot(`
        "reading assets/large-file.txt...
        uploading as assets/large-file.0ea0637a45.txt..."
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "File assets/too-large-file.txt is too big, it should be under 25 MiB. See https://developers.cloudflare.com/workers/platform/limits#kv-limits

        [32m%s[0m
        If you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new."
      `);
    });

    it("should error if the asset key is over 512 characters", async () => {
      const longFilePathAsset = {
        filePath: "assets/" + "folder/".repeat(100) + "file.txt",
        content: "content of file",
      };
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        build: { upload: { main: "./index.js" } },
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets([longFilePathAsset]);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);

      await expect(
        runWrangler("publish")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"The asset path key \\"assets/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.3da0d0cd12.txt\\" exceeds the maximum key size limit of 512. See https://developers.cloudflare.com/workers/platform/limits#kv-limits\\","`
      );

      expect(std.out).toMatchInlineSnapshot(
        `"reading assets/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.txt..."`
      );
      expect(std.err).toMatchInlineSnapshot(`
        "The asset path key \\"assets/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.3da0d0cd12.txt\\" exceeds the maximum key size limit of 512. See https://developers.cloudflare.com/workers/platform/limits#kv-limits\\",

        [32m%s[0m
        If you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new."
      `);
    });
  });

  describe("workers_dev setting", () => {
    it("should deploy to a workers.dev domain if workers_dev is undefined", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should deploy to the workers.dev domain if workers_dev is `true`", async () => {
      writeWranglerToml({
        workers_dev: true,
      });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should disable the workers.dev domain if workers_dev is `false`", async () => {
      writeWranglerToml({
        workers_dev: false,
      });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: false });

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        No deployment targets for
        test-name
        (TIMINGS)"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should enable the workers.dev domain if workers_dev is undefined and subdomain is not already available", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest({ available_on_subdomain: false });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true });

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should enable the workers.dev domain if workers_dev is true and subdomain is not already available", async () => {
      writeWranglerToml({ workers_dev: true });
      writeWorkerSource();
      mockUploadWorkerRequest({ available_on_subdomain: false });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true });

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("custom builds", () => {
    beforeEach(() => {
      // @ts-expect-error disable the mock we'd setup earlier
      // or else custom builds will timeout immediately
      global.setTimeout.mockRestore();
    });
    it("should run a custom build before publishing", async () => {
      writeWranglerToml({
        build: {
          command: `node -e "console.log('custom build'); require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')"`,
        },
      });

      mockUploadWorkerRequest({
        expectedEntry: "return new Response(123)",
      });
      mockSubDomainRequest();

      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "running:
        node -e \\"console.log('custom build'); require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')\\"
        Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    if (process.platform !== "win32") {
      it("should run a custom build of multiple steps combined by && before publishing", async () => {
        writeWranglerToml({
          build: {
            command: `echo "custom build" && echo "export default { fetch(){ return new Response(123) } }" > index.js`,
          },
        });

        mockUploadWorkerRequest({
          expectedEntry: "return new Response(123)",
        });
        mockSubDomainRequest();

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
          "running:
          echo \\"custom build\\" && echo \\"export default { fetch(){ return new Response(123) } }\\" > index.js
          Uploaded
          test-name
          (TIMINGS)
          Deployed
          test-name
          (TIMINGS)

          test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    }
  });

  describe("[wasm_modules]", () => {
    it("should be able to define wasm modules for service-worker format workers", async () => {
      writeWranglerToml({
        wasm_modules: {
          TESTWASMNAME: "./path/to/test.wasm",
        },
      });
      writeWorkerSource({ type: "sw" });
      fs.mkdirSync("./path/to", { recursive: true });
      fs.writeFileSync("./path/to/test.wasm", "SOME WASM CONTENT");
      mockUploadWorkerRequest({
        expectedType: "sw",
        expectedModules: { TESTWASMNAME: "SOME WASM CONTENT" },
        expectedBindings: [
          { name: "TESTWASMNAME", part: "TESTWASMNAME", type: "wasm_module" },
        ],
      });
      mockSubDomainRequest();
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should error when defining wasm modules for modules format workers", async () => {
      writeWranglerToml({
        wasm_modules: {
          TESTWASMNAME: "./path/to/test.wasm",
        },
      });
      writeWorkerSource({ type: "esm" });
      fs.mkdirSync("./path/to", { recursive: true });
      fs.writeFileSync("./path/to/test.wasm", "SOME WASM CONTENT");

      await expect(
        runWrangler("publish index.js")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"You cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code"`
      );
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`
        "You cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code

        [32m%s[0m
        If you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new."
      `);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should resolve wasm modules relative to the wrangler.toml file", async () => {
      fs.mkdirSync("./path/to/and/the/path/to/", { recursive: true });
      fs.writeFileSync(
        "./path/to/wrangler.toml",
        TOML.stringify({
          compatibility_date: "2022-01-12",
          name: "test-name",
          wasm_modules: {
            TESTWASMNAME: "./and/the/path/to/test.wasm",
          },
        }),

        "utf-8"
      );

      writeWorkerSource({ type: "sw" });
      fs.writeFileSync(
        "./path/to/and/the/path/to/test.wasm",
        "SOME WASM CONTENT"
      );
      mockUploadWorkerRequest({
        expectedType: "sw",
        expectedModules: { TESTWASMNAME: "SOME WASM CONTENT" },
        expectedBindings: [
          { name: "TESTWASMNAME", part: "TESTWASMNAME", type: "wasm_module" },
        ],
      });
      mockSubDomainRequest();
      await runWrangler("publish index.js --config ./path/to/wrangler.toml");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should be able to import .wasm modules from service-worker format workers", async () => {
      writeWranglerToml();
      fs.writeFileSync("./index.js", "import TESTWASMNAME from './test.wasm';");
      fs.writeFileSync("./test.wasm", "SOME WASM CONTENT");
      mockUploadWorkerRequest({
        expectedType: "sw",
        expectedModules: {
          __94b240d0d692281e6467aa42043986e5c7eea034_test_wasm:
            "SOME WASM CONTENT",
        },
        expectedBindings: [
          {
            name: "__94b240d0d692281e6467aa42043986e5c7eea034_test_wasm",
            part: "__94b240d0d692281e6467aa42043986e5c7eea034_test_wasm",
            type: "wasm_module",
          },
        ],
      });
      mockSubDomainRequest();
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });
  });

  describe("vars bindings", () => {
    it("should support json bindings", async () => {
      writeWranglerToml({
        vars: {
          text: "plain ol' string",
          count: 1,
          complex: { enabled: true, id: 123 },
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedBindings: [
          { name: "text", type: "plain_text", text: "plain ol' string" },
          { name: "count", type: "json", json: 1 },
          {
            name: "complex",
            type: "json",
            json: { enabled: true, id: 123 },
          },
        ],
      });

      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });
  });

  describe("r2 bucket bindings", () => {
    it("should support r2 bucket bindings", async () => {
      writeWranglerToml({
        r2_buckets: [{ binding: "FOO", bucket_name: "foo-bucket" }],
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedBindings: [
          { bucket_name: "foo-bucket", name: "FOO", type: "r2_bucket" },
        ],
      });

      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });
  });

  describe("unsafe bindings", () => {
    it("should warn if using unsafe bindings", async () => {
      writeWranglerToml({
        unsafe: {
          bindings: [
            {
              name: "my-binding",
              type: "binding-type",
              param: "binding-param",
            },
          ],
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedBindings: [
          {
            name: "my-binding",
            type: "binding-type",
            param: "binding-param",
          },
        ],
      });

      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(
        `"'unsafe' fields are experimental and may change or break at any time."`
      );
    });
    it("should warn if using unsafe bindings already handled by wrangler", async () => {
      writeWranglerToml({
        unsafe: {
          bindings: [
            {
              name: "my-binding",
              type: "plain_text",
              text: "text",
            },
          ],
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedBindings: [
          {
            name: "my-binding",
            type: "plain_text",
            text: "text",
          },
        ],
      });

      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded
        test-name
        (TIMINGS)
        Deployed
        test-name
        (TIMINGS)

        test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "'unsafe' fields are experimental and may change or break at any time.
        Raw 'plain_text' bindings are not directly supported by wrangler. Consider migrating to a format for 'plain_text' bindings that is supported by wrangler for optimal support: https://developers.cloudflare.com/workers/cli-wrangler/configuration"
      `);
    });
  });
});

/** Write a mock Worker script to disk. */
function writeWorkerSource({
  basePath = ".",
  format = "js",
  type = "esm",
}: {
  basePath?: string;
  format?: "js" | "ts" | "jsx" | "tsx" | "mjs";
  type?: "esm" | "sw";
} = {}) {
  if (basePath !== ".") {
    fs.mkdirSync(basePath, { recursive: true });
  }
  fs.writeFileSync(
    `${basePath}/index.${format}`,
    type === "esm"
      ? `import { foo } from "./another";
      export default {
        async fetch(request) {
          return new Response('Hello' + foo);
        },
      };`
      : `import { foo } from "./another";
      addEventListener('fetch', event => {
        event.respondWith(new Response('Hello' + foo));
      })`
  );
  fs.writeFileSync(`${basePath}/another.${format}`, `export const foo = 100;`);
}

/** Write mock assets to the file system so they can be uploaded. */
function writeAssets(assets: { filePath: string; content: string }[]) {
  for (const asset of assets) {
    fs.mkdirSync(path.dirname(asset.filePath), { recursive: true });
    fs.writeFileSync(asset.filePath, asset.content);
  }
}

/** Create a mock handler for the request to upload a worker script. */
function mockUploadWorkerRequest({
  available_on_subdomain = true,
  expectedEntry,
  expectedType = "esm",
  expectedBindings,
  expectedModules = {},
  env = undefined,
}: {
  available_on_subdomain?: boolean;
  expectedEntry?: string;
  expectedType?: "esm" | "sw";
  expectedBindings?: unknown;
  expectedModules?: Record<string, string>;
  env?: string | undefined;
} = {}) {
  setMockResponse(
    env
      ? `/accounts/:accountId/workers/services/:scriptName/environments/:envName`
      : "/accounts/:accountId/workers/scripts/:scriptName",
    "PUT",
    async ([_url, accountId, scriptName], { body }, queryParams) => {
      expect(accountId).toEqual("some-account-id");
      expect(scriptName).toEqual("test-name");
      expect(queryParams.get("available_on_subdomain")).toEqual("true");
      const formBody = body as FormData;
      if (expectedEntry !== undefined) {
        expect(await (formBody.get("index.js") as File).text()).toMatch(
          expectedEntry
        );
      }

      const metadata = JSON.parse(
        formBody.get("metadata") as string
      ) as WorkerMetadata;
      if (expectedType === "esm") {
        expect(metadata.main_module).toEqual("index.js");
      } else {
        expect(metadata.body_part).toEqual("index.js");
      }
      if (expectedBindings !== undefined) {
        expect(metadata.bindings).toEqual(expectedBindings);
      }
      for (const [name, content] of Object.entries(expectedModules)) {
        expect(await (formBody.get(name) as File).text()).toMatch(content);
      }

      return { available_on_subdomain };
    }
  );
}

/** Create a mock handler for the request to get the account's subdomain. */
function mockSubDomainRequest(subdomain = "test-sub-domain") {
  setMockResponse("/accounts/:accountId/workers/subdomain", "GET", () => {
    return { subdomain };
  });
}

function mockUpdateWorkerRequest({
  env,
  enabled,
}: {
  env?: string | undefined;
  enabled: boolean;
}) {
  const requests = { count: 0 };
  const servicesOrScripts = env ? "services" : "scripts";
  const environment = env ? "/environments/:envName" : "";
  setMockResponse(
    `/accounts/:accountId/workers/${servicesOrScripts}/:scriptName${environment}/subdomain`,
    "POST",
    (_, { body }) => {
      expect(JSON.parse(body as string)).toEqual({ enabled });
      return null;
    }
  );
  return requests;
}

/** Create a mock handler for the request to get a list of all KV namespaces. */
function mockListKVNamespacesRequest(...namespaces: KVNamespaceInfo[]) {
  setMockResponse(
    "/accounts/:accountId/storage/kv/namespaces",
    "GET",
    ([_url, accountId]) => {
      expect(accountId).toEqual("some-account-id");
      return namespaces;
    }
  );
}

/** Create a mock handler for the request that tries to do a bulk upload of assets to a KV namespace. */
function mockUploadAssetsToKVRequest(
  expectedNamespaceId: string,
  assets: { filePath: string; content: string }[]
) {
  setMockResponse(
    "/accounts/:accountId/storage/kv/namespaces/:namespaceId/bulk",
    "PUT",
    ([_url, accountId, namespaceId], { body }) => {
      expect(accountId).toEqual("some-account-id");
      expect(namespaceId).toEqual(expectedNamespaceId);
      const uploads = JSON.parse(body as string);
      expect(assets.length).toEqual(uploads.length);
      for (let i = 0; i < uploads.length; i++) {
        const asset = assets[i];
        const upload = uploads[i];
        // The asset key consists of:
        // - the basename of the filepath
        // - some hash value
        // - the extension
        const keyMatcher = new RegExp(
          "^" +
            asset.filePath
              .replace(/(\.[^.]+)$/, ".[a-z0-9]+$1")
              .replace(/\./g, "\\.")
        );
        expect(upload.key).toMatch(keyMatcher);
        // The asset value is base64 encoded.
        expect(upload.base64).toBe(true);
        expect(Buffer.from(upload.value, "base64").toString()).toEqual(
          asset.content
        );
      }
      return null;
    }
  );
}
