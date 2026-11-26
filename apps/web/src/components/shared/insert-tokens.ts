/*
 * 本文の差し込み（{{name}} など）を、本文の欄で「札」として見せるための読み取り。
 * 保存する値は今までどおりの文字（{{name}} など）。ここは見せ方だけを決める。
 *
 * 札にするのは、送るときに本当に置き換わる形だけ（名前・配信日・友だち情報・
 * 共通情報・LIFF ID・目標日までの日数）。分からない {{…}} は文字のまま残す
 * （札にすると「置き換わる」と誤解させるため）。生の記号を見せない画面だけ、
 * `markUnknown` で「不明な差し込み」の札（置き換わらない色）にする。
 * 画面ごとに意味が違う差し込み（リマインダの {{date}}＝予約日時、統括の {店名} など）は
 * 画面から `extra` で渡す。`extra` が先に勝つ。
 */
import { TEMPLATE_SAMPLE_VARIABLE_LABELS } from '@line-crm/shared'

export type InsertTokenIcon = 'user' | 'calendar' | 'idcard' | 'braces' | 'phone' | 'clock' | 'video' | 'store' | 'link' | 'help'

export interface InsertTokenSpec {
  /** 本文に入る文字（保存する値）。 */
  token: string
  /** 札の文字。 */
  label: string
  /** 札に乗せたときの説明（何に置き換わるか）。 */
  hint: string
  icon: InsertTokenIcon
  /** 送るときに置き換えられない形（名前の分からない {{…}}）。札の色を変えて伝える。 */
  unknown?: boolean
}

/** 友だち情報・共通情報の名前（キー → 画面の名前）。分からなければ情報の種類だけを見せる。 */
export interface InsertTokenNames {
  fields?: ReadonlyMap<string, string> | Record<string, string>
  vars?: ReadonlyMap<string, string> | Record<string, string>
  /**
   * `vars` がそのアカウントの共通情報を読み終えた全部の一覧か。true のときだけ、
   * 一覧に無いキーを「名前なし」と言い切る（読込中・失敗は種類の名前だけにする）。
   */
  varsComplete?: boolean
  /** 登録はあるが、今は送っても値が入らないと分かる共通情報（キー → 理由。「停止中の」など「ため」の前の言葉）。 */
  unavailableVars?: ReadonlyMap<string, string>
}

/** 共通情報の一覧の1件のうち、差し込みに答えられるかを決める分。 */
export interface CommonVarAvailability {
  varKey: string
  status?: 'draft' | 'active' | 'stopped'
  value?: string | null
  validFrom?: string | null
  validUntil?: string | null
  fallbackValue?: string | null
  expiryBehavior?: 'stop' | 'fallback'
}

/* 空の値を送らない共通情報（Worker の共通情報の解決と同じ）。 */
const NON_BLANK_VAR_KEYS = new Set(['store_phone', 'reservation_url'])
/* 値だけは画面で分からない共通情報（営業時間は Google から入ることがある）。状態・期間は送信側が先に断る。 */
const EXTERNAL_VALUE_VAR_KEYS = new Set(['business_hours'])

/**
 * 今、送っても値が入らないと分かる理由（Worker の共通情報の解決と同じ順：状態 → 期間・代わりの値 → 値）。
 * 状態・期間・代わりの値の欄が無い・外から値が入る共通情報の値など、分からないときは null（言い切らない）。
 */
export function commonVarUnavailableReason(item: CommonVarAvailability, now = Date.now()): string | null {
  if (item.status === 'stopped') return '停止中の'
  if (item.status === 'draft') return '下書きの'
  const from = item.validFrom ? Date.parse(item.validFrom) : null
  const until = item.validUntil ? Date.parse(item.validUntil) : null
  const usable = (text: string | null | undefined) => typeof text === 'string' && (!NON_BLANK_VAR_KEYS.has(item.varKey) || text.trim() !== '')
  const invalid = (from !== null && !Number.isFinite(from)) || (until !== null && !Number.isFinite(until)) || (from !== null && until !== null && from >= until)
  const before = !invalid && from !== null && now < from
  const expired = !invalid && until !== null && now >= until
  if (!invalid && !before && !expired) return item.value === undefined || EXTERNAL_VALUE_VAR_KEYS.has(item.varKey) || usable(item.value) ? null : '値が空の'
  if (item.expiryBehavior === undefined) return null
  if (item.expiryBehavior === 'fallback' && usable(item.fallbackValue)) return null
  return invalid ? '期間の設定が正しくない' : before ? '開始前の' : '期限が切れている'
}

