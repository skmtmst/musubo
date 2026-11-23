import { insertDisplayText, insertTokenSpecOf, isReservationVarKey, resolveDefaultToken, type InsertTokenNames, type InsertTokenSpec } from '@/components/shared/insert-tokens'

/*
 * 1対1のトークの差し込み。予約の3つは、相手の次の予約から値が入る（Worker の chat-reservation-variables）。
 * 札の名前を共通の札と同じにし、説明だけトークでの意味にする。保存・送信する値は {{var.…}} のまま。
 */
const RESERVATION_WORDS: ReadonlyArray<[key: string, what: string]> = [['reservation_datetime', '日時'], ['course_name', 'コース名'], ['guest_count', '人数']]

export const CHAT_INSERT_TOKENS: readonly InsertTokenSpec[] = RESERVATION_WORDS.map(([key, what]) => {
  const token = `{{var.${key}}}`
  const label = resolveDefaultToken(token)?.label ?? what
  return { token, label, hint: `この方の次の予約の${what}が入ります（予約情報から取得できないときは入りません）`, icon: 'braces' }
})

type Reason = 'reservation' | 'empty' | 'unregistered' | 'unknown' | 'missing'

/*
 * 口は入らなかった理由を返さないので、理由を言い切らない。予約は「無い」と言わない
 * （予約があっても種類によって人数などは取れない）。共通情報も空・期限切れ・外部（Google の営業時間など）の
 * 取得失敗を区別できない。
 */
const REASON_TEXT: Record<Reason, string> = {
  reservation: 'この方の予約情報から値を取得できないため',
  empty: '共通情報の値を取得できないため',
  unregistered: '共通情報に登録が無いため',
  unknown: '送るときに置き換えられない形のため',
  missing: '入る値が見つからないため',
}

function hasVar(names: InsertTokenNames, key: string): boolean {
  const vars = names.vars
  if (!vars) return false
  return vars instanceof Map ? vars.has(key) : Object.hasOwn(vars, key)
}

function reasonOf(name: string, spec: InsertTokenSpec, names: InsertTokenNames): Reason {
  const key = /^var\.([a-z][a-z0-9_]*)$/.exec(name.trim())?.[1]
  if (key && isReservationVarKey(key)) return 'reservation'
  if (key) return hasVar(names, key) ? 'empty' : names.varsComplete ? 'unregistered' : 'missing'
  return spec.unknown ? 'unknown' : 'missing'
}

/** 口が返した未解決の名前（{{ }} を除いた形）を、札の名前と理由に分ける。名前が同じものは1つにする。 */
export function unresolvedInserts(unresolved: readonly string[], names: InsertTokenNames): Array<{ label: string; reason: Reason }> {
  const seen = new Map<string, Reason>()
  for (const name of unresolved) {
    const spec = insertTokenSpecOf(name.trim(), names, CHAT_INSERT_TOKENS)
    if (!seen.has(spec.label)) seen.set(spec.label, reasonOf(name, spec, names))
  }
  return [...seen].map(([label, reason]) => ({ label, reason }))
}

export type UnresolvedNoticeContext = 'insert' | 'pack' | 'compose'

/**
 * 入らない差し込みの知らせ（何が・なぜ・どうすれば を2文で）。生の記号は出さず、札の名前で言う。
 * 予約の差し込みは口が実際に解決できなかった時だけ渡すこと（予約がある相手には入る）。
 */
export function unresolvedNoticeText(unresolved: readonly string[], names: InsertTokenNames, context: UnresolvedNoticeContext, templates: readonly string[] = []): string {
  const items = unresolvedInserts(unresolved, names)
  if (!items.length) return ''
  const groups = new Map<Reason, string[]>()
  for (const item of items) groups.set(item.reason, [...(groups.get(item.reason) ?? []), `「${item.label}」`])
  const what = [...groups].map(([reason, labels]) => `${labels.join('')}は${REASON_TEXT[reason]}`).join('、')
  const how = context === 'pack'
    ? `続けて送ると送信が止まるため、${templates.length ? templates.map((name) => `「${name}」`).join('') : 'このテンプレート'}を外すか、1通ずつ入力欄で直してください。`
    : context === 'insert'
      ? `${templates.length ? templates.map((name) => `「${name}」`).join('') + 'は' : ''}このまま入力欄に入れられますが、送る前にその部分を書き換えるか消してください。`
      : '送る前にその部分を書き換えるか消してください（このままでは送れません）。'
  return `${what}入りません。${how}`
}

/** 相手に合わせた値を確かめられなかった時の知らせ。確かめられないことを「問題なし」にしない。 */
export const PREVIEW_FAILED_TEXT = {
  insert: 'この方に入る値を確かめられませんでした。入力欄に入れたあと、送る前に「送るとこうなります」で確かめてください。',
  compose: '送ったときの見え方を確かめられませんでした。値が入らない差し込みがあると、送信の時点で止まります。',
} as const

/**
 * 送信口が差し込みの未解決で止めた時の文（送信を止める守りはそのまま）。名前が分かれば札の名前で、
 * 分からなくても生の記号は出さずに、何が・どうすれば を伝える。
 */
export function unresolvedSendFailureText(variables: readonly string[] = [], names: InsertTokenNames = {}): string {
  const labels = unresolvedInserts(variables, names).map((item) => `「${item.label}」`).join('')
  return `${labels ? `${labels}が` : '差し込みの値が'}入らないため、送りませんでした。その部分を書き換えるか消してから、送り直してください。`
}

/** 口の失敗文に差し込みの記号が混ざっていても、札の名前に置き換えて見せる。 */
export function withoutRawInserts(text: string, names: InsertTokenNames = {}): string {
  return text.includes('{{') ? insertDisplayText(text, { names, extra: CHAT_INSERT_TOKENS, markUnknown: true }) : text
}
