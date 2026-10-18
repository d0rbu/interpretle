/** The pinned tokenizer only replaces ASCII spaces with U+2581. Map its bytes
 * back to UTF-16 spans; byte-fallback tokens may overlap the same character. */
export function tokenOffsets(text: string, tokens: string[]) {
  const encoder = new TextEncoder()
  const bytes: number[] = []
  const positions: { start: number; end: number }[] = []
  let position = 0
  for (const character of text) {
    const encoded = encoder.encode(character === ' ' ? '▁' : character)
    for (const byte of encoded) {
      bytes.push(byte)
      positions.push({ start: position, end: position + character.length })
    }
    position += character.length
  }
  let cursor = 0
  const result = tokens.map((token) => {
    const fallback = /^<0x([0-9A-F]{2})>$/.exec(token)
    const encoded = fallback
      ? [parseInt(fallback[1], 16)]
      : encoder.encode(token)
    const start = cursor
    for (const byte of encoded) {
      if (bytes[cursor++] !== byte)
        throw new Error(
          'The tokenizer could not align this text. No attempt was used.',
        )
    }
    if (cursor === start || !positions[cursor - 1])
      throw new Error('Invalid tokenizer offsets.')
    return { start: positions[start].start, end: positions[cursor - 1].end }
  })
  if (cursor !== bytes.length)
    throw new Error('The tokenizer did not cover the whole sentence.')
  return result
}

/** BF16 checkpoint -> FP16 runtime, matching torch.Tensor.half(). */
export function bf16ToHalf(values: Uint16Array): Uint16Array {
  const result = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const value = values[i],
      sign = value & 0x8000
    const exponent = (value >>> 7) & 255,
      fraction = value & 127
    if (exponent >= 143)
      throw new Error('A model weight is outside the supported FP16 range.')
    if (exponent >= 113)
      result[i] = sign | ((exponent - 112) << 10) | (fraction << 3)
    else if (exponent < 102) result[i] = sign
    else {
      const scaled = (128 + fraction) * 2 ** (exponent - 110)
      const lower = Math.floor(scaled),
        remainder = scaled - lower
      result[i] =
        sign |
        (lower +
          (remainder > 0.5 || (remainder === 0.5 && lower % 2 === 1) ? 1 : 0))
    }
  }
  return result
}

export function halfToFloat(value: number): number {
  const sign = value & 0x8000 ? -1 : 1
  const exponent = (value >>> 10) & 31,
    fraction = value & 1023
  return (
    sign *
    (exponent === 0
      ? fraction * 2 ** -24
      : exponent === 31
        ? fraction
          ? NaN
          : Infinity
        : (1 + fraction / 1024) * 2 ** (exponent - 15))
  )
}

let halfTable: Float32Array | undefined

/** Restore CPU tensors without repeating exponent arithmetic for every weight. */
export function halfToFloat32(bits: Uint16Array): Float32Array {
  halfTable ??= Float32Array.from({ length: 65536 }, (_, i) => halfToFloat(i))
  const result = new Float32Array(bits.length)
  for (let i = 0; i < bits.length; i++) result[i] = halfTable[bits[i]]
  return result
}

export function floatToHalf(values: Float32Array): Uint16Array {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length)
  const result = new Uint16Array(values.length)
  for (let i = 0; i < bits.length; i++) {
    const value = bits[i],
      sign = (value >>> 16) & 0x8000
    const exponent = ((value >>> 23) & 255) - 112,
      fraction = value & 0x7fffff
    if (exponent > 30)
      throw new Error('A model weight is outside the supported FP16 range.')
    if (exponent < -10) result[i] = sign
    else if (exponent <= 0) {
      const mantissa = fraction | 0x800000,
        shift = 14 - exponent
      result[i] =
        sign |
        ((mantissa + (2 ** (shift - 1) - 1) + ((mantissa >>> shift) & 1)) >>>
          shift)
    } else
      result[i] =
        sign |
        ((exponent << 10) +
          ((fraction + 0xfff + ((fraction >>> 13) & 1)) >>> 13))
  }
  return result
}

export function weightToHalf(bytes: Uint8Array, dtype: string) {
  if (dtype === 'FP4') return fp4ToHalf(bytes)
  if (dtype === 'BF16')
    return bf16ToHalf(
      new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    )
  if (dtype === 'F16')
    return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  if (dtype === 'F32')
    return floatToHalf(
      new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    )
  throw new Error(`Unsupported model weight type: ${dtype}.`)
}

const fp4Tables: (Uint32Array | undefined)[] = []

/** E2M1 blocks: FP16 scale, then 32 four-bit values (low nibble first).
 * Reuse each scale's byte-to-FP16-pair table across tensors and guesses. */
export function fp4ToHalf(bytes: Uint8Array): Uint16Array {
  if (bytes.length % 18) throw new Error('Invalid FP4 model block.')
  const result = new Uint16Array((bytes.length / 18) * 32)
  const pairs = new Uint32Array(result.buffer)
  const levels = [0, 0.5, 1, 1.5, 2, 3, 4, 6]
  let output = 0
  for (let start = 0; start < bytes.length; start += 18) {
    const bits = bytes[start] | (bytes[start + 1] << 8)
    let table = fp4Tables[bits]
    if (!table) {
      const scale = halfToFloat(bits)
      if (!(scale > 0) || !Number.isFinite(scale))
        throw new Error('Invalid FP4 model scale.')
      const positive = floatToHalf(
        new Float32Array(levels.map((v) => v * scale)),
      )
      const values = new Uint16Array(16)
      values.set(positive)
      for (let i = 0; i < 8; i++) values[i + 8] = positive[i] | 0x8000
      table = new Uint32Array(256)
      // Use a shared view so the pair copy also works on either byte order.
      const halves = new Uint16Array(table.buffer)
      for (let i = 0; i < 256; i++) {
        halves[2 * i] = values[i & 15]
        halves[2 * i + 1] = values[i >>> 4]
      }
      fp4Tables[bits] = table
    }
    for (let i = start + 2; i < start + 18; i++)
      pairs[output++] = table[bytes[i]]
  }
  return result
}
