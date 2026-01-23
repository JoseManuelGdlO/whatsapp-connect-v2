import type { PrismaClient, LogLevel } from '@prisma/client';

export type LoggerService = 'api' | 'worker';

export interface LogContext {
  tenantId?: string;
  deviceId?: string;
  metadata?: Record<string, any>;
}

export class DatabaseLogger {
  constructor(
    private prisma: PrismaClient,
    private service: LoggerService,
    private defaultContext?: LogContext
  ) {}

  private async log(
    level: LogLevel,
    message: string,
    error?: Error | string,
    context?: LogContext
  ): Promise<void> {
    // Always log to console for immediate visibility
    const consoleMethod = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    const prefix = `[${this.service}] [${level}]`;
    if (error) {
      consoleMethod(`${prefix} ${message}`, error);
    } else {
      consoleMethod(`${prefix} ${message}`);
    }

    // Only save ERROR level to database to avoid saturating it
    if (level !== 'ERROR') {
      return;
    }

    try {
      const mergedContext = { ...this.defaultContext, ...context };
      const errorMessage = error instanceof Error ? error.message : error;
      const errorStack = error instanceof Error ? error.stack : undefined;

      await this.prisma.log.create({
        data: {
          level,
          service: this.service,
          message,
          error: errorStack || errorMessage || undefined,
          metadata: mergedContext.metadata ? (mergedContext.metadata as any) : undefined,
          tenantId: mergedContext.tenantId || undefined,
          deviceId: mergedContext.deviceId || undefined
        }
      });
    } catch (logError) {
      // Fallback to console if DB logging fails
      console.error(`[${this.service}] Failed to write log to database:`, logError);
      console.error(`[${this.service}] Original log: [${level}] ${message}`, error);
    }
  }

  async debug(message: string, context?: LogContext): Promise<void> {
    await this.log('DEBUG', message, undefined, context);
  }

  async info(message: string, context?: LogContext): Promise<void> {
    await this.log('INFO', message, undefined, context);
  }

  async warn(message: string, error?: Error | string, context?: LogContext): Promise<void> {
    await this.log('WARN', message, error, context);
  }

  async error(message: string, error: Error | string, context?: LogContext): Promise<void> {
    await this.log('ERROR', message, error, context);
  }

  // Convenience method for try-catch blocks
  async captureError(error: unknown, message?: string, context?: LogContext): Promise<void> {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const errorMessage = message || errorObj.message || 'Unhandled error';
    await this.error(errorMessage, errorObj, context);
  }
}

// Factory function to create a logger instance
export function createLogger(
  prisma: PrismaClient,
  service: LoggerService,
  defaultContext?: LogContext
): DatabaseLogger {
  return new DatabaseLogger(prisma, service, defaultContext);
}
