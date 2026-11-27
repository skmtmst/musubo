/*
 * NENコラムの下書き（★V8-B  コラムを書く）の決めごと。
 * 現役の作成と一覧の日時表示が共用する。入力・保存の試験もこの実装を読む。
 */
import type { Tag } from '@line-crm/shared'
import type { NenColumnCreateInput } from '@/lib/api'
import { formatNumber } from '@/lib/format'

/**
 * このアカウントのタグだけを候補にする(点検 #512 の中4)。
 *
 * `GET /api/tags` は見える範囲の全タグを返す。保存口はこのアカウントの
 * タグしか受け付けないので、他アカウントのものを選べると400で失敗する。
 * 所属なし(null)は保存口が断るため、候補に入れない。
 */
export function visibleAccountTags(tags: Tag[], accountId: string): Tag[] {
  return tags.filter((tag) => tag.lineAccountId === accountId)
}

/**
 * NENコラムの下書き作成（設計 `ymXJK` 21-1-E／契約 #618）。
 *
 * **記事の本文はここに保存しない。** 正本はEC側にあり、この画面が作るのは
 * 「外部記事へのリンクを持つ下書き」だけ。本文の入力欄を置くと、
 * どちらが正本なのか分からなくなる。
 */

export const TITLE_MAX = 120
/** LINEの通知に出るのはここまで。設計の「20文字までしか出ません」と同じ。 */
export const TITLE_NOTICE_LENGTH = 20
export const CATEGORY_MAX = 40
export const EXCERPT_MAX = 200

export type ColumnDraft = {
  title: string
  category: string
  excerpt: string
  articleUrl: string
  imageUrl: string
  publishedAt: string
  targetMode: 'all' | 'tag'
  targetTagId: string
  scheduledAt: string
  completionEventName: string
  completionTagId: string
}

export const EMPTY_DRAFT: ColumnDraft = {
  title: '', category: '', excerpt: '', articleUrl: '', imageUrl: '', publishedAt: '',
  targetMode: 'all', targetTagId: '', scheduledAt: '', completionEventName: '', completionTagId: '',
}

/**
 * 題名の長さの知らせ。**設計の「題名 14文字。…いまなら全部 見えます。」と同じ。**
 * 数えるのは入力そのもので、どこかから取ってきた値ではない。
 */
export function titleNotice(title: string): string | null {
  const length = title.trim().length
  if (length === 0) return null
  const head = `題名 ${formatNumber(length)}文字。LINEの通知では${TITLE_NOTICE_LENGTH}文字までしか出ません。`
  return length <= TITLE_NOTICE_LENGTH ? `${head}いまなら全部見えます。` : `${head}途中で切れます。`
}

/** HTTPSだけ。httpや相対URLは、押したときにLINE側で開けない。 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export type FieldError = { field: keyof ColumnDraft; message: string }

/**
 * 送る前に画面で確かめる。
 *
 * **Workerの検査を置き換えない。** ここで通してもWorkerが断ることはある。
 * 押してから断られるより、打っている最中に気づけるほうが早いだけ。
 */
export function validateDraft(draft: ColumnDraft): FieldError[] {
  const errors: FieldError[] = []
  const title = draft.title.trim()
  if (title.length === 0 || title.length > TITLE_MAX) {
    errors.push({ field: 'title', message: `題名を1〜${TITLE_MAX}文字で入力してください。` })
  }
  if (!isHttpsUrl(draft.articleUrl.trim())) {
    errors.push({ field: 'articleUrl', message: 'HTTPSの記事URLを入力してください。' })
  }
  if (draft.imageUrl.trim() && !isHttpsUrl(draft.imageUrl.trim())) {
    errors.push({ field: 'imageUrl', message: '画像URLはHTTPSで入力してください。' })
  }
  if (draft.category.trim().length > CATEGORY_MAX) {
    errors.push({ field: 'category', message: `分類を${CATEGORY_MAX}文字以内にしてください。` })
  }
  if (draft.excerpt.trim().length > EXCERPT_MAX) {
    errors.push({ field: 'excerpt', message: `概要を${EXCERPT_MAX}文字以内にしてください。` })
  }
  if (draft.publishedAt.trim() && publishedAtIso(draft.publishedAt) === null) {
    errors.push({ field: 'publishedAt', message: '公開日時は日付と時刻の両方を選んでください。' })
  }
  if (draft.targetMode === 'tag' && !draft.targetTagId.trim()) {
    errors.push({ field: 'targetTagId', message: '配信対象のタグを選んでください。' })
  }
  if (draft.scheduledAt.trim() && publishedAtIso(draft.scheduledAt) === null) {
    errors.push({ field: 'scheduledAt', message: '配信日時は日付と時刻の両方を選んでください。' })
  } else if (draft.scheduledAt.trim() && isPastScheduledAt(draft.scheduledAt)) {
    errors.push({ field: 'scheduledAt', message: '配信日時はいまより先の日時を選んでください。' })
  }
  return errors
}

