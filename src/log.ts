// Structured logs. Only ids, counts and closed failure codes: never names or request bodies.
type Field = string | number | boolean | null;
export type LogFields = Record<string, Field>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function write(level: string, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const consoleLogger: Logger = {
  info: (e, f) => write('info', e, f),
  warn: (e, f) => write('warn', e, f),
  error: (e, f) => write('error', e, f),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
