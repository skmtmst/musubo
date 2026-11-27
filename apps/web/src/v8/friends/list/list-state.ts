/*
 * 友だち一覧の絞り込み・表示位置のセッション保持（IDEA-03）。
 *
 * 一覧 → 友だち詳細 → 戻る、の移動で React 状態は消える。条件と
 * ページを sessionStorage へ写して、戻ってきたとき同じ一覧へ復帰する。
 * アカウントごとにキーを分け、別アカウントの条件は混ぜない。
 *
 * sessionStorage はタブを閉じると消える。ログアウトや別人利用で
 * 前の条件が残り続けることはない。
 */
import type { AdvancedSearchResult } from '@/components/friends/advanced-search-dialog'
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select'
import { validAdvancedSearch } from './list-search-validation'

const KEY_PREFIX = 'lh_friends_list_state_v1:'
export const LIST_PAGE_SIZES = STANDARD_PAGE_SIZES

export interface FriendsListSnapshot {
  searchInput: string
  searchSubmitted: string
  selectedTagId: string
  responseFilter: 'all' | 'unhandled'
  operatorId: string
  scenarioId: string
  attentionOnly: boolean
  sortMode: 'recent' | 'oldest'
  page: number
  pageSize: number
  advanced: AdvancedSearchResult | null
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** 壊れた保存値・古い形をそのまま適用しないための軽い形チェック。 */
function isSnapshot(value: unknown): value is FriendsListSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.searchInput !== 'string' || typeof v.searchSubmitted !== 'string') return false
  if (typeof v.selectedTagId !== 'string' || typeof v.operatorId !== 'string') return false
  if (typeof v.scenarioId !== 'string' || typeof v.attentionOnly !== 'boolean') return false
  if (v.responseFilter !== 'all' && v.responseFilter !== 'unhandled') return false
  if (v.sortMode !== 'recent' && v.sortMode !== 'oldest') return false
  if (!Number.isSafeInteger(v.page) || (v.page as number) < 1) return false
  if (!LIST_PAGE_SIZES.includes(v.pageSize as (typeof LIST_PAGE_SIZES)[number])) return false
  if (!validAdvancedSearch(v.advanced)) return false
  return true
}

export function readFriendsListSnapshot(accountId: string): FriendsListSnapshot | null {
  const store = storage()
  if (!store || !accountId) return null
  try {
    const raw = store.getItem(KEY_PREFIX + accountId)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeFriendsListSnapshot(accountId: string, snapshot: FriendsListSnapshot): void {
  const store = storage()
  if (!store || !accountId) return
  try {
    store.setItem(KEY_PREFIX + accountId, JSON.stringify(snapshot))
  } catch {
    // 容量超過・プライベートモードでは書けない。書けなくても一覧は動く。
  }
}