/** 生の記号を見せない画面の口。省略時は今までどおり、分からない {{…}} を文字で残す。 */
export interface InsertTokenOptions {
  markUnknown?: boolean
}

/** 共通情報に名前が無い差し込みの札。 */
export const UNNAMED_VAR_LABEL = '共通情報（名前なし）'
/** 送るときに置き換えられない {{…}} の札。 */
export const UNKNOWN_TOKEN_LABEL = '不明な差し込み'

/*
 * テンプレートの見本が使う共通情報の名前（Worker と同じ表）。共通情報に登録が無くても、
 * 見本から作った本文の差し込みをこの名前で示す。登録した共通情報に同じキーがあれば登録の名前が勝つ。
 * 表の `name`・`account.name` は共通情報ではない差し込みなので、共通情報の名前には使わない。
 */
const SAMPLE_VAR_NAMES = new Map<string, string>(
  Object.entries(TEMPLATE_SAMPLE_VARIABLE_LABELS).filter(([key]) => key !== 'name' && /^[a-z][a-z0-9_]*$/.test(key)),
)

/* 1対1のトークでは、相手の次の予約から値を入れる共通情報のキー（Worker の chat-reservation-variables と同じ）。 */
const RESERVATION_VAR_KEYS = new Set(['reservation_datetime', 'course_name', 'guest_count'])

/** 予約の情報が入る共通情報のキーか（var. を除いた名前）。 */
export function isReservationVarKey(key: string): boolean {
  return RESERVATION_VAR_KEYS.has(key)
}

/** 見本の名前を持つ共通情報のキーか（登録が無くても名前で示せる）。 */
export function sampleVarName(key: string): string | undefined {
  return SAMPLE_VAR_NAMES.get(key)
}

const DATE_HINTS: Record<string, string> = {
  '': '8月20日(木)',
  ymd_w: '2026年8月20日(木)',
  md: '8月20日',
  ymd: '2026年8月20日',
  slash_md_w: '8/20(木)',
  slash_ymd_w: '2026/8/20(木)',
  slash_md: '8/20',
  slash_ymd: '2026/8/20',
}

/* 一覧はアプリの保存値から作るので、`constructor` などの組み込みの名前を拾わない。 */
function lookup(names: InsertTokenNames['fields'], key: string): string | undefined {
  if (!names) return undefined
  const found = names instanceof Map ? names.get(key) : Object.hasOwn(names, key) ? (names as Record<string, string>)[key] : undefined
  return typeof found === 'string' && found ? found : undefined
}

