import pino from 'pino';
import pretty from 'pino-pretty';

export function formatLogText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, character =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function formatFields(value, path) {
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => formatFields(child, `${path}.${formatLogText(key)}`));
  }
  if (path.endsWith('.stack') && typeof value === 'string') {
    return [`  ${path}:`, ...value.split(/\r?\n/).map(line => `    ${formatLogText(line)}`)];
  }
  return [`  ${path}: ${formatLogText(value)}`];
}

export function createGatewayLogger(destination = pino.destination({ sync: false })) {
  return pino({
    base: undefined,
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
    singleLine: false,
    hideObject: true,
    errorLikeObjectKeys: [],
    messageFormat(log, messageKey) {
      const fields = Object.entries(log)
        .filter(([key]) => !['level', 'time', messageKey].includes(key))
        .flatMap(([key, value]) => formatFields(value, formatLogText(key)));
      return [log[messageKey] ?? '', ...fields].join('\n');
    },
  }));
}
