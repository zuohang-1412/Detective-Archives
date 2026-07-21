import { createHash, timingSafeEqual } from "node:crypto";

export type AdminCredentialValidator = (loginId: string, password: string) => boolean;

function hash(value: string) {
  return createHash("sha256").update(value).digest();
}

export function createAdminCredentialValidatorFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AdminCredentialValidator | undefined {
  const loginId = env.ADMIN_LOGIN_ID;
  const password = env.ADMIN_LOGIN_PASSWORD;
  if (!loginId && !password) return undefined;
  if (!loginId || !password) {
    throw new Error("ADMIN_LOGIN_ID and ADMIN_LOGIN_PASSWORD must be configured together");
  }
  if (env.NODE_ENV === "production" && password.length < 16) {
    throw new Error("ADMIN_LOGIN_PASSWORD must contain at least 16 characters in production");
  }
  const expectedLogin = hash(loginId);
  const expectedPassword = hash(password);
  return (candidateLogin, candidatePassword) => timingSafeEqual(hash(candidateLogin), expectedLogin)
    && timingSafeEqual(hash(candidatePassword), expectedPassword);
}