/** {{…}} の中身から札を決める。札にしないものは null。 */
export function resolveDefaultToken(token: string, names: InsertTokenNames = {}): InsertTokenSpec | null {
  const inner = /^\{\{\s*([^{}\n]+?)\s*\}\}$/.exec(token)?.[1]
  if (!inner) return null
  if (inner === 'account.name') return { token, label: 'LINE公式アカウント名', hint: '送信するLINE公式アカウントの名前に置き換わります', icon: 'store' }
  if (inner === 'name') return { token, label: '名前', hint: '受け取る人の名前に置き換わります', icon: 'user' }
  if (inner === 'liff_id') return { token, label: 'LIFF ID', hint: 'LIFF ID に置き換わります', icon: 'phone' }
  const date = /^date(?::([a-z_]+))?$/.exec(inner)
  if (date) {
    const example = DATE_HINTS[date[1] ?? '']
    if (example === undefined) return null
    return { token, label: '配信日', hint: `配信日（例：${example}）に置き換わります`, icon: 'calendar' }
  }
  const after = /^date\+(\d{1,3})$/.exec(inner)
  if (after) return { token, label: `配信日の${after[1]}日後`, hint: `配信日の${after[1]}日後の日付に置き換わります`, icon: 'calendar' }
  const until = /^days_until:(\d{4})-(\d{2})-(\d{2})$/.exec(inner)
  if (until) {
    const day = `${Number(until[1])}/${Number(until[2])}/${Number(until[3])}`
    return { token, label: `${day}まで`, hint: `${day}までの日数に置き換わります（過ぎた日は0）`, icon: 'clock' }
  }
  const field = /^field\.([a-z][a-z0-9_]*)$/.exec(inner)
  if (field) {
    const name = lookup(names.fields, field[1])
    return { token, label: name ?? '友だち情報', hint: name ? `友だち情報「${name}」の値に置き換わります` : '友だち情報の値に置き換わります', icon: 'idcard' }
  }
  const commonVar = /^var\.([a-z][a-z0-9_]*)$/.exec(inner)
  if (commonVar) {
    const name = lookup(names.vars, commonVar[1])
    const unavailable = names.unavailableVars?.get(commonVar[1])
    if (name) return { token, label: name, hint: unavailable ? `共通情報「${name}」は${unavailable}ため、今は値が入りません` : `共通情報「${name}」の値に置き換わります`, icon: 'braces' }
    const sample = SAMPLE_VAR_NAMES.get(commonVar[1])
    if (sample) return { token, label: sample, hint: names.varsComplete && !isReservationVarKey(commonVar[1]) ? `共通情報に「${sample}」の登録が無いため、送るときに値が入りません` : `「${sample}」の値に置き換わります`, icon: 'braces' }
    if (names.varsComplete) return { token, label: UNNAMED_VAR_LABEL, hint: '共通情報に登録が無いため、送るときに値が入りません', icon: 'braces' }
    return { token, label: '共通情報', hint: '共通情報の値に置き換わります', icon: 'braces' }
  }
  return null
}

/** 置き換えられない {{…}}（中身が空の {{}} は差し込みではないので除く）。 */
function unknownToken(token: string): InsertTokenSpec | null {
  if (!/^\{\{[^{}\n]*[^{}\s][^{}\n]*\}\}$/.test(token)) return null
  return { token, label: UNKNOWN_TOKEN_LABEL, hint: '送るときに置き換えられない差し込みです。消すか書き換えてください', icon: 'help', unknown: true }
}

export type InsertPiece =
  | { kind: 'text'; text: string }
  /** `resolved` は相手に合わせて入った値の札（文字は値そのもの）。 */
  | { kind: 'chip'; spec: InsertTokenSpec; resolved?: boolean }
  /** 相手に合わせても値が入らなかった差し込み。 */
  | { kind: 'missing'; spec: InsertTokenSpec }

type ChipPiece = Extract<InsertPiece, { kind: 'chip' }>

/**
 * 本文を「文字」と「札」の並びに分ける。並びをつなぐと元の本文に戻る
 * （文字は1文字も足さない・引かない）。
 */
export function splitInsertTokens(value: string, extra: readonly InsertTokenSpec[] = [], names: InsertTokenNames = {}, options: InsertTokenOptions = {}): InsertPiece[] {
  const pieces: InsertPiece[] = []
  const exact = [...extra].sort((a, b) => b.token.length - a.token.length)
  let text = ''
  let index = 0
  const flush = () => {
    if (text) pieces.push({ kind: 'text', text })
    text = ''
  }
  while (index < value.length) {
    const rest = value.slice(index)
    const own = exact.find((spec) => rest.startsWith(spec.token))
    if (own) {
      flush()
      pieces.push({ kind: 'chip', spec: own })
      index += own.token.length
      continue
    }
    if (rest.startsWith('{{')) {
      const candidate = /^\{\{[^{}\n]*\}\}/.exec(rest)?.[0]
      const spec = candidate ? resolveDefaultToken(candidate, names) ?? (options.markUnknown ? unknownToken(candidate) : null) : null
      if (candidate && spec) {
        flush()
        pieces.push({ kind: 'chip', spec })
        index += candidate.length
        continue
      }
    }
    text += value[index]
    index += 1
  }
  flush()
  return pieces
}

