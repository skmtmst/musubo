'use client'

import { isKnownCount } from './store-list-stats'

/*
 * ★V8 統括のタグの上のタブ（絵の。店のタグ src/v8/tags/list.tsx と同じ4つ）。
 *   タグ（統括のタグのひな形の一覧）・友だち情報欄・対応マーク・保存した検索。
 * 受け付ける URL は店と同じ `?tab=fields|marks|searches`（無い・違う値はタグ）。切り替えは履歴を積まない（replace）。
 *
 * 友だち情報欄・対応マークは console の分岐で店の共通画面へ接続する。
 * 保存した検索だけはアカウントごとの機能として入口を残す。
 */
import { useEffect, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { LogIn } from 'lucide-react'
import type { HqTemplate } from '@/lib/hq-templates-api'
import { hqOpenHref } from '@/lib/hq-navigation'
import { ListPage } from '@/components/templates'
import Button from '@/components/shared/button'
import { Tabs } from '@/components/shared/tabs'
import ListState from '@/components/shared/list-state'

export const ATTRIBUTE_TABS = [
  ['tags', 'タグ'],
  ['fields', '友だち情報欄'],
  ['marks', '対応マーク'],
  ['searches', '保存した検索'],
] as const
export type AttributeTabKey = (typeof ATTRIBUTE_TABS)[number][0]

export function attributeTabOf(raw: string | null): AttributeTabKey {
  return ATTRIBUTE_TABS.some(([key]) => key === raw) ? (raw as AttributeTabKey) : 'tags'
}

/**
 * 今のタブ（?tab=）と切り替え。タグの画面のときだけ意味を持つ。
 * この一覧はリッチメニュー・回答フォームの入口（Suspense の無いページ）からも出るので、useSearchParams は使わず
 * 開いたときの URL を読む（戻る・進むでも読み直す）。
 */
export function useAttributeTab(path: string): { tab: AttributeTabKey; select: (key: AttributeTabKey) => void } {
  const router = useRouter()
  const [tab, setTab] = useState<AttributeTabKey>('tags')
  useEffect(() => {
    const read = () => setTab(attributeTabOf(new URLSearchParams(window.location.search).get('tab')))
    read()
    window.addEventListener('popstate', read)
    window.addEventListener('hq-attribute-tab', read)
    return () => { window.removeEventListener('popstate', read); window.removeEventListener('hq-attribute-tab', read) }
  }, [])
  const select = (key: AttributeTabKey) => {
    setTab(key)
    const query = new URLSearchParams(window.location.search)
    if (key === 'tags') query.delete('tab'); else query.set('tab', key)
    const rest = query.toString()
    window.history.replaceState(window.history.state, '', rest ? `${path}?${rest}` : path)
    window.dispatchEvent(new Event('hq-attribute-tab'))
    router.replace(rest ? `${path}?${rest}` : path, { scroll: false })
  }
  return { tab, select }
}

export function AttributeTabs({ tab, onSelect }: { tab: AttributeTabKey; onSelect: (key: AttributeTabKey) => void }) {
  return (
      <Tabs
        size="compact"
        label="タグの種類"
        items={ATTRIBUTE_TABS.map(([key, label]) => ({ label, current: tab === key, onClick: () => onSelect(key) }))}
      />
  )
}

/** 統括ではまだ一覧の無いタブの1行（「準備中」とは言わず、いまどこで作るかを言う）。 */
export const OTHER_TAB_LINE: Record<Exclude<AttributeTabKey, 'tags'>, string> = {
  fields: '友だち情報欄は、いまは各アカウントのタグで作ります。統括から配れるようになると、ここに一覧が出ます。',
  marks: '対応マークは、いまは各アカウントのタグで作ります。統括から配れるようになると、ここに一覧が出ます。',
  searches: '保存した検索は、アカウントごとに友だちの絞り込みを残すものです。各アカウントのタグで作ります。',
}

export function OtherTabPanel({ tab, title, description, onSelect }: {
  tab: Exclude<AttributeTabKey, 'tags'>
  title: string
  description: string
  onSelect: (key: AttributeTabKey) => void
}) {
  return (
    <ListPage
      boardId={tab === 'fields' ? 'y0sapC' : tab === 'marks' ? 'Qgjmc' : undefined}
      headingSize="regular"
      title={title}
      help={description}
      tabs={<AttributeTabs tab={tab} onSelect={onSelect} />}
    >
      <ListState kind="empty" title={OTHER_TAB_LINE[tab]}   action={<><Button href={hqOpenHref('tags')}><LogIn size={16} aria-hidden="true" />アカウントを選んで開く</Button></>} />
    </ListPage>
  )
}

/* ───── タグの数の帯（絵 ：未使用・付けている友だち・今月付けた回数・整理の候補）───── */

/** 名前の重なりを見るための形（全角半角・大小・前後の空白をそろえる）。 */
function nameKey(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('ja-JP').trim()
}

/**
 * 未使用＝配った先で付いている友だちが0人のタグ。人数を数えていない行（null）が1つでもあれば数えない（null＝「—」）。
 * 店の「どこにも使っていない」（配信・フォームでの使われ方）は統括の一覧に無いので見ない。
 */
export function unusedTagCount(rows: Pick<HqTemplate, 'friend_count'>[]): number | null {
  if (rows.some((row) => !isKnownCount(row.friend_count))) return null
  return rows.filter((row) => row.friend_count === 0).length
}

/** 整理の候補＝未使用か、ほかのタグと名前が重なっているタグ。人数を数えていない行があれば null。 */
export function cleanupTagCount(rows: Pick<HqTemplate, 'friend_count' | 'name'>[]): number | null {
  if (rows.some((row) => !isKnownCount(row.friend_count))) return null
  const seen = new Map<string, number>()
  for (const row of rows) seen.set(nameKey(row.name), (seen.get(nameKey(row.name)) ?? 0) + 1)
  return rows.filter((row) => row.friend_count === 0 || (seen.get(nameKey(row.name)) ?? 0) > 1).length
}

/** 整理の候補のタグの id（未使用か、ほかのタグと名前が重なっている）。人数を数えていない行は入れない。 */
export function cleanupTagIds(rows: Pick<HqTemplate, 'id' | 'friend_count' | 'name'>[]): Set<string> {
  const seen = new Map<string, number>()
  for (const row of rows) seen.set(nameKey(row.name), (seen.get(nameKey(row.name)) ?? 0) + 1)
  return new Set(rows.filter((row) => row.friend_count === 0 || (seen.get(nameKey(row.name)) ?? 0) > 1).map((row) => row.id))
}

/** 付け方の絞り込みの選択肢（一覧にある付け方だけ）。 */
export function assignmentMethods(rows: Pick<HqTemplate, 'assignment_method'>[]): string[] {
  return [...new Set(rows.map((row) => row.assignment_method).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'ja'))
}

export type TagUsageFilter = 'all' | 'used' | 'unused'
export function matchesTagFilters(row: Pick<HqTemplate, 'friend_count' | 'assignment_method'>, usage: TagUsageFilter, method: string): boolean {
  if (usage === 'used' && (!isKnownCount(row.friend_count) || row.friend_count === 0)) return false
  if (usage === 'unused' && row.friend_count !== 0) return false
  if (method !== 'all' && row.assignment_method !== method) return false
  return true
}
