import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("serves health", async () => {
    const res = await (exports as any).default.fetch(new Request("https://x.test/healthz"));
    expect(res.status).toBe(200);
  });
  it("has migrated schema", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'conversations'").first();
    expect(r).toBeTruthy();
  });
});
