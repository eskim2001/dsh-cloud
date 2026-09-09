/** 把 UA 粗略归成「浏览器 · 系统」。专有名词不翻译；认不出就返回空串，由调用方兜底。 */
export function describeUserAgent(ua: string | null): string {
  if (ua === null || ua === '') return ''

  const browser = matchFirst(ua, [
    // Edg/ 的 UA 里也含 Chrome，必须排在前面
    [/Edg[A-Z]?\//, 'Edge'],
    [/OPR\/|Opera/, 'Opera'],
    [/Firefox\//, 'Firefox'],
    [/CriOS\//, 'Chrome'],
    [/Chrome\//, 'Chrome'],
    [/Safari\//, 'Safari'],
  ])
  const os = matchFirst(ua, [
    [/Windows/, 'Windows'],
    [/Android/, 'Android'],
    [/iPhone|iPad|iPod/, 'iOS'],
    [/Mac OS X|Macintosh/, 'macOS'],
    [/Linux/, 'Linux'],
  ])

  return [browser, os].filter((part) => part !== '').join(' · ')
}

function matchFirst(input: string, rules: [RegExp, string][]): string {
  for (const [pattern, name] of rules) {
    if (pattern.test(input)) return name
  }
  return ''
}
