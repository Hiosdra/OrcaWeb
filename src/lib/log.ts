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

export function logInfo(...args: unknown[]): void {
  console.info(`[${timestamp()}]`, ...args)
}

export function logWarn(...args: unknown[]): void {
  console.warn(`[${timestamp()}]`, ...args)
}

export function logError(...args: unknown[]): void {
  console.error(`[${timestamp()}]`, ...args)
}
