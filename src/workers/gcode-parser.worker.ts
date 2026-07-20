import { parseGcode } from '../lib/gcode-parse'

self.onmessage = ({ data: { id, gcode } }: MessageEvent<{ id: number; gcode: string }>) => {
  const result = parseGcode(gcode)
  const transfers: Transferable[] = []
  for (const layer of result.layers) {
    for (const feature of layer.features) transfers.push(feature.segments.buffer as ArrayBuffer)
    transfers.push(layer.travels.buffer as ArrayBuffer)
  }
  self.postMessage({ id, result }, transfers)
}
