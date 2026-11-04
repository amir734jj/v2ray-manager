import pino from 'pino';
import pretty from 'pino-pretty';

export function createGatewayLogger(destination = pino.destination({ sync: false })) {
  return pino({
    base: undefined,
    // Pino-pretty always expands the configured errorKey; log errors under `err` instead.
    errorKey: 'error',
    redact: {
      paths: [
        'headers.authorization',
        'headers["proxy-authorization"]',
        'headers.cookie',
        'headers["set-cookie"]',
        'headers["x-api-key"]',
        'headers["cf-access-jwt-assertion"]',
      ],
      censor: '[REDACTED]',
    },
  }, pretty({
    destination,
    colorize: false,
    translateTime: 'UTC:HH:MM:ss',
    singleLine: true,
    errorLikeObjectKeys: [],
  }));
}
