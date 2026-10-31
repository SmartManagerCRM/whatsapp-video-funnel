// Development/test RSA key pair, generated on the fly. NEVER a production key.
import { generateKeyPairSync } from "node:crypto";

let cached: { publicPem: string; privatePem: string } | null = null;
export async function testLicenseKeys() {
  if (!cached) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    cached = {
      publicPem: publicKey.export({ type: "spki", format: "pem" }) as string,
      privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    };
  }
  return cached;
}