/** 友だち情報・共通情報の一覧から、札の名前の表を作る。今は値が入らないと分かる共通情報も添える。 */
export function referenceTokenNames(references: {
  friendFields: ReadonlyArray<{ fieldKey: string; name: string }>
  commonVars: ReadonlyArray<{ varKey: string; name: string } & Partial<Omit<CommonVarAvailability, 'varKey'>>>
}, now = Date.now()): InsertTokenNames {
  const unavailable = new Map<string, string>()
  for (const item of references.commonVars) {
    const reason = commonVarUnavailableReason(item, now)
    if (reason) unavailable.set(item.varKey, reason)
  }
  return {
    fields: Object.fromEntries(references.friendFields.map((field) => [field.fieldKey, field.name])),
    vars: Object.fromEntries(references.commonVars.map((item) => [item.varKey, item.name])),
    ...(unavailable.size ? { unavailableVars: unavailable } : {}),
  }
}

/** 入った値の中に残った差し込みは、値に見せず「入らない」に分ける（記号を見せない）。 */
function valuePieces(specs: InsertTokenSpec[], value: string, extra: readonly InsertTokenSpec[], names: InsertTokenNames, options: InsertTokenOptions): InsertPiece[] {
  if (!specs.length) return value ? markMissing(splitInsertTokens(value, extra, names, options)) : []
  if (value.includes('{{')) return markMissing(splitInsertTokens(value, extra, names, options))
  return [{ kind: 'chip', resolved: true, spec: { ...specs[0], token: specs.map((spec) => spec.token).join(''), label: value, hint: specs.map((spec) => spec.hint).join('・') } }]
}

/** 解決済みの本文に残った札は、値が入らなかった差し込み。 */
function markMissing(pieces: InsertPiece[]): InsertPiece[] {
  return pieces.map((piece) => (piece.kind === 'chip' ? { kind: 'missing', spec: piece.spec } : piece))
}

/**
 * 隣り合った差し込みの解決後の文字を分ける。口は解決できなかった差し込みを記号のまま返すので、
 * その位置を「入らない」にし、間の文字をその前の差し込みの値の札にする。
 */
function resolveGroup(group: InsertTokenSpec[], segment: string, extra: readonly InsertTokenSpec[], names: InsertTokenNames, options: InsertTokenOptions): InsertPiece[] {
  const pieces: InsertPiece[] = []
  let rest = segment
  let pending: InsertTokenSpec[] = []
  for (const spec of group) {
    const at = rest.indexOf(spec.token)
    if (at < 0) {
      pending.push(spec)
      continue
    }
    pieces.push(...valuePieces(pending, rest.slice(0, at), extra, names, options), { kind: 'missing', spec })
    rest = rest.slice(at + spec.token.length)
    pending = []
  }
  pieces.push(...valuePieces(pending, rest, extra, names, options))
  return pieces
}

/**
 * 解決済み本文の文字を保ち、差し込みに当たる部分だけ既存の札へ載せる。
 * 値が入らなかった差し込みは `missing`。一致させられない時も、残った記号は `missing` にする。
 */
export function splitResolvedInsertTokens(value: string, resolvedValue: string, names: InsertTokenNames = {}, extra: readonly InsertTokenSpec[] = [], options: InsertTokenOptions = {}): InsertPiece[] {
  const source = splitInsertTokens(value, extra, names, options)
  const result: InsertPiece[] = []
  let cursor = 0
  const fallback = (): InsertPiece[] => markMissing(splitInsertTokens(resolvedValue, extra, names, options))
  for (let index = 0; index < source.length; index++) {
    const piece = source[index]
    if (piece.kind !== 'chip') {
      const text = piece.kind === 'text' ? piece.text : piece.spec.token
      if (!resolvedValue.startsWith(text, cursor)) return fallback()
      result.push(piece)
      cursor += text.length
      continue
    }
    // 隣り合った差し込みは口が個別の値を返さないので、まとまった値として札にする。
    const group = [piece.spec]
    while (source[index + 1]?.kind === 'chip') {
      group.push((source[++index] as ChipPiece).spec)
    }
    const next = source[index + 1]
    const end = next?.kind === 'text' ? resolvedValue.indexOf(next.text, cursor) : resolvedValue.length
    if (end < 0) return fallback()
    result.push(...resolveGroup(group, resolvedValue.slice(cursor, end), extra, names, options))
    cursor = end
  }
  return cursor === resolvedValue.length ? result : fallback()
}

