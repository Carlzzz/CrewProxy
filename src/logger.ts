export function isVerbose(): boolean {
  const raw = process.env.WOICLAW_PROXY_VERBOSE;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

function isoTimestamp(): string {
  return new Date().toISOString();
}

function formatParts(parts: readonly unknown[]): string {
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p instanceof Error) return p.stack ?? p.message;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
}

function line(level: string, message: string): string {
  return `[${isoTimestamp()}] [${level}] ${message}`;
}

export const logger = {
  info(...args: unknown[]): void {
    console.log(line('INFO', formatParts(args)));
  },

  warn(...args: unknown[]): void {
    console.warn(line('WARN', formatParts(args)));
  },

  error(...args: unknown[]): void {
    console.error(line('ERROR', formatParts(args)));
  },

  verbose(...args: unknown[]): void {
    if (!isVerbose()) return;
    console.log(line('VERBOSE', formatParts(args)));
  },
};

export default logger;
