// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHqPublishStep, renderPublishStep } from './create-publish-step'
import type { Group, Page } from './create-types'

vi.mock('@/v8/rich-menu-edit/public/schedules/index', () => ({ RichMenuSchedules: () => null }))
vi.mock('@/v8/rich-menu-edit/public/test-apply/index', () => ({ RichMenuTestApply: () => null }))
vi.mock('./create-preview', () => ({
  CheckIcon: () => React.createElement('span', null, 'ok'),
  MenuContent: () => React.createElement('div', null, 'menu-preview'),
}))

function makeAreas(count: number): Page['areas'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `area-${i}`,
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: 'message',
    actionValue: `msg-${i}`,
    label: `ボタン${i + 1}`,
  })) as unknown as Page['areas']
}

function makeGroup(size: unknown): Group {
  return {
    id: 'g-1',
    accountId: 'acc-1',
    name: 'テストメニュー',
    chatBarText: 'メニュー',
    size: size as Group['size'],
    defaultPageId: 'p-1',
    isDefaultForAll: true,
    status: 'draft',
    targetingCondition: null,
    targetingPriority: 0,
    targetingEnabled: false,
    folderId: null,
    defaultOpen: true,
    pages: [],
  } as unknown as Group
}

describe('create-publish-step 未知サイズ・27面目ラベル・異常件数防御', () => {
  afterEach(() => {
    cleanup()
  })

  it('renderPublishStep で未知サイズ・NaN 面数・27面・負の重なり人数でも落ちずに安全表記する', () => {
    const pages: Page[] = [{
      id: 'p-1',
      orderIndex: 0,
      name: '1枚目',
      aliasId: '',
      lineRichmenuId: null,
      imageR2Key: 'img-1',
      imageContentType: 'image/jpeg',
      areas: makeAreas(27),
    }] as unknown as Page[]

    const node = renderPublishStep({
      accountId: 'acc-1',
      aggregateOnly: false,
      areaActionSummary: () => 'メッセージ送信',
      audience: 'targeted',
      canOperate: true,
      checks: {
        self: { state: 'ok', message: null },
        line: { state: 'ok', message: null },
        device: { state: 'todo', at: null },
        pages: { count: Number.NaN, max: 5, state: 'ok' },
      } as unknown as Parameters<typeof renderPublishStep>[0]['checks'],
      checksError: false,
      checksLoading: false,
      conditionEmpty: false,
      conditionUnsaved: false,
      done: null,
      endEnabled: false,
      goToStep: vi.fn(),
      group: makeGroup('extra_large'),
      host: undefined,
      loadChecks: vi.fn(),
      nowNote: '保存するとLINEに登録され、条件に当てはまる人の画面に出来事のタイミングで順次出ます',
      pages,
      previewAreas: null,
      previewImageUrl: null,
      publishEffectNote: '条件に当てはまる人の画面は、その人に関係する出来事のタイミングで順次切り替わります。すぐ全員に出るわけではありません。',
      publishPlan: { mode: 'now', startsAt: '', endsAt: '', restoreGroupId: '' },
      recording: false,
      recordSeen: vi.fn(),
      renderHqPublish: () => React.createElement('div'),
      restoreMenus: [],
      setActivePageId: vi.fn(),
      setEndEnabled: vi.fn(),
      setSelectedAreaId: vi.fn(),
      size: 'large',
      staffRole: 'owner',
      targetPreview: {
        effective: { value: 10 },
        higherMenus: ['上位メニュー'],
        overlap: { value: -5 },
      } as unknown as Parameters<typeof renderPublishStep>[0]['targetPreview'],
      totalAreaCount: Number.NaN,
      updatePublishPlan: vi.fn(),
      validateWithLine: vi.fn(),
      validating: false,
    })

    const { container } = render(<div>{node}</div>)
    expect(screen.getAllByText(/サイズ不明/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/面数不明/).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('27')
    expect(container.textContent).not.toContain('[')
    expect(container.textContent).not.toContain('NaN')
    expect(container.textContent).not.toContain('-5人')
  })

  it('renderHqPublishStep で未知サイズ・負の面数でも RICH_MENU_DIMENSIONS 参照で落ちない', () => {
    const pages: Page[] = [{
      id: 'p-1',
      orderIndex: 0,
      name: '1枚目',
      aliasId: '',
      lineRichmenuId: null,
      imageR2Key: 'img-1',
      imageContentType: 'image/jpeg',
      areas: makeAreas(1),
    }] as unknown as Page[]

    const node = renderHqPublishStep({
      areaActionSummary: () => 'メッセージ送信',
      goToStep: vi.fn(),
      group: makeGroup('unexpected'),
      host: undefined,
      hqDuplicateMode: 'overwrite',
      pages,
      setHqDuplicateMode: vi.fn(),
      size: 'large',
      tabCount: 0,
      totalAreaCount: -1,
    })

    const { container } = render(<div>{node}</div>)
    expect(container.textContent).toContain('サイズ不明・面数不明')
    expect(container.textContent).not.toContain('-1面')
  })
})
