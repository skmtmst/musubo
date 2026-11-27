/*
 * 見つからない画面に出す「よく使うページ」。左メニューと同じ行き先・同じ名前。
 * 受信箱・友だちは左メニューで必ず出る項目なので、いつも出す。
 * 一斉配信は任された人（staff）には権限があるときだけ出す（左メニューと同じ条件）。
 * 役割を読み終えるまでは出さない。最後の守りは行き先の画面とサーバ。
 */
export type FrequentDestination = { href: string; label: string }

const ALWAYS: FrequentDestination[] = [
  { href: '/chats', label: '受信箱' },
  { href: '/friends', label: '友だち' },
]

const BROADCASTS: FrequentDestination = { href: '/broadcasts', label: '一斉配信' }

export function frequentDestinations(
  role: string | null,
  permissionKeys: readonly string[],
  viewPermissionKeys: readonly string[],
): FrequentDestination[] {
  if (!role) return ALWAYS
  const canSeeBroadcasts = role !== 'staff'
    || permissionKeys.includes(BROADCASTS.href)
    || viewPermissionKeys.includes(BROADCASTS.href)
  return canSeeBroadcasts ? [...ALWAYS, BROADCASTS] : ALWAYS
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** 開けなかった URL の道（パス）だけ。クエリと # は秘密値が乗ることがあるので出さない。 */
export function missingPathLabel(pathname: string | null | undefined): string | null {
  if (!pathname) return null
  const raw = pathname.split(/[?#]/)[0]?.trim() ?? ''
  if (!raw || raw === '/') return null
  let decoded = raw
  try {
    decoded = decodeURI(raw)
  } catch {
    decoded = raw
  }
  const sanitized = decoded.replace(CONTROL_CHARS, '').trim()
  if (!sanitized || sanitized === '/') return null
  return sanitized
}
