/**
 * Consistent logging utility for the backend
 * Provides structured logging with consistent formatting
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

interface Logger {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
}

/**
 * Creates a logger instance with a specific prefix
 * @param prefix - The prefix to use for all log messages (e.g., '[Server]', '[TaskSpawner]')
 * @returns A logger instance with debug, info, warn, and error methods
 */
export function createLogger(prefix: string): Logger {
  const formatMessage = (level: LogLevel, message: string, context?: LogContext): string => {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `${timestamp} ${prefix} [${level.toUpperCase()}] ${message}${contextStr}`;
  };

  return {
    debug: (message: string, context?: LogContext) => {
      if (process.env.DEBUG) {
        console.log(formatMessage('debug', message, context));
      }
    },
    info: (message: string, context?: LogContext) => {
      console.log(formatMessage('info', message, context));
    },
    warn: (message: string, context?: LogContext) => {
      console.warn(formatMessage('warn', message, context));
    },
    error: (message: string, context?: LogContext) => {
      console.error(formatMessage('error', message, context));
    },
  };
}

/**
 * Simple log function for backward compatibility
 * @param prefix - The prefix for the log message
 * @param message - The message to log
 * @param context - Optional context object
 */
export function log(prefix: string, message: string, context?: LogContext): void {
  const contextStr = context ? ` ${JSON.stringify(context)}` : '';
  console.log(`${prefix} ${message}${contextStr}`);
}
