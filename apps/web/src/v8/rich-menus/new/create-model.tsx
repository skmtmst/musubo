'use client'

import { type HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import {
RICH_MENU_MAX_PAGES
} from '@line-crm/shared'
import { TAB_COUNT_OPTIONS } from './create-options'
import { type Group, type Page } from './create-types'
import { isAreaActionConfigured } from '@/components/rich-menus/action-drafts'


/** ①で選べる切替タブの数の上限（ページの数。LINE 側の上限より多くしない）。 */
export const MAX_TAB_PAGES = Math.min(RICH_MENU_MAX_PAGES, TAB_COUNT_OPTIONS.length)

/** 配る前の確認の参照の種類の呼び名（口は kind を英字で返す）。 */
export const HQ_REFERENCE_LABEL: Record<string, string> = { booking: '予約ページ', form: '回答フォーム', template: 'テンプレート', tag: 'タグ', scenario: 'シナリオ', stamp_card: 'スタンプカード', liff: 'LIFF' }

/* ---------- 統括のひな形（host）の画面の中の下書き ---------- */

/** 統括のひな形の中身を、作る画面の下書き（Group）にする。サーバーには作らない。 */
export function groupFromSeed(seed: HqRichMenuSeed): Group {
  return {
    id: seed.id ?? 'hq-draft',
    accountId: '',
    name: seed.name,
    chatBarText: seed.chatBarText,
    size: seed.size,
    defaultPageId: seed.defaultPageId,
    isDefaultForAll: seed.displayAudience === 'all',
    status: 'draft',
    targetingCondition: null,
    targetingPriority: seed.displayOrder,
    targetingEnabled: seed.displayAudience === 'store',
    folderId: seed.folderId,
    defaultOpen: seed.defaultOpen ?? true,
    version: 0,
    publishingGeneration: 0,
    pages: seed.pages.map((page, index) => ({
      id: page.id, orderIndex: index, name: page.name, aliasId: '', lineRichmenuId: null,
      imageR2Key: page.imageR2Key, imageContentType: null, areas: page.areas,
    })),
  }
}

/** 次の手順へ移る前に、最初の未設定の面を示す。下書き保存は妨げない。 */
export function firstUnconfiguredArea(pages: Page[]): { pageId: string; areaId: string | null; reason: string } | null {
  for (const [pageIndex, page] of pages.entries()) {
    if (page.areas.length === 0) return { pageId: page.id, areaId: null, reason: `タブ${pageIndex + 1}に面が設定されていません。面を追加して動きを設定してください。` }
    const areaIndex = page.areas.findIndex((area) => !isAreaActionConfigured(area))
    if (areaIndex >= 0) {
      const area = page.areas[areaIndex]
      return { pageId: page.id, areaId: area.id, reason: `タブ${pageIndex + 1}の面${String.fromCharCode(65 + areaIndex)}の動きが未設定です。${area.intent === 'url' ? '正しいURLを入力してください。' : '動きと内容を設定してください。'}` }
    }
  }
  return null
}

/** 公開確認に、選択した表示先の影響を示す。 */
export function publishConfirmNoteFor(audience: 'all' | 'none' | 'targeted' | 'tag', conditionEmpty: boolean) {
  return audience === 'all'
    ? '個別に指定した人を除く、すべての友だちの既定メニューになります。'
    : audience === 'none'
      ? 'この操作だけでは、友だちのトーク画面には出ません。出すには登録後に一覧の「表示先」から操作してください。'
      : conditionEmpty
        ? 'いまの条件では誰にも出ません（今0人）。条件を決めてから出してください。'
        : '条件に当てはまる人の画面に、その人に関係する出来事（友だち追加・タグ付けなど）が起きたタイミングで順次出ます。'
}

/** 公開時に友だちへ反映される範囲を示す。 */
export function publishEffectNoteFor(audience: 'all' | 'none' | 'targeted' | 'tag', conditionEmpty: boolean) {
  return audience === 'all'
    ? '個別に指定した人を除く、すべての友だちのトーク画面に出ます。既定のメニューが入れ替わります。'
    : audience === 'none'
      ? 'LINEへの登録だけでは、友だちのトーク画面は変わりません。「表示先」で出す相手を決めてください。'
      : conditionEmpty
        ? '公開しても今は誰の画面にも出ません（0人）。条件を1つ以上足してください。'
        : '条件に当てはまる人の画面は、その人に関係する出来事のタイミングで順次切り替わります。すぐ全員に出るわけではありません。'
}
