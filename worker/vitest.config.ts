import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { testLicenseKeys } from "./test/keys";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(__dirname, "../database/migrations"));
  const keys = await testLicenseKeys();
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            LICENSE_PUBLIC_KEY: keys.publicPem,
            TEST_LICENSE_PRIVATE_KEY: keys.privatePem,
            OWNER_BOOTSTRAP_TOKEN: "test-bootstrap-token",
            COOKIE_SECURE: "false",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.ts"] },
  };
});
