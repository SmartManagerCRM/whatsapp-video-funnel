import type { Env as AppEnv } from "../src/env";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
      TEST_LICENSE_PRIVATE_KEY: string;
    }
  }
}
export {};
