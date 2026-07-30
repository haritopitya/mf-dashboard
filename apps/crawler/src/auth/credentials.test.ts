import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { getCredentials, getOTP } from "./credentials.js";

// Mock process.exit
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

// RFC 6238のテストベクター("12345678901234567890"のBase32表現)
const RFC6238_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("credentials", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      MF_USERNAME: "test-user@example.com",
      MF_PASSWORD: "test-password",
      MF_TOTP_SECRET: RFC6238_SECRET,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  describe("getCredentials", () => {
    test("returns credentials from environment variables", async () => {
      const result = await getCredentials();

      expect(result).toEqual({
        username: "test-user@example.com",
        password: "test-password",
      });
    });

    test("exits when MF_USERNAME is not set", async () => {
      delete process.env.MF_USERNAME;

      await expect(getCredentials()).rejects.toThrow("process.exit called");
    });

    test("exits when MF_PASSWORD is not set", async () => {
      delete process.env.MF_PASSWORD;

      await expect(getCredentials()).rejects.toThrow("process.exit called");
    });
  });

  describe("getOTP", () => {
    test("generates the RFC 6238 test vector code", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(59 * 1000));

      const result = await getOTP();

      expect(result).toBe("287082");
    });

    test("accepts secrets containing spaces and lowercase letters", async () => {
      process.env.MF_TOTP_SECRET = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq";
      vi.useFakeTimers();
      vi.setSystemTime(new Date(59 * 1000));

      const result = await getOTP();

      expect(result).toBe("287082");
    });

    test("generates a 6-digit code", async () => {
      const result = await getOTP();

      expect(result).toMatch(/^\d{6}$/);
    });

    test("throws error when MF_TOTP_SECRET is not set", async () => {
      delete process.env.MF_TOTP_SECRET;

      await expect(getOTP()).rejects.toThrow("MF_TOTP_SECRET が設定されていません");
    });
  });
});
