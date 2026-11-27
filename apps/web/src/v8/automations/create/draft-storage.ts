import type { RestaurantFollowupManagement } from '@line-crm/shared'


/**
 * 作りかけの下書きの控え（N-357 → DETAIL-13）。
 *
 * 保存した下書きの番号は画面の記憶（`savedDraft`）にしか無かったので、
 * 再読込や「戻る」で消え、保存のたびに新しい下書きが増えていた。
 * ブラウザに控えておき、同じ店のときだけ再利用する。
 *
 * **ただし控えは「再開の案内」にだけ使う。** 以前はこの番号だけを戻して
 * 名前・条件・処理は初期値のままだったため、一覧から新規へ来た利用者が
 * 空の画面へ打った内容で、以前の下書きをまるごと上書きしていた
 * （DETAIL-13）。いまは
 *
 *   - 新規作成（`/automations/new`）…… 必ず新しい下書きを作る
 *   - 再開（`/automations/new?draft=<番号>`）…… 番号と中身・版を
 *     一緒に読み込み、読み終わるまで保存できない
 *
 * の2導線に分ける。保存に成功したらURLへ番号を載せるので、再読込・
 * 「戻る」でも同じ下書きの**中身ごと**戻る。
 */
export const DRAFT_STORAGE_KEY = 'lh-automation-new-draft-v1'

export interface StoredDraft {
  followupManagement?:RestaurantFollowupManagement
  id: string
  draftVersionId: string
}

export type StoredDrafts = Record<string, StoredDraft>

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const isSafeAccountKey = (key: unknown): key is string =>
  typeof key === 'string' && key.trim() !== '' && !FORBIDDEN_KEYS.has(key)

export const isStoredDraft = (value: unknown): value is StoredDraft => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const draft = value as Partial<StoredDraft>
  return typeof draft.id === 'string' && draft.id.trim() !== ''
    && typeof draft.draftVersionId === 'string' && draft.draftVersionId.trim() !== ''
}

export const readStoredDrafts = (): StoredDrafts => {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    // 以前の1店舗分だけの控えも読み、次の保存で店舗別の形へ移す。
    const legacy = parsed as Partial<StoredDraft> & { accountId?: unknown }
    const legacyAccountId = legacy.accountId
    if (isSafeAccountKey(legacyAccountId) && isStoredDraft(legacy)) {
      return { [legacyAccountId]: { id: legacy.id, draftVersionId: legacy.draftVersionId } }
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, StoredDraft] => isSafeAccountKey(entry[0]) && isStoredDraft(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

export const readStoredDraft = (accountId: string): StoredDraft | null => {
  if (!isSafeAccountKey(accountId)) return null
  const drafts = readStoredDrafts()
  return Object.prototype.hasOwnProperty.call(drafts, accountId) ? drafts[accountId] : null
}

export const writeStoredDraft = (accountId: string, draft: StoredDraft): void => {
  if (!isSafeAccountKey(accountId) || !isStoredDraft(draft)) return
  try {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
      ...readStoredDrafts(),
      [accountId]: draft,
    }))
  } catch {
    // 控えが書けなくても保存自体は続ける。次は作り直しになるだけ。
  }
}

export const clearStoredDraft = (accountId: string): void => {
  if (!isSafeAccountKey(accountId)) return
  try {
    const drafts = readStoredDrafts()
    delete drafts[accountId]
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(DRAFT_STORAGE_KEY)
    else sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // 消せなくても害はない。
  }
}
