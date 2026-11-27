/**
 * 写真審査で `<img src>` に入れる前の検査。
 *
 * 値が汚染されると危険なURLが実行されうる。書込経路はWorkerが作るURLだが、
 * 画面側でも防御する。許可するのは次の3通り。
 * - `https:`（R2など保管先の公開URL）
 * - `http:`（手元の確認用サーバ）
 * - `data:image/`（画面確認用の作り物SVG）
 * - `/` 始まり（同一サーバ内の相対パス）
 *
 * だめな値は `null` を返す。呼び出し側は代わりの表示を出す。
 */
export function safePhotoSrc(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  const src = value.trim()
  if (!src) return null
  if (src.startsWith('/')) {
    if (src.startsWith('//') || src.startsWith('/\\')) return null
    return src
  }
  const lower = src.toLowerCase()
  // `https:evil.example.com/x` のように `//` がない偽装やホスト欠落は通さない。
  if (lower.startsWith('https://')) {
    try {
      const parsed = new URL(src)
      return parsed.protocol === 'https:' && parsed.hostname.length > 0 ? src : null
    } catch {
      return null
    }
  }
  if (lower.startsWith('http://')) {
    try {
      const host = new URL(src).hostname.toLowerCase()
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return src
    } catch {
      return null
    }
    return null
  }
  if (lower.startsWith('data:image/')) return src
  return null
}
