// @vitest-environment happy-dom
/*
 * m26l 実 React 回帰（監査 R583・R584・R585）。
 * 本物の React で本物の new/edit ページを mount し、差し替えるのは
 * 通信（api.commonActions）だけ。振る舞いが壊れたら落ちる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

const net = vi.hoisted(() => ({
  exportAllowed: true as boolean | null,
  getMode: 'ok' as 'internal' | 'ok' | 'no-draft' | 'failing' | 'failing-then-ok',
  resourcesMode: 'ok-empty' as 'ok-empty' | 'ok-with-tags' | 'failing' | 'failing-then-ok',
  getCount: 0,
  resourcesCount: 0,
  duplicate: vi.fn(),
  updateDraft: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const tags = [{ id: 't1', name: '常連' }]
  const emptyResources = {
    tags: [], scenarios: [], templates: [], webhooks: [], richMenus: [], commonActions: [],
  }
  const detail = (draftId: string) => ({
    id: 'ca-1',
    name: 'テストアクション',
    description: null,
    status: 'draft' as const,
    currentDraftVersionId: draftId,
    currentPublishedVersionId: 'v1',
    versions: [
      {
        id: 'v-draft', versionNumber: 2, status: 'draft' as const,
        actions: [{ id: 'a1', type: 'add_tag' as const, params: { tagId: 't1' }, onFailure: 'stop' as const }],
        draftRevision: 3, createdBy: '担当', createdAt: '2026-09-29T00:00:00.000Z', publishedAt: null,
      },
      {
        id: 'v1', versionNumber: 1, status: 'published' as const, actions: [],
        draftRevision: 1, createdBy: '担当', createdAt: '2026-09-28T00:00:00.000Z',
        publishedAt: '2026-09-28T00:00:00.000Z',
      },
    ],
    bindings: [],
  })
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: async () => ({ success: true, data: [], unfiledCount: 1 }) },
      commonActions: {
        ...actual.api.commonActions,
        duplicate: net.duplicate,
        updateDraft: net.updateDraft,
        list: async () => ({ success: true, data: [{ id: 'ca-1', name: '来店の案内', description: null, status: 'draft', draftVersion: 1, publishedVersion: null, actionCount: 1, bindingCount: 0, oldVersionBindingCount: 0, executionCountThisMonth: 0, failureCountThisMonth: 0, lastRunAt: null, updatedAt: '2026-10-20T00:00:00Z' }] }),
        get: async () => {
          net.getCount += 1
          if (net.getMode === 'internal') throw new actual.ApiError(500, '内部の失敗 SELECT * FROM customers')
          if (net.getMode === 'failing' || (net.getMode === 'failing-then-ok' && net.getCount === 1)) {
            throw new actual.ApiError(503, 'API error: 503')
          }
          if (net.getMode === 'no-draft') return { success: true, data: detail('v-gone') }
          return { success: true, data: detail('v-draft') }
        },
        resources: async () => {
          net.resourcesCount += 1
          if (net.resourcesMode === 'failing' || (net.resourcesMode === 'failing-then-ok' && net.resourcesCount === 1)) {
            throw new actual.ApiError(503, 'API error: 503')
          }
          if (net.resourcesMode === 'ok-with-tags' || net.resourcesMode === 'failing-then-ok') {
            return { success: true, data: { ...emptyResources, tags } }
          }
          return { success: true, data: emptyResources }
        },
      },
    },
  }
})

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams('id=ca-1'),
  usePathname: () => '/common-actions',
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1', loading: false }),
}))
vi.mock('@/components/automations/use-common-action-permission', () => ({
  useCanManageCommonActions: () => true,
}))
vi.mock('@/lib/use-manual-href', () => ({ useManualHref: () => null }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
  usePageChrome: () => ({ title: null }),
}))

vi.mock('@/v8/automations/shell', async importOriginal => ({ ...(await importOriginal<typeof import('@/v8/automations/shell')>()), useAutomationManage: () => true, useAutomationRunManage: () => net.exportAllowed === null ? null : ({ canExport: net.exportAllowed }), useAutomationTabCounts: () => ({ rules: 0, commonActions: 1, runs: 0 }) }))
const { default: ListPage } = await import('@/v8/automations/common-actions')
const { default: EditPage } = await import('./edit/page')
const { default: NewPage } = await import('./new/page')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flush(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function text(): string {
  return container.textContent ?? ''
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find((node) => (node.textContent ?? '').includes(name)) as HTMLButtonElement | undefined
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  net.exportAllowed = true
  net.getMode = 'ok'
  net.resourcesMode = 'ok-empty'
  net.getCount = 0
  net.resourcesCount = 0
  net.updateDraft.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  container.remove()
  vi.restoreAllMocks()
})

describe('R583 下書きなしと通信失敗の言い分け（本物のReact）', () => {
  it('編集の下書きなしは版の画面への案内で、再読込の口は出さない', async () => {
    net.getMode = 'no-draft'
    await act(async () => { root.render(<EditPage />) })
    await flush()

    expect(text()).toContain('編集中の下書きがありません')
    expect(text()).toContain('公開済みの版はそのままです')
    expect(text()).toContain('前の版から新版を作る')
    expect(text()).toContain('版の画面へ戻る')
    expect([...container.querySelectorAll('a')].find(a => a.textContent?.trim() === '版の画面へ戻る')?.getAttribute('href')).toBe('/common-actions/versions?id=ca-1')
    // 再読込では直らないので、通信障害の再読込の口は出さない。
    expect(text()).not.toContain('もう一度読み込む')
    expect(text()).not.toContain('下書きを読み込めませんでした')
  })

  it('編集の503は通信障害と再読込を示す', async () => {
    net.getMode = 'failing'
    await act(async () => { root.render(<EditPage />) })
    await flush()

    expect(text()).toContain('下書きを読み込めませんでした')
    expect(buttonNamed('もう一度読み込む'), '通信障害の再読込ボタンがある').toBeTruthy()
    expect(text()).not.toContain('編集中の下書きがありません')
  })
})

describe('R584 再取得の成功後は古い失敗文を残さない（本物のReact）', () => {
  it('503のあと再読込が成功すると失敗文が消えて編集内容が戻る', async () => {
    net.getMode = 'failing-then-ok'
    await act(async () => { root.render(<EditPage />) })
    await flush()
    expect(text()).toContain('下書きを読み込めませんでした')

    const retry = buttonNamed('もう一度読み込む')
    expect(retry, '再読込ボタンがある').toBeTruthy()
    await act(async () => { retry!.click() })
    await flush()

    // 古い取得失敗文は残さない。
    expect(text()).not.toContain('下書きを読み込めませんでした')
    // 取り直した編集内容（名前）が欄に戻る。
    const nameInput = container.querySelector('input') as HTMLInputElement | null
    expect(nameInput, '名前の入力欄がある').toBeTruthy()
    expect(nameInput!.value).toBe('テストアクション')
    expect(container.querySelector('[data-design-part="notice"][data-tone="danger"]')).toBeNull()
  })
})

describe('R585 選択肢の失敗と真の0件の言い分け（本物のReact）', () => {
  it('作成の選択肢503は欄の近くに再取得を出し、真の0件の文は出さない', async () => {
    net.resourcesMode = 'failing'
    await act(async () => { root.render(<NewPage />) })
    await flush()

    expect(text()).toContain('読み込みに失敗しました')
    expect(buttonNamed('選択肢をもう一度読み込む'), '選択肢だけの再取得ボタンがある').toBeTruthy()
    await act(async () => { (container.querySelector('[data-action-row] button[aria-expanded]') as HTMLButtonElement).click() })
    // 失敗時は真の0件（選べる◯◯がありません）と混ぜない。
    expect(text()).not.toContain('選べるタグがありません')
    // 保存の入口は閉じ、理由を示す。
    const save = buttonNamed('下書きを保存')
    expect(save, '保存ボタンがある').toBeTruthy()
    expect(save!.disabled).toBe(true)
    expect(save!.title).toContain('選択肢を読み込めていないため保存できません')
  })

  it('再取得の成功後は未保存の入力を保ったまま候補が戻り保存できる', async () => {
    net.resourcesMode = 'failing-then-ok'
    await act(async () => { root.render(<NewPage />) })
    await flush()
    expect(text()).toContain('読み込みに失敗しました')

    // 未保存の入力を入れてから再取得する。
    const nameInput = container.querySelector('input') as HTMLInputElement | null
    expect(nameInput, '名前の入力欄がある').toBeTruthy()
    await act(async () => {
      fireEvent.change(nameInput!, { target: { value: '監査の記録' } })
    })

    const description = container.querySelector<HTMLInputElement>('input[placeholder="使う場面や目的を書きます"]')!
    await act(async () => { fireEvent.change(description, { target: { value: '残したい説明' } }); buttonNamed('待ち時間を入れる')!.click() })
    expect(container.querySelectorAll('[data-action-row]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-action-row]')[1].textContent).toContain('5 分待つ')
    const retry = buttonNamed('選択肢をもう一度読み込む')
    expect(retry, '再取得ボタンがある').toBeTruthy()
    await act(async () => { retry!.click() })
    await flush()

    // 失敗文は消え、入力は保たれる。
    expect(text()).not.toContain('読み込みに失敗しました')
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('監査の記録')
    expect(container.querySelector<HTMLInputElement>('input[placeholder="使う場面や目的を書きます"]')?.value).toBe('残したい説明')
    expect(container.querySelectorAll('[data-action-row]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-action-row]')[1].textContent).toContain('5 分待つ')
    // 候補が戻る（空でない取得なので真の0件の文は出ない）。共有Selectは
    // 閉じている間は候補名を描かないため、0件文の不在で戻りを確かめる。
    expect(text()).not.toContain('選べるタグがありません')
    const save = buttonNamed('下書きを保存')
    expect(save, '保存ボタンがある').toBeTruthy()
    expect(save!.disabled).toBe(false)
  })

  it('真の0件は失敗にせず0件の案内のまま保存できる', async () => {
    net.resourcesMode = 'ok-empty'
    await act(async () => { root.render(<NewPage />) })
    await flush()

    expect(text()).not.toContain('読み込みに失敗しました')
    await act(async () => { (container.querySelector('[data-action-row] button[aria-expanded]') as HTMLButtonElement).click() })
    expect(text()).toContain('選べるタグがありません')
    const save = buttonNamed('下書きを保存')
    expect(save, '保存ボタンがある').toBeTruthy()
    expect(save!.disabled).toBe(false)
  })
})


it('編集の内部の失敗を表示せず、次の操作を案内する', async () => {
  net.getMode = 'internal'
  await act(async () => { root.render(<EditPage />) })
  await flush()
  expect(text()).toContain('下書きを読み込めませんでした')
  expect(text()).not.toContain('SELECT * FROM customers')
  expect(buttonNamed('もう一度読み込む')).toBeTruthy()
})

it('複製が失敗したら内部の本文を出さず、編集画面へ移動せずに操作を戻す', async () => {
  net.duplicate.mockReset().mockRejectedValue(new Error('内部の失敗 SELECT * FROM customers'))
  await act(async () => { root.render(<ListPage />) })
  await flush()
  fireEvent.click(screen.getByRole('button', { name: '共通アクション「来店の案内」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '複製して下書きを作る' }))
  await waitFor(() => expect(text()).toContain('複製に失敗しました'))
  expect(text()).not.toContain('SELECT * FROM customers')
  expect(net.duplicate).toHaveBeenCalledTimes(1)
  expect(net.duplicate).toHaveBeenCalledWith('ca-1', 'account-1')
  expect(text()).toContain('来店の案内')
})

it('CSVの可否が未取得の間は書き出す操作を出さず、確認後だけ出す', async () => {
  net.exportAllowed = null
  await act(async () => { root.render(<ListPage />) })
  await flush()
  expect(screen.queryByText('CSVで書き出す')).toBeNull()
  net.exportAllowed = true
  await act(async () => { root.render(<ListPage />) })
  expect(screen.getByText('CSVで書き出す')).toBeTruthy()
})

describe('共通アクションの未保存', () => {
  it('条件を追加したら移動前に確認し、続けると条件を保つ', async () => {
    await act(async () => { root.render(<EditPage />) })
    await flush()
    await act(async () => { buttonNamed('条件で分ける')!.click() })
    await flush()
    const link = document.createElement('a')
    link.href = '/templates'
    document.body.appendChild(link)
    await act(async () => { link.click() })
    await waitFor(() => expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy())
    await act(async () => { screen.getByRole('button', { name: '編集を続ける' }).click() })
    expect(buttonNamed('分岐を削除する')).toBeTruthy()
    link.remove()
  })

  it('追加した条件を元に戻すと離脱確認は出ない', async () => {
    await act(async () => { root.render(<EditPage />) })
    await flush()
    await act(async () => { buttonNamed('条件で分ける')!.click() })
    await act(async () => { buttonNamed('分岐を削除する')!.click() })
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('条件を追加した後の戻るを止める', async () => {
    await act(async () => { root.render(<EditPage />) })
    await flush()
    await act(async () => { buttonNamed('条件で分ける')!.click() })
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect(go).toHaveBeenCalledWith(1)
  })


  it('保存競合後の読み直しは確認し、編集を続けると条件を保つ', async () => {
    const { ApiError } = await import('@/lib/api')
    net.updateDraft.mockRejectedValue(new ApiError(409, '競合'))
    await act(async () => { root.render(<EditPage />) })
    await flush()
    await act(async () => { buttonNamed('条件で分ける')!.click() })
    await act(async () => { buttonNamed('下書きを保存する')!.click() })
    await flush()
    expect(buttonNamed('最新の内容を読み込み直す')).toBeTruthy()
    await act(async () => { buttonNamed('最新の内容を読み込み直す')!.click() })
    expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    await act(async () => { screen.getByRole('button', { name: '編集を続ける' }).click() })
    expect(buttonNamed('分岐を削除する')).toBeTruthy()
    expect(net.getCount).toBe(1)
  })


  it('保存中は入力を固定し、戻るを止める', async () => {
    net.updateDraft.mockReturnValue(new Promise(() => {}))
    await act(async () => { root.render(<EditPage />) })
    await flush()
    await act(async () => { buttonNamed('条件で分ける')!.click() })
    await act(async () => { buttonNamed('下書きを保存する')!.click() })
    expect(screen.getByRole('group', { name: '入力内容' }).hasAttribute('disabled')).toBe(true)
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(go).toHaveBeenCalledWith(1)
    expect(net.updateDraft).toHaveBeenCalledTimes(1)
  })


  it('変更前の内容を保存中でも戻るを止める', async () => {
    net.updateDraft.mockReturnValue(new Promise(() => {}))
    await act(async () => { root.render(<EditPage />) })
    await flush()
    await act(async () => { buttonNamed('下書きを保存する')!.click() })
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(go).toHaveBeenCalledWith(1)
  })

})
