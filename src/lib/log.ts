// Timestamped console logging. All log lines get a human-readable
// "[HH:MM:SS.mmm]" prefix in the browser's local timezone (no explicit
// timeZone is passed to toLocaleTimeString, so it falls back to the
// runtime's default — the user's own timezone in both the main thread and
// workers) so log order/timing can be reasoned about without cross-referencing
// performance.now() deltas by hand.
function timestamp(): string {
  const d = new Date()
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  time: string
  level: LogLevel
  message: string
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

// Ring buffer of recent log lines, kept in-memory per JS context (the main
// thread and the slicer worker each hold their own copy — this is a paste-
// into-a-bug-report aid, not a cross-thread aggregator). Capped so a
// pathological error storm can't leak memory in a long-running tab.
const HISTORY_LIMIT = 500
const history: LogEntry[] = []

function record(level: LogLevel, time: string, args: unknown[]): void {
  history.push({ time, level, message: args.map(formatArg).join(' ') })
  if (history.length > HISTORY_LIMIT) history.shift()
}

export function logDebug(...args: unknown[]): void {
  const time = timestamp()
  record('debug', time, args)
  console.debug(`[${time}]`, ...args)
}

export function logInfo(...args: unknown[]): void {
  const time = timestamp()
  record('info', time, args)
  console.info(`[${time}]`, ...args)
}

export function logWarn(...args: unknown[]): void {
  const time = timestamp()
  record('warn', time, args)
  console.warn(`[${time}]`, ...args)
}

export function logError(...args: unknown[]): void {
  const time = timestamp()
  record('error', time, args)
  console.error(`[${time}]`, ...args)
}

/**
 * Recent log lines from this context (oldest first), e.g. for pasting into a
 * user bug report — the app is client-side/WASM with no server-side
 * telemetry, so this is the only record of what led up to a failure.
 */
export function exportLogs(): string {
  return history.map((e) => `[${e.time}] ${e.level.toUpperCase().padEnd(5)} ${e.message}`).join('\n')
}
