// Reported browser information, used only for diagnostics, never feature gates.
export function deviceInfo(header: string | null, touchPoints = 0) {
  const userAgent = (header ?? '').slice(0, 512)
  const ipad =
    /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)
  const os = ipad
    ? 'iPadOS'
    : /iPhone|iPod/.test(userAgent)
      ? 'iOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /CrOS/.test(userAgent)
            ? 'ChromeOS'
            : /Macintosh/.test(userAgent)
              ? 'macOS'
              : /Linux/.test(userAgent)
                ? 'Linux'
                : 'unknown'
  const device =
    ipad || (/Android/.test(userAgent) && !/Mobile/.test(userAgent))
      ? 'tablet'
      : /iPhone|iPod|Mobile/.test(userAgent)
        ? 'phone'
        : os !== 'unknown'
          ? 'desktop'
          : 'unknown'
  let browser = 'unknown'
  for (const [name, pattern] of [
    ['Edge', /Edg(?:A|iOS)?\/(\d+(?:\.\d+){0,3})/],
    ['Opera', /OPR\/(\d+(?:\.\d+){0,3})/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+(?:\.\d+){0,3})/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+(?:\.\d+){0,3})/],
    ['Safari', /Version\/(\d+(?:\.\d+){0,3}).*Safari/],
  ] as const) {
    const version = pattern.exec(userAgent)?.[1]
    if (version) {
      browser = `${name} ${version}`
      break
    }
  }
  return { browser, os, device, userAgent }
}
