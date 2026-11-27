// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:9'
})

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    selectedAccount: { id: 'acc-1', name: '店舗A' },
    loading: false,
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('step=publish'),
  usePathname: () => '/rich-menus/new',
}))

vi.mock('@/v8/rich-menu-edit/public/schedules/index', () => ({ RichMenuSchedules: () => null }))
vi.mock('@/v8/rich-menu-edit/public/test-apply/index', () => ({ RichMenuTestApply: () => null }))
vi.mock('./create-hydration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./create-hydration')>()
  return {
    ...actual,
    hydrateMenuDraft: (ctx: Parameters<typeof actual.hydrateMenuDraft>[0], g: Group) => {
      if (g.size !== 'large' && g.size !== 'compact') {
        ctx.setGroup(g)
        ctx.setSize(g.size)
        ctx.setPages(g.pages)
        ctx.setActivePageId(g.pages[0]?.id ?? null)
        ctx.setName(g.name)
        ctx.setChatBarText(g.chatBarText)
        ctx.setDefaultOpen(g.defaultOpen)
        ctx.setAudience('all')
        return
      }
      actual.hydrateMenuDraft(ctx, g)
    },
  }
})

import RichMenuCreateV8 from './create'
import { MenuContent } from './create-preview'
import { renderHqPublishStep, renderPublishStep } from './create-publish-step'
import type { Group, Page } from './create-types'

function makeAreas(count: number): Page['areas'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `area-${i}`,
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: 'message',
    actionValue: `msg-${i}`,
    actionData: { text: `msg-${i}` },
    intent: 'message',
    label: `ボタン${i + 1}`,
    tagIds: [],
    scoreChange: null,
    templateId: null,
    formId: null,
    trackedLinkId: null,
  })) as unknown as Page['areas']
}

function makeGroup(size: unknown, pages: Page[] = []): Group {
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
    displayOrder: 1,
    version: 1,
    publishingGeneration: 1,
    defaultOpen: true,
    pages,
  } as unknown as Group
}

describe('create-publish-step / MenuContent 実物描画での未知サイズ・公開停止・異常件数防御', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('実物の MenuContent は未知サイズ（画像あり・なし・原型名）でも落ちずに「サイズを確認できません」を出し、large/compact は通常表示する', () => {
    const view = render(
      <MenuContent
        size={'extra_large' as 'large'}
        imageUrl="https://example.test/menu.jpg"
        areas={[{ x: 0, y: 0, w: 100, h: 100, label: '予約' }]}
        pages={[]}
        activePageId={null}
      />,
    )
    expect(screen.getByText('サイズを確認できません')).toBeTruthy()
    expect(view.container.querySelector('img')).toBeNull()

    view.rerender(
      <MenuContent
        size={'constructor' as 'large'}
        imageUrl={null}
        areas={null}
        pages={[]}
        activePageId={null}
      />,
    )
    expect(screen.getByText('サイズを確認できません')).toBeTruthy()

    view.rerender(
      <MenuContent
        size="compact"
        imageUrl={null}
        areas={[{ x: 0, y: 0, w: 1250, h: 843, label: '予約' }]}
        pages={[]}
        activePageId={null}
      />,
    )
    expect(screen.queryByText('サイズを確認できません')).toBeNull()
    expect(screen.getByText(/画像を選ぶと、ここに出ます/)).toBeTruthy()
    expect(view.container.querySelector('[data-rich-menu-size="compact"]')).not.toBeNull()
  })

  it('renderPublishStep で実物の MenuContent を描画しても未知サイズ・NaN 面数・27面・負の重なり人数で落ちずに理由を出す', () => {
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
      previewAreas: [{ x: 0, y: 0, w: 100, h: 100 }],
      previewImageUrl: 'https://example.test/menu.jpg',
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
    expect(screen.getByText('サイズを確認できません')).toBeTruthy()
    expect(screen.getByText('メニューのサイズを確認できないため公開できません。')).toBeTruthy()
    expect(screen.getAllByText(/サイズ不明/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/面数不明/).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('27')
    expect(container.textContent).not.toContain('[')
    expect(container.textContent).not.toContain('NaN')
    expect(container.textContent).not.toContain('-5人')
  })

  it('renderHqPublishStep で実物の MenuContent を描画しても未知サイズ・負の面数で落ちずに理由を出す', () => {
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
    expect(screen.getByText('サイズを確認できません')).toBeTruthy()
    expect(screen.getByText(/サイズを確認できないため公開できません/)).toBeTruthy()
    expect(container.textContent).toContain('サイズ不明・面数不明')
    expect(container.textContent).not.toContain('-1面')
  })

  it('実画面 RichMenuCreateV8 で未知サイズのメニューを公開ステップで開くと、落ちずにプレビュー代替と理由を出し公開ボタンを止める', async () => {
    const pages: Page[] = [{
      id: 'p-1',
      orderIndex: 0,
      name: 'トップ',
      aliasId: 'a-top',
      lineRichmenuId: null,
      imageR2Key: 'img-1',
      imageContentType: 'image/jpeg',
      areas: makeAreas(1),
    }] as unknown as Page[]
    const groupData = makeGroup('extra_large', pages)

    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const pathname = new URL(String(url), 'http://localhost').pathname
      if (pathname === '/api/staff/me') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'owner-1', role: 'owner' } }) }
      }
      if (pathname === '/api/rich-menu-groups/g-1') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: groupData }) }
      }
      if (pathname === '/api/rich-menu-groups/g-1/prepublish-check') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              self: { state: 'ok', message: null },
              line: { state: 'ok', message: null },
              device: { state: 'ok', at: '2026-11-28T00:00:00Z' },
              pages: { count: 1, max: 5, state: 'ok' },
            },
          }),
        }
      }
      if (pathname === '/api/rich-menu-groups/g-1/target-preview') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { matched: { state: 'available', value: 10 }, higherMenus: [], overlap: null } }) }
      }
      if (pathname === '/api/rich-menu-groups') {
        return { ok: true, status: 200, json: async () => ({ success: true, data: { items: [], total: 0, page: 1, limit: 200 } }) }
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
    }))

    render(<RichMenuCreateV8 editGroupId="g-1" initialStep="publish" />)

    await waitFor(() => {
      expect(screen.getAllByText('サイズを確認できません').length).toBeGreaterThan(0)
    })
    expect(screen.getByText('メニューのサイズを確認できないため公開できません。')).toBeTruthy()
    const publishBtn = screen.getByRole('button', { name: '公開する' }) as HTMLButtonElement
    expect(publishBtn.disabled).toBe(true)
    expect(publishBtn.title).toContain('サイズを確認できないため公開できません')
  })
})
