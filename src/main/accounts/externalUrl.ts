const allowedHosts = new Set([
  'accounts.google.com', 'auth.openai.com', 'chatgpt.com',
  'claude.ai', 'console.anthropic.com', 'github.com'
])

export function validateExternalUrl(raw: string): URL {
  if (typeof raw === 'string' && /^https:\/\/[^/?#@]+/i.test(raw) && !/[\s\\\u0000-\u001f\u007f]/.test(raw)) {
    const url = URL.parse(raw)
    const authority = raw.slice(8).split(/[/?#]/, 1)[0]
    if (url?.protocol === 'https:' && !authority.includes('@') && !url.username && !url.password &&
      allowedHosts.has(url.hostname)) return url
  }
  throw new Error('不允许打开此链接。')
}
