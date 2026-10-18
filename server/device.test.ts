import { expect, it } from 'vitest'
import { deviceInfo } from './device'

it.each([
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0.1',
    0,
    'Firefox 157.0.1',
    'macOS',
    'desktop',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
    5,
    'Chrome 141.0.7390.41',
    'iOS',
    'phone',
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15',
    5,
    'Safari 18.6',
    'iPadOS',
    'tablet',
  ],
  [
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
    5,
    'Chrome 140.0.0.0',
    'Android',
    'phone',
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.94',
    0,
    'Edge 140.0.3485.94',
    'Windows',
    'desktop',
  ],
  ['', 0, 'unknown', 'unknown', 'unknown'],
])(
  'recognizes reported device information for %s',
  (header, touches, browser, os, device) => {
    expect(deviceInfo(header as string, touches as number)).toMatchObject({
      browser,
      os,
      device,
    })
  },
)

it('bounds untrusted user-agent headers and does not invent hardware models', () => {
  const result = deviceInfo('x'.repeat(1000))
  expect(result.userAgent).toHaveLength(512)
  expect(result).toMatchObject({
    browser: 'unknown',
    os: 'unknown',
    device: 'unknown',
  })
})