/**
 * 送る形にする。
 *
 * **`publishedAt` が空でも今日を補わない。** 補うと、書いただけのものが
 * 公開済みとして扱われる。空は「下書きのまま」。
 * `body` `slug` `externalId` `lineAccountId` は送らない（送ると400になる）。
 */
export function publishedAtIso(value: string): string | null {
  /*
    入れ物は `datetime-local` で、時差を持たない文字列（`2026-08-31T10:00`）を返す。
    **この端末の時差を使わない。** 開発機はUTC+7のこともあり、そのまま渡すと
    実際の予定と1〜2時間ずれる。事業の時計は日本時間なので、+09:00を明示する。
  */
  const raw = value.trim()
  if (!raw) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] ? Number(match[6]) : 0
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+09:00`
}

/*
 * #935 N-304: 配信予約の日時は「いまより先」だけを通す。
 * 過去を通すとWorkerの次のtickで即送され、「予約した」のに「今届いた」になる。
 * Worker側の新規作成口・予約口も同じ判定で断る（ここは入力中の早い知らせ）。
 */
export function isPastScheduledAt(value: string, now = Date.now()): boolean {
  const iso = publishedAtIso(value)
  if (!iso) return false
  return Date.parse(iso) <= now
}

export function toCreateInput(draft: ColumnDraft): NenColumnCreateInput {
  const optional = (value: string) => (value.trim() ? value.trim() : undefined)
  return {
    title: draft.title.trim(),
    ...(optional(draft.category) ? { category: draft.category.trim() } : {}),
    ...(optional(draft.excerpt) ? { excerpt: draft.excerpt.trim() } : {}),
    articleUrl: draft.articleUrl.trim(),
    imageUrl: optional(draft.imageUrl) ?? null,
    publishedAt: publishedAtIso(draft.publishedAt),
    targetMode: draft.targetMode,
    targetTagId: draft.targetMode === 'tag' ? optional(draft.targetTagId) ?? null : null,
    scheduledAt: publishedAtIso(draft.scheduledAt),
    completionEventName: optional(draft.completionEventName) ?? null,
    completionTagId: optional(draft.completionTagId) ?? null,
  }
}

const CODE_MESSAGE: Record<string, string> = {
  title_invalid: '題名を1〜120文字で入力してください。',
  article_url_invalid: 'HTTPSの記事URLを入力してください。',
  image_url_invalid: '画像URLはHTTPSで入力してください。',
  category_too_long: '分類を指定の文字数以内にしてください。',
  excerpt_too_long: '概要を指定の文字数以内にしてください。',
  published_at_invalid: '公開日時をタイムゾーン付きで入力してください。',
  target_invalid: '配信対象のタグを選んでください。',
  scheduled_at_invalid: '配信日時を日本時間で入力してください。',
  past_datetime: '配信日時はいまより先の日時を選んでください。',
  completion_invalid: '読了後の設定を確認してください。',
  payload_too_large: '入力内容が大きすぎます。本文は入力せず、外部記事のURLを指定してください。',
  column_already_exists: '同じ記事のコラムがすでにあります。一覧を読み直してください。',
  column_create_failed: '下書きを保存できませんでした。時間をおいて、もう一度お試しください。',
  request_invalid: '送れない項目が含まれていました。入力を確認してください。',
}

export type Failure = {
  /** 権限不足と入力の誤りと保存失敗を混ぜない。読む人が次にすることが違う。 */
  kind: 'forbidden' | 'input' | 'conflict' | 'failure'
  message: string
}

/**
 * Workerの合図を、画面の言葉にする。
 *
 * **知らない合図をそのまま出さない。** `column_create_failed` のような
 * 英語の記号が画面に出ると、何をすればよいのか分からない。
 *
 * **409で「どのアカウントの記事と重なったか」は言わない。** 契約も返さない。
 * 別のアカウントに何があるかを画面で推測しない。
 */
export function failureOf(input: { status?: number; code?: string }): Failure {
  if (input.status === 403) {
    return {
      kind: 'forbidden',
      message: 'このアカウントでコラムを保存する権限がありません。管理者にご確認ください。',
    }
  }
  if (input.status === 409) {
    return { kind: 'conflict', message: CODE_MESSAGE.column_already_exists }
  }
  const known = input.code && Object.prototype.hasOwnProperty.call(CODE_MESSAGE, input.code) ? CODE_MESSAGE[input.code] : undefined
  if (input.status === 400 || input.status === 413) {
    return { kind: 'input', message: known ?? CODE_MESSAGE.request_invalid }
  }
  return { kind: 'failure', message: known ?? CODE_MESSAGE.column_create_failed }
}

/** 送ってよいか。入力の誤りが1つでもあれば送らない。 */
export function canSubmit(input: { draft: ColumnDraft; busy: boolean }): boolean {
  if (input.busy) return false
  return validateDraft(input.draft).length === 0
}
