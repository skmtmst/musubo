/*
 * 記録を JSON で見せる・写すときの伏せ方。
 *
 * 口が返す記録は、送受信の本文・接続先URL・鍵をもともと含まない。画面がそれを
 * そのまま出すときも、名前で秘密値・個人情報と分かる項目と、値の形で鍵と分かる
 * 文字を、ここで必ず伏せてから整形する（口の形が変わっても画面から漏らさない）。
 */

export const REDACTED = '［伏せています］'

/** 秘密値（署名・トークン・Authorization など）と個人情報の項目の名前。 */
const SENSITIVE_KEY = /(secret|token|authorization|signature|passw(or)?d|api[-_]?key|cookie|credential|private[-_]?key|access[-_]?key|session|e-?mail|phone|tel$|address|line[-_]?user[-_]?id|display[-_]?name|real[-_]?name|url$|endpoint)/i

/** 値の形で鍵と分かる文字（Bearer の鍵・JWT）。 */
const BEARER = /^\s*(bearer|basic)\s+\S+/i
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/

const MAX_DEPTH = 20

function redactString(value: string): string {
  if (BEARER.test(value) || JWT.test(value)) return REDACTED
  // URL の問い合わせ部分には鍵が乗ることがあるので、道だけを残す。
  return value.replace(/(https?:\/\/[^\s?#"]*)[?#][^\s"]*/gi, `$1?${REDACTED}`)
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value
  if (seen.has(value)) return '［同じ記録を指しています］'
  if (depth >= MAX_DEPTH) return '［深すぎるので省きました］'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen) ?? null)
    const out: Record<string, unknown> = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) && item !== null && item !== undefined && item !== '' ? REDACTED : walk(item, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/** 秘密値・個人情報を伏せた写しを返す（元の値は変えない）。 */
export function redactLogRecord(value: unknown): unknown {
  return walk(value, 0, new WeakSet())
}

/** 伏せた後の値を、読みやすく字下げした JSON にする。 */
export function formatLogRecord(value: unknown): string {
  return JSON.stringify(redactLogRecord(value), null, 2) ?? 'null'
}
