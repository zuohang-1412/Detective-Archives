import type { LoggerOptions } from "pino";

export function createLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.code",
        "req.body.password",
        "request.headers.authorization",
        "request.headers.cookie",
        "request.body.code",
        "request.body.password",
        "headers.authorization",
        "headers.cookie",
        "body.code",
        "body.password",
        "body.token",
        "credentials.appSecret",
        "credentials.password",
        "session.token",
        "session.refreshToken",
        "err.config.password",
        "err.connectionParameters.password",
        "accessToken",
        "appSecret",
        "password",
        "refreshToken",
        "token"
      ],
      censor: "[REDACTED]"
    }
  };
}
