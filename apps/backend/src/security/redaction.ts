/** Paths censored from every log line, so credentials cannot reach the logs. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'apiKey',
  '*.apiKey',
];
