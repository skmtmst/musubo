import { describe, expect, it } from 'vitest'
import type { Area } from '../../../components/rich-menus/area-types'
// 古い ./action-drafts.ts（中身は下の再書き出しだけ）はどこからも読まれないので 2026-10-07 に消し、元を直接読む。
import { isAreaActionConfigured, pruneStaleAreaTags, pruneStaleAreaTemplates, saveAreaDraft, unsetAreaLabels } from '@/components/rich-menus/action-drafts'

function textArea(id: string, text = ''): Area {
  return {
    id,
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: 'message',
    actionData: { text },
    intent: 'text',
  }
}

describe('リッチメニュー新規作成の面アクション', () => {
  it('面の設定保存で選んだ面だけを下書き状態へ反映する', () => {
    const areas = [textArea('a'), textArea('b')]
    const saved = saveAreaDraft(areas, 1, {
      ...textArea('b', '予約する'),
      tagIds: ['tag-1'],
      scoreChange: 10,
    })

    expect(isAreaActionConfigured(saved[0])).toBe(false)
    expect(isAreaActionConfigured(saved[1])).toBe(true)
    expect(saved[1].actionData).toEqual({ text: '予約する' })
    expect(saved[1].tagIds).toEqual(['tag-1'])
    expect(saved[1].scoreChange).toBe(10)
  })

  it('6面を設定すると未設定警告の対象がなくなる', () => {
    const areas = Array.from({ length: 6 }, (_, index) => textArea(String(index), `動作${index}`))
    expect(unsetAreaLabels(areas)).toEqual([])
  })
})

describe('R23 アカウント切替で前の候補にしかないタグを外す', () => {
  it('新しい候補にない選択だけを外し、件数を返す', () => {
    const drafts = {
      large: [
        { ...textArea('a', '予約する'), tagIds: ['tag-keep', 'tag-gone'] },
        { ...textArea('b', '買う'), tagIds: ['tag-keep'] },
      ],
    }
    const { next, removed } = pruneStaleAreaTags(drafts, new Set(['tag-keep']))
    expect(removed).toBe(1)
    expect(next.large[0].tagIds).toEqual(['tag-keep'])
    expect(next.large[1].tagIds).toEqual(['tag-keep'])
  })

  it('外すものがなければ面を作り直さない', () => {
    const area = { ...textArea('a', '予約する'), tagIds: ['tag-keep'] }
    const { next, removed } = pruneStaleAreaTags({ large: [area] }, new Set(['tag-keep']))
    expect(removed).toBe(0)
    expect(next.large[0]).toBe(area)
  })

  it('下書きが空でも壊れない', () => {
    expect(pruneStaleAreaTags({}, new Set(['tag-keep']))).toEqual({ next: {}, removed: 0 })
  })
})

describe('R203 「URLを開く」の飛び先検査', () => {
  function urlArea(id: string, uri: string, trackedLinkId: string | null = null): Area {
    return {
      ...textArea(id),
      actionType: 'uri',
      intent: 'url',
      actionData: { uri },
      trackedLinkId,
    }
  }

  it('URLではない文字列は「設定済み」にしない', () => {
    expect(isAreaActionConfigured(urlArea('a', 'not-a-url'))).toBe(false)
    expect(unsetAreaLabels([urlArea('a', 'not-a-url')])).toEqual(['A'])
  })

  it('正しいURLなら設定済み。計測リンクを選んでいればURL欄は不要', () => {
    expect(isAreaActionConfigured(urlArea('a', 'https://example.com/apply'))).toBe(true)
    expect(isAreaActionConfigured(urlArea('a', '', 'link-1'))).toBe(true)
    // LINEのuriアクションが通す scheme（電話・メール）も設定済みとして扱う
    expect(isAreaActionConfigured(urlArea('a', 'tel:0300005678'))).toBe(true)
    expect(isAreaActionConfigured(urlArea('a', 'mailto:info@example.com'))).toBe(true)
  })

  it('空欄と使えない scheme は未設定のまま', () => {
    expect(isAreaActionConfigured(urlArea('a', ''))).toBe(false)
    expect(isAreaActionConfigured(urlArea('a', 'javascript:alert(1)'))).toBe(false)
  })
})

describe('m18r アカウント切替で前の候補にしかないテンプレートを外す', () => {
  function templateArea(id: string, templateId: string | null): Area {
    return { ...textArea(id, ''), intent: 'template', templateId }
  }

  it('新しい候補にない選択だけを外し、件数を返す', () => {
    const drafts = {
      large: [templateArea('a', 'tpl-keep'), templateArea('b', 'tpl-gone')],
    }
    const { next, removed } = pruneStaleAreaTemplates(drafts, new Set(['tpl-keep']))
    expect(removed).toBe(1)
    expect(next.large[0].templateId).toBe('tpl-keep')
    expect(next.large[1].templateId).toBeNull()
  })

  it('外すものがなければ面を作り直さない', () => {
    const area = templateArea('a', 'tpl-keep')
    const { next, removed } = pruneStaleAreaTemplates({ large: [area] }, new Set(['tpl-keep']))
    expect(removed).toBe(0)
    expect(next.large[0]).toBe(area)
  })

  it('選んでいない面はそのままにする', () => {
    const area = templateArea('a', null)
    const { next, removed } = pruneStaleAreaTemplates({ large: [area] }, new Set(['tpl-keep']))
    expect(removed).toBe(0)
    expect(next.large[0]).toBe(area)
  })
})
