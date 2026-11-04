import pino from 'pino';

export function createGatewayLogger(destination = pino.destination({ sync: false })) {
  return pino({
    base: undefined,
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
  }, destination);
}
