import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { decryptPayload, encryptPayload } from "./surepass-crypto";
import { SurepassEncryptedClient } from "./surepass-client";

test("encrypts and decrypts payloads", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicPem = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const input = JSON.stringify({ pan_number: "FNMPM6342D" });
  const encrypted = encryptPayload(input, publicPem);
  const decrypted = decryptPayload(encrypted.encrypted, privatePem);
  assert.equal(decrypted, input);
});

test("surepass sandbox pan verification", async (t) => {
  const required = [
    "SUREPASS_CLIENT_ID",
    "SUREPASS_API_TOKEN",
    "SUREPASS_PUBLIC_KEY",
    "SUREPASS_CLIENT_PRIVATE_KEY",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    t.skip(`Missing env vars: ${missing.join(", ")}`);
    return;
  }
  const client = SurepassEncryptedClient.fromEnv();
  const response = await client.postJson("/api/v1/pan/pan", { pan_number: "FNMPM6342D" });
  assert.equal(response.success, true);
});
