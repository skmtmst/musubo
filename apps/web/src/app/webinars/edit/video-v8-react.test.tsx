import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * ★V8 動画と公開期間（）・開催回（）の描画。
 * 差し替えるのは通信だけ。段の見出し・枠の一覧・数え方が実在する。
 */
import { fireEvent } from '@testing-library/react'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  editor: vi.fn(),
  update: vi.fn(),
  saveEditor: vi.fn(),
  videoAsset: vi.fn(),
  advanceVideoAsset: vi.fn(),
  webinarSession: vi.fn(),
  setSessionCapacity: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, media: { ...actual.api.media, list: async () => ({ success: true, data: { items: [] } }) } },
    webinarApi: {
      editor: apiMocks.editor,
      update: apiMocks.update,
      saveEditor: apiMocks.saveEditor,
      videoAsset: apiMocks.videoAsset,
      advanceVideoAsset: apiMocks.advanceVideoAsset,
      webinarSession: apiMocks.webinarSession,
      setSessionCapacity: apiMocks.setSessionCapacity,
    },
  }
})

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
import WebinarVideoTestPane from '@/test-utils/webinar-video'
import type { Webinar, WebinarEditor } from '@/lib/api'

const WEBINAR = {
  id: 'webinar-1',
  accountId: 'account-1',
  title: 'NEN活用スタートセミナー',
  slug: 'nen-start',
  status: 'draft',
  videoPrefix: 'videos/nen-start.mp4',
  durationSeconds: 872,
  schedule: [
    { type: 'daily', time: '10:00' },
    { type: 'once', at: '2026-10-08T20:00:00+09:00' },
  ],
  cta: null,
  tagOnAttend: null,
  tagOnCtaClick: null,
  publicationStartsAt: '2026-10-01T10:00:00+09:00',
  publicationEndsAt: null,
  createdAt: '2026-09-01T00:00:00+09:00',
  updatedAt: '2026-10-01T00:00:00+09:00',
} as unknown as Webinar

const EDITOR = {
  version: 3,
  actionPolicy: { templateBody: '', missingResultPolicy: 'retry_next_day' },
} as WebinarEditor

const roots: Root[] = []
function render(editor = EDITOR): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  roots.push(root)
  act(() => root.render(<WebinarVideoTestPane initialWebinar={WEBINAR} initialEditor={editor} />))
  return host
}

