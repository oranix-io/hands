/**
 * Unit tests for the ASC .p8 encryption helpers. The .p8 must round-trip
 * exactly (iTMSTransporter needs the byte-identical key), a wrong secret must
 * fail to decrypt, and each encryption must use a fresh IV.
 */

import { describe, it, expect } from "vitest";
import { encryptP8, decryptP8 } from "../src/lib/asc_credentials";

const SAMPLE_P8 = `-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg+sample+key+bytes+
here+and+more+base64+data==\n-----END PRIVATE KEY-----`;

describe("asc_credentials encryption", () => {
  it("round-trips the .p8 exactly", async () => {
    const secret = "test-enc-secret";
    const { ciphertext_b64, iv_b64 } = await encryptP8(SAMPLE_P8, secret);
    const back = await decryptP8(ciphertext_b64, iv_b64, secret);
    expect(back).toBe(SAMPLE_P8);
  });

  it("fails to decrypt with the wrong secret", async () => {
    const { ciphertext_b64, iv_b64 } = await encryptP8(SAMPLE_P8, "secret-a");
    await expect(decryptP8(ciphertext_b64, iv_b64, "secret-b")).rejects.toThrow();
  });

  it("uses a fresh IV per encryption (ciphertext differs)", async () => {
    const secret = "same-secret";
    const a = await encryptP8(SAMPLE_P8, secret);
    const b = await encryptP8(SAMPLE_P8, secret);
    expect(a.iv_b64).not.toBe(b.iv_b64);
    expect(a.ciphertext_b64).not.toBe(b.ciphertext_b64);
    // both still decrypt back to the same plaintext
    expect(await decryptP8(a.ciphertext_b64, a.iv_b64, secret)).toBe(SAMPLE_P8);
    expect(await decryptP8(b.ciphertext_b64, b.iv_b64, secret)).toBe(SAMPLE_P8);
  });

  it("throws when the encryption key is empty", async () => {
    await expect(encryptP8(SAMPLE_P8, "")).rejects.toThrow(/ASC_CRED_ENC_KEY/);
  });
});
