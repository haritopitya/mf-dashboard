import * as OTPAuth from "otpauth";
import { debug, error } from "../logger.js";

interface Credentials {
  username: string;
  password: string;
}

export async function getCredentials(): Promise<Credentials> {
  const username = process.env.MF_USERNAME;
  const password = process.env.MF_PASSWORD;

  if (!username || !password) {
    error("MF_USERNAME / MF_PASSWORD が設定されていません");
    process.exit(1);
  }

  return { username, password };
}

export async function getOTP(): Promise<string> {
  const secret = process.env.MF_TOTP_SECRET;

  if (!secret) {
    throw new Error("MF_TOTP_SECRET が設定されていません");
  }

  debug("TOTP を生成しています...");
  // Money Forwardのセットアップキーは4文字区切りの空白を含むことがある
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret.replace(/\s+/g, "").toUpperCase()),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

  return totp.generate();
}
