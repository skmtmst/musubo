import { type Area } from '../../../components/rich-menus/area-types'
import { emptyValue } from '@/components/shared/empty-value'
import {
api
} from '@/lib/api'
import {
type SegmentCondition
} from '@/lib/segment-condition'
import {
type MediaItem
} from '@line-crm/shared'
import { type Group } from './create-types'



/** 古い口や途中の応答を、そのまま編集用の型に断定しない。 */
export function isGroupResponse(value: unknown): value is Group {
  if (!value || typeof value !== 'object') return false
  return 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'pages' in value && Array.isArray(value.pages)
}


/* ---------- 補助（edit/page.tsx と同じ写し。page.tsx は部品を export できないため） ---------- */

/** 表示先の選択・手順・比較で、決めていない状態を条件付きと取り違えない。 */
export function describeMenuAudience(audience: 'all' | 'targeted' | 'none' | 'tag', forHq = false): string {
  if (audience === 'all') return forHq ? '全員' : 'すべての友だち'
  if (audience === 'tag') return 'タグが付いた人'
  if (audience === 'targeted' && !forHq) return '条件に当てはまる友だちだけ'
  return '決めない'
}

/*
 * ★V8 「違いを比べる」の比べる文。版の本文ではなく設定の要約。
 * 最新と入力中の2つを作り、VersionCompare（行ごとの比べる）へ渡す。
 */
export function describeMenuSummary(input: {
  name: string
  chatBarText: string
  audience: 'all' | 'targeted' | 'none' | 'tag'
  forHq?: boolean
  pages: Array<{ areas: unknown[] }>
}): string {
  const areaCount = input.pages.reduce((total, page) => total + page.areas.length, 0)
  return [
    `名前：${input.name || emptyValue('unconfigured')}`,
    `言葉：${input.chatBarText || emptyValue('unconfigured')}`,
    `出す相手：${describeMenuAudience(input.audience, input.forHq)}`,
    `面の数：${input.pages.length}`,
    `ボタンの数：${areaCount}`,
  ].join('\n')
}


/** 保存されている条件を読む。壊れた JSON は「条件なし」。 */
export function parseStoredCondition(raw: string | null): SegmentCondition | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as SegmentCondition
  } catch {
    return null
  }
}


/** 保存に送る面の投影。署名・PATCH 両方に使う。 */
export function projectAreaForDraft(a: Area) {
  return {
    id: a.id,
    boundsX: a.boundsX,
    boundsY: a.boundsY,
    boundsWidth: a.boundsWidth,
    boundsHeight: a.boundsHeight,
    actionType: a.actionType,
    actionData: a.actionData,
    intent: a.intent ?? null,
    label: a.label ?? null,
    tagIds: a.tagIds ?? null,
    scoreChange: a.scoreChange ?? null,
    templateId: a.templateId ?? null,
    formId: a.formId ?? null,
    trackedLinkId: a.trackedLinkId ?? null,
  }
}


/** 登録メディアの中身を取り寄せて、ページ画像として上げられるファイルにする。 */
export async function mediaToFile(item: MediaItem, accountId: string): Promise<File> {
  const res = await fetch(api.media.contentUrl(item.id, accountId), { credentials: 'include' })
  if (!res.ok) throw new Error(`media fetch failed: ${res.status}`)
  const blob = await res.blob()
  return new File([blob], item.filename, {
    type: item.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
  })
}


/** 公開前の下書きはページに実IDがない。切替ボタンの行き先は orderIndex で持つ（N-161）。 */
export function areaDraftsWithSwitchTargets(areas: Area[]) {
  return areas.map((area) => {
    if (area.actionType !== 'richmenuswitch') return projectAreaForDraft(area)
    const raw = area.actionData?.targetPageId
    const index = typeof raw === 'string' ? Number(raw) : NaN
    const { targetPageId: _dropped, ...rest } = (area.actionData ?? {}) as Record<string, unknown>
    return {
      ...projectAreaForDraft(area),
      actionData: Number.isInteger(index) ? { ...rest, targetPageIndex: index } : rest,
    }
  })
}