/** 閲覧用の並び。相手に合わせた値（resolvedValue）があれば、その値と「入らない」差し込みで分ける。 */
export function insertDisplayPieces(value: string, options: { resolvedValue?: string; names?: InsertTokenNames; extra?: readonly InsertTokenSpec[]; markUnknown?: boolean } = {}): InsertPiece[] {
  const { resolvedValue, names = {}, extra = [], markUnknown = false } = options
  return resolvedValue === undefined
    ? splitInsertTokens(value, extra, names, { markUnknown })
    : splitResolvedInsertTokens(value, resolvedValue, names, extra, { markUnknown })
}

/** 閲覧用の並びを、title・読み上げ用の文字にする（生の記号を出さない）。 */
export function insertDisplayText(value: string, options: Parameters<typeof insertDisplayPieces>[1] = {}): string {
  return insertPiecesText(insertDisplayPieces(value, options))
}

/** 「入りません」の言い方（送ったときの見え方・一覧の抜粋で同じ文にする）。 */
export function missingInsertText(label: string): string {
  return `（入りません：${label}）`
}

/**
 * title・読み上げ用の文字。札は［名前］、入った値はそのまま、入らない差し込みは「入りません」。
 * 生の記号（{{var.…}} など）を出さない。
 */
export function insertPiecesText(pieces: readonly InsertPiece[]): string {
  return pieces.map((piece) => {
    if (piece.kind === 'text') return piece.text
    if (piece.kind === 'missing') return missingInsertText(piece.spec.label)
    return piece.resolved ? piece.spec.label : `［${piece.spec.label}］`
  }).join('')
}

/**
 * 一覧の抜粋に添える印のための読み取り。予約から入る差し込みがあるか、
 * 相手に関係なく送るときに入らないと分かっている差し込み（置き換えられない形・
 * 読み終えた共通情報の一覧に無いキー・停止中や期限切れなどで今は値が入らない共通情報）。
 * 予約の差し込みは相手の予約しだいなので入らない側に数えない。分からないものは数えない。
 */
export function insertTokenTraits(value: string, names: InsertTokenNames = {}): { reservation: boolean; unfillable: InsertTokenSpec[] } {
  let reservation = false
  const unfillable = new Map<string, InsertTokenSpec>()
  for (const piece of splitInsertTokens(value, [], names, { markUnknown: true })) {
    if (piece.kind !== 'chip') continue
    const key = /^\{\{\s*var\.([a-z][a-z0-9_]*)\s*\}\}$/.exec(piece.spec.token)?.[1]
    if (key && isReservationVarKey(key)) {
      reservation = true
      continue
    }
    if (piece.spec.unknown || (key && names.unavailableVars?.has(key)) || (key && names.varsComplete && lookup(names.vars, key) === undefined)) unfillable.set(piece.spec.label, piece.spec)
  }
  return { reservation, unfillable: [...unfillable.values()] }
}

/** 差し込みの名前（{{ }} を除いた形。口の unresolved と同じ）から札を決める。 */
export function insertTokenSpecOf(name: string, names: InsertTokenNames = {}, extra: readonly InsertTokenSpec[] = []): InsertTokenSpec {
  const token = `{{${name}}}`
  return extra.find((spec) => spec.token === token)
    ?? resolveDefaultToken(token, names)
    ?? unknownToken(token)
    ?? { token, label: UNKNOWN_TOKEN_LABEL, hint: '送るときに置き換えられない差し込みです', icon: 'help', unknown: true }
}
