import { pino, type Logger } from 'pino';
import type { LogLevel } from './config.js';

export type { Logger };

/**
 * Structured JSON logger. Log ids only, never names, emails, bios or handles (invariant 7).
 * The redact list is a backstop for fields that should never reach a log line anyway.
 */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    redact: {
      paths: ['password', '*.password', 'name', '*.name', 'email', '*.email', 'bio', '*.bio'],
      censor: '[redacted]',
    },
  });
}
