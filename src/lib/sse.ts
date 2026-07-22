export type SseFrame = Readonly<{ value: string; rest: string }>

export function takeSseFrame(buffer: string): SseFrame | null {
  const separator = /\r?\n\r?\n/.exec(buffer)
  if (separator === null) return null

  return {
    value: buffer.slice(0, separator.index),
    rest: buffer.slice(separator.index + separator[0].length),
  }
}