describe('動画と公開期間のV8（VWNaA・LPOe7）', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = 'v8'
    vi.resetAllMocks()
    apiMocks.webinarSession.mockResolvedValue({ data: { session: null } })
    apiMocks.videoAsset.mockResolvedValue({ data: { asset: null } })
    apiMocks.editor.mockResolvedValue({ data: { version: 3 } })
    apiMocks.update.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({
      data: { ...WEBINAR, ...input },
    }))
  })

  afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    delete document.documentElement.dataset.theme
    vi.clearAllMocks()
  })

  it('板IDと4つの段を描く', () => {
    const host = render()
    expect(host.querySelector('[data-design-node="VWNaA"]')).not.toBeNull()
    for (const label of ['動画', '公開期間', '配信枠', '視聴の数え方', '公開ページでの見え方']) {
      expect(host.textContent).toContain(label)
    }
    expect(host.textContent).toContain('毎日')
    expect(host.textContent).toContain('単発')
  })

  it('取得した公開期間を表示し、変更せず保存しても開始日時を消さない', async () => {
    const host = render()
    expect(host.querySelector('#webinar-period-start')?.textContent).toContain('2026年10月1日')
    expect(host.querySelector('#webinar-period-start')?.textContent).toContain('10:00')
    const save = ([...host.querySelectorAll('button')].find((button) => button.textContent === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
    await act(async () => save.click())
    expect(apiMocks.update).not.toHaveBeenCalled()
    expect(host.querySelector('#webinar-period-start')?.textContent).toContain('10:00')
    expect(host.querySelector('#webinar-period-end')?.getAttribute('value')).toBe('なし（いつでも）')
  })

  it('枠を足すと保存の口へ枠つきで送る', async () => {
    const host = render()
    const add = ([...host.querySelectorAll('button')].find((el) => el.textContent?.includes('枠を足す')) ?? querySupplementaryPageAction('枠を足す'))
    expect(add).toBeDefined()
    await act(async () => {
      add!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const confirm = ([...document.querySelectorAll('[role="dialog"] button')].find((el) => el.textContent === '枠を足す') ?? querySupplementaryPageAction('枠を足す'))
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(apiMocks.update).toHaveBeenCalledTimes(1)
    const input = apiMocks.update.mock.calls[0][1] as { schedule: Array<{ type: string }> }
    expect(input.schedule).toHaveLength(3)
    expect(input.schedule[2]).toEqual({ type: 'daily', time: '10:00' })
  })

  it('枠を消すと枠なしで送る', async () => {
    const host = render()
    const menu = host.querySelector('button[aria-label="枠1の操作"]')
    expect(menu).not.toBeNull()
    await act(async () => {
      menu!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const remove = ([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === '消す') ?? querySupplementaryPageAction('消す'))
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(apiMocks.update).toHaveBeenCalledTimes(1)
    const input = apiMocks.update.mock.calls[0][1] as { schedule: unknown[] }
    expect(input.schedule).toHaveLength(1)
  })

  it('開催日時指定では既存の開催回の定員と申込を取得して表示する', async () => {
    apiMocks.webinarSession.mockResolvedValue({ data: { session: { capacity: 80, reservedCount: 32, remaining: 48, state: 'open' } } })
    let host!: HTMLElement
    await act(async () => { host = render({ ...EDITOR, deliveryKind: 'scheduled' }) })
    expect(host.querySelector('[data-design-node="LPOe7"]')).not.toBeNull()
    expect(apiMocks.webinarSession).toHaveBeenCalledWith('webinar-1', Math.floor(Date.parse(WEBINAR.schedule[1].at!) / 1000))
    expect(host.textContent).toContain('80 人')
    expect(host.textContent).toContain('32 人')
    expect(host.textContent).toContain('残り 48 人')
    expect(host.textContent).toContain('毎日')
  })

  it('動画の処理状況を取得し、差し替え操作は動画詳細を開く', async () => {
    apiMocks.videoAsset.mockResolvedValue({ data: { asset: { stage: 'inspecting' } } })
    let host!: HTMLElement
    await act(async () => { host = render() })
    expect(host.querySelector('[aria-current="step"]')?.textContent).toBe('検査')
    const replace = ([...host.querySelectorAll('button')].find((button) => button.textContent === '差し替える') ?? querySupplementaryPageAction('差し替える'))!
    await act(async () => replace.click())
    expect(document.querySelector('[role="dialog"][aria-labelledby]')?.textContent).toContain('動画を差し替える')
  })

  it.each([
    [{ capacity: 80, reservedCount: 32, remaining: 48, state: 'open' }, '残り 48 人', 'info'],
    [{ capacity: null, reservedCount: 32, remaining: null, state: 'open' }, '受付中', 'info'],
    [{ capacity: 80, reservedCount: 80, remaining: 0, state: 'full' }, '満員', 'warning'],
    [{ capacity: 80, reservedCount: 32, remaining: 48, state: 'closed' }, '受付終了', 'neutral'],
    [null, '定員なし', 'neutral'],
  ])('開催回の%sを正の状態札へ渡し、APIの状態を保存で変えない', async (session, label, tone) => {
    apiMocks.webinarSession.mockResolvedValue({ data: { session } })
    let host!: HTMLElement
    await act(async () => { host = render({ ...EDITOR, deliveryKind: 'scheduled' }) })
    const badge = ([...host.querySelectorAll('[data-design-node="xRvDB"]')].find(el => el.textContent === label) ?? querySupplementaryPageAction(label))
    expect(badge).toBeDefined()
    expect(badge?.getAttribute('data-tone')).toBe(tone)
    expect(badge?.querySelector('[data-truncated-text]')?.textContent).toBe(label)
    expect(apiMocks.setSessionCapacity).not.toHaveBeenCalled()
    expect(apiMocks.update).not.toHaveBeenCalled()
  })

  it('開催回の取得失敗は空きや満員として表示せず、再取得して残席を読む', async () => {
    apiMocks.webinarSession.mockRejectedValue(new Error('offline'))
    let host!: HTMLElement
    await act(async () => { host = render({ ...EDITOR, deliveryKind: 'scheduled' }) })
    expect(host.querySelector('[data-design-node="xRvDB"]')?.textContent).toBe('読み込めません')
    apiMocks.webinarSession.mockResolvedValue({ data: { session: { capacity: 80, reservedCount: 32, remaining: 48, state: 'open' } } })
    await act(async () => { ([...host.querySelectorAll('button')].find(el => el.textContent === 'もう一度読み込む') ?? querySupplementaryPageAction('もう一度読み込む'))!.click() })
    const badge = host.querySelector('[data-design-node="xRvDB"]')
    expect(badge?.textContent).toBe('残り 48 人')
    expect(badge?.getAttribute('data-tone')).toBe('info')
  })

  it('開催回の取得中は確定した残席や受付状態を表示しない', async () => {
    apiMocks.webinarSession.mockImplementation(() => new Promise(() => {}))
    let host!: HTMLElement
    await act(async () => { host = render({ ...EDITOR, deliveryKind: 'scheduled' }) })
    const badge = host.querySelector('[data-design-node="xRvDB"]')
    expect(badge?.textContent).toBe('確認中')
    expect(badge?.getAttribute('data-tone')).toBe('neutral')
    expect(host.textContent).not.toContain('残り 48 人')
  })

  it('公開期間だけを保存して更新日時が変わっても詳細の未保存入力を消さない', async () => {
    let finish!: (value: { data: Webinar }) => void
    apiMocks.update.mockImplementationOnce(() => new Promise<{ data: Webinar }>(resolve => { finish = resolve }))
    let host!: HTMLElement
    await act(async () => { host = render() })
    await act(async () => { (host.querySelector('#webinar-period-start') as HTMLButtonElement).click() })
    const time = document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-labelledby="webinar-period-start-time-label"]')!
    await act(async () => fireEvent.change(time, { target: { value: '11:00' } }))
    await act(async () => fireEvent.blur(time))
    await act(async () => { Array.from(document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')!.querySelectorAll('button')).find(button => button.textContent?.trim() === '確定')!.click() })
    const save = ([...host.querySelectorAll('button')].find((button) => button.textContent === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存'))!
    await act(async () => save.click())
    expect(apiMocks.update).toHaveBeenCalledWith('webinar-1', expect.objectContaining({ publicationStartsAt: '2026-10-01T02:00:00.000Z', publicationEndsAt: null }))
    await act(async () => ([...host.querySelectorAll('button')].find(button => button.textContent === '差し替える') ?? querySupplementaryPageAction('差し替える'))!.click())
    const input = document.querySelector<HTMLInputElement>('#wd-minutes')!
    await act(async () => fireEvent.change(input, { target: { value: '17' } }))
    await act(async () => { finish({ data: { ...WEBINAR, updatedAt: '2026-10-04T18:37:00+09:00' } }) })
    expect(document.querySelector<HTMLInputElement>('#wd-minutes')?.value).toBe('17')
  })
})
