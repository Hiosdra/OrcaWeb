import type { GcodeStats } from '../types'

// OrcaSlicer writes its summary comments in the file header (total layer
// number) and the trailing stats block (filament used, estimated printing
// time). Scan only the head and tail so a multi-hundred-MB G-code string
// never goes through the regexes whole. The stats block sits *above* the
// trailing CONFIG_BLOCK echo, which grows with the profile (a full vendor
// machine profile pushes the stats hundreds of KB from EOF) — hence the
// generous tail window.
const HEAD_WINDOW = 64 * 1024
const TAIL_WINDOW = 1024 * 1024

export function extractGcodeStats(gcode: string): GcodeStats {
  const scan =
    gcode.length > HEAD_WINDOW + TAIL_WINDOW ? `${gcode.slice(0, HEAD_WINDOW)}\n${gcode.slice(-TAIL_WINDOW)}` : gcode

  const stats: GcodeStats = {}

  // The engine emits one of several phrasings depending on config:
  //   "; model printing time: 28m 4s; total estimated time: 28m 6s"
  //   "; estimated printing time (normal mode) = 1h 2m 5s"
  // ("; estimated first layer printing time ..." must NOT match — it's the
  // first layer only, not the whole print.)
  const time =
    scan.match(/;\s*total estimated time:\s*([^;\n]+)/i)?.[1]?.trim() ??
    scan.match(/;\s*model printing time:\s*([^;\n]+)/i)?.[1]?.trim() ??
    scan.match(/^;\s*estimated printing time[^=\n]*=\s*(.+)$/im)?.[1]?.trim()
  if (time) stats.printTime = time

  const layers = scan.match(/;\s*total layer number:\s*(\d+)/i)?.[1]
  if (layers) stats.layers = parseInt(layers, 10)

  const mm = scan.match(/;\s*filament used \[mm\]\s*=\s*([\d.]+)/i)?.[1]
  if (mm) stats.filamentMm = parseFloat(mm)

  const g = scan.match(/;\s*filament used \[g\]\s*=\s*([\d.]+)/i)?.[1]
  if (g) stats.filamentG = parseFloat(g)

  return stats
}

/** Compact "1h 2m 5s · 12.3 g · 253 layers" label for result cards. */
export function gcodeStatsLabel(stats: GcodeStats): string {
  const parts: string[] = []
  if (stats.printTime) parts.push(stats.printTime)
  if (stats.filamentG != null && stats.filamentG > 0) parts.push(`${stats.filamentG.toFixed(1)} g`)
  else if (stats.filamentMm != null && stats.filamentMm > 0) parts.push(`${(stats.filamentMm / 1000).toFixed(2)} m`)
  if (stats.layers != null) parts.push(`${stats.layers} layers`)
  return parts.join(' · ')
}
