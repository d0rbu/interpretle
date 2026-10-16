import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  bf16ToHalf,
  floatToHalf,
  fp4ToHalf,
  halfToFloat,
  tokenOffsets,
} from './model-math'

describe('browser numeric conversion', () => {
  it('matches PyTorch FP4 restoration on measured checkpoint weights', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/fp4.json', 'utf8'))
    expect(Array.from(fp4ToHalf(new Uint8Array(fixture.packed)))).toEqual(
      fixture.expected,
    )
  })
  it('unpacks FP4 nibble order, sign, scales and subnormals', () => {
    const codes = Array.from({ length: 16 }, (_, i) => (i % 8) * 0x22 + 0x10)
    const packed = new Uint8Array([0, 0x3c, ...codes, 1, 0, ...codes])
    const levels = [
      0, 0.5, 1, 1.5, 2, 3, 4, 6, -0, -0.5, -1, -1.5, -2, -3, -4, -6,
    ]
    const expected = floatToHalf(
      new Float32Array([
        ...levels,
        ...levels,
        ...levels.map((v) => v * 2 ** -24),
        ...levels.map((v) => v * 2 ** -24),
      ]),
    )
    expect(fp4ToHalf(packed)).toEqual(expected)
    expect(() => fp4ToHalf(packed.subarray(1))).toThrow('block')
    expect(() => fp4ToHalf(new Uint8Array(18))).toThrow('scale')
  })
  it('converts every finite FP16 value through Float32 without changing bits', () => {
    const bits = Array.from({ length: 65536 }, (_, i) => i).filter(
      (i) => ((i >>> 10) & 31) !== 31,
    )
    const floats = new Float32Array(bits.map(halfToFloat))
    expect(Array.from(floatToHalf(floats))).toEqual(bits)
  })

  it('converts BF16 subnormals and ties with nearest-even rounding', () => {
    expect(
      Array.from(
        bf16ToHalf(
          new Uint16Array([
            0, 0x8000, 0x3f80, 0xbf80, 0x4000, 0x3300, 0x3301, 0x3380,
          ]),
        ),
      ),
    ).toEqual([0, 0x8000, 0x3c00, 0xbc00, 0x4000, 0, 1, 1])
    expect(() => bf16ToHalf(new Uint16Array([0x7f80]))).toThrow('range')
  })
})

describe('exact token spans', () => {
  it('maps normalized spaces, newlines, and UTF-16 surrogate pairs', () => {
    expect(tokenOffsets('A café 😁.', ['A', '▁café', '▁😁', '.'])).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 6 },
      { start: 6, end: 9 },
      { start: 9, end: 10 },
    ])
    expect(
      tokenOffsets(' two  spaces\nnext', [
        '▁two',
        '▁▁',
        'spaces',
        '\n',
        'next',
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 6 },
      { start: 6, end: 12 },
      { start: 12, end: 13 },
      { start: 13, end: 17 },
    ])
    expect(tokenOffsets('literal▁piece', ['literal', '▁piece'])).toEqual([
      { start: 0, end: 7 },
      { start: 7, end: 13 },
    ])
  })

  it('retains overlapping spans for byte-fallback tokens and rejects mismatches', () => {
    expect(
      tokenOffsets('😁', ['<0xF0>', '<0x9F>', '<0x98>', '<0x81>']),
    ).toEqual(Array.from({ length: 4 }, () => ({ start: 0, end: 2 })))
    expect(() => tokenOffsets('original', ['wrong'])).toThrow('align')
    expect(() => tokenOffsets('original', ['orig'])).toThrow('whole')
  })
})
