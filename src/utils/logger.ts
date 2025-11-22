/**
 * Simple logger utility
 */
class Logger {
  private context: string;

  constructor(context: string = 'App') {
    this.context = context;
  }

  private formatMessage(level: string, message: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    const argsStr = args.length > 0 ? ' ' + JSON.stringify(args) : '';
    return `[${timestamp}] [${level}] [${this.context}] ${message}${argsStr}`;
  }

  info(message: string, ...args: unknown[]): void {
    console.log(this.formatMessage('INFO', message, ...args));
  }

  error(message: string, ...args: unknown[]): void {
    console.error(this.formatMessage('ERROR', message, ...args));
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(this.formatMessage('WARN', message, ...args));
  }

  debug(message: string, ...args: unknown[]): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(this.formatMessage('DEBUG', message, ...args));
    }
  }

  createScope(scope: string): Logger {
    return new Logger(`${this.context}:${scope}`);
  }
}

export const logger = new Logger();
