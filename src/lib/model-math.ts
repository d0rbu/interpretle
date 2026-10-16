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
