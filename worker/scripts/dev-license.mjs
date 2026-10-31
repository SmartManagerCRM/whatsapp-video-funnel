#!/usr/bin/env node
// DEVELOPMENT-ONLY license tool (Node). Production licenses are issued by the Windows
// "SmartManager License Generator" with a production key that never touches this repo or Cloudflare.
//
//   node scripts/dev-license.mjs init                       create .dev-keys/ and put the public key in .dev.vars
//   node scripts/dev-license.mjs issue <tenant-id> <slug> "<Client Name>" [--limited-days N] [--renews LICENSE_ID] [--transfer-from LICENSE_ID]
//     default: LIFETIME (never expires). --limited-days N makes a LIMITED license valid for N days.
//     --renews LICENSE_ID extends/upgrades that tenant's LIMITED license (use with --limited-days, or alone to upgrade to LIFETIME).
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../.dev-keys/", import.meta.url);
const b64u = (b) => Buffer.from(b).toString("base64url");
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "init") {
  mkdirSync(dir, { recursive: true });
  if (existsSync(new URL("private.pem", dir))) { console.log("keys already exist in .dev-keys/"); process.exit(0); }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const pub = publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(new URL("private.pem", dir), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(new URL("public.pem", dir), pub);
  const vars = new URL("../.dev.vars", import.meta.url);
  const prev = existsSync(vars) ? readFileSync(vars, "utf8").split("\n").filter((l) => !l.startsWith("LICENSE_PUBLIC_KEY=")).join("\n") : "";
  writeFileSync(vars, `${prev.trimEnd()}\nLICENSE_PUBLIC_KEY="${pub.replace(/\n/g, "\\n")}"\n`);
  console.log("Dev keys created in worker/.dev-keys/ (git-ignored). Public key written to .dev.vars.");
} else if (cmd === "issue") {
  const [tenantId, slug, client, ...rest] = args;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const transferFrom = opt("--transfer-from"), renews = opt("--renews"), limitedDays = opt("--limited-days");
  if (!tenantId || !slug || !client) { console.error('usage: issue <tenant-id> <slug> "<Client Name>" [--limited-days N] [--renews ID] [--transfer-from ID]'); process.exit(1); }
  const payload = {
    lid: `lic_${randomUUID().replace(/-/g, "").slice(0, 16)}`, pid: "smartmanager-whatsapp-video-funnel", product_name: "SmartManager WhatsApp Video Funnel",
    client_name: client, tenant_id: tenantId, tenant_slug: slug, iat: Math.floor(Date.now() / 1000), type: "LIFETIME",
    features: ["video-funnel", "coexistence"], max_numbers: 1, ...(transferFrom ? { transfer_from: transferFrom } : {}), ...(renews ? { renews } : {}),
  };
  if (limitedDays) { payload.type = "LIMITED"; payload.exp = payload.iat + Math.round(Number(limitedDays) * 86400); }
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "SMLIC" }));
  const body = b64u(JSON.stringify(payload));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(readFileSync(new URL("private.pem", dir)));
  const token = `${head}.${body}.${b64u(sig)}`;
  const out = new URL(`../.dev-keys/${slug}.smlic`, import.meta.url);
  writeFileSync(out, JSON.stringify({ format: "smlic/1", token }, null, 2));
  console.log(`License ${payload.lid} written to ${out.pathname}\n${token}`);
} else { console.error("commands: init | issue"); process.exit(1); }
