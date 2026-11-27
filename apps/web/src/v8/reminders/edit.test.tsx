// @vitest-environment happy-dom
/*
 * V8 リマインダを作る②〜⑤・完了（src/v8/reminders/edit.tsx）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 型（CreatePage）の中に出る・保存して次の手順へ進む・競合（409）の帯が出る・単位の切り替え・完了の行き先。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const pushMock = vi.hoisted(() => vi.fn())

const draftStore = vi.hoisted(() => ({
  draft: null as null | Record<string, unknown>,
  conflict: false,
  saved: [] as Array<Record<string, unknown>>,
  wait: null as Promise<void> | null,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) =>
    React.createElement('a', { href, className }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/reminders/edit',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false }) }))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return {
    ApiError,
    fetchApi: vi.fn(async () => ({ success: true, data: {} })),
    eventsApi: { listEvents: vi.fn(async () => ({ items: [] })) },
    api: {
      // 下書きの自動保存は閲覧のみの人には動かさないため、役割を読む。
      staff: { me: async () => ({ success: true, data: { role: 'owner' } }) },
      reminders: {
        getDraft: vi.fn(async () => ({ success: true, data: draftStore.draft })),
        saveDraft: vi.fn(async (_id: string, settings: Record<string, unknown>) => {
          if (draftStore.wait) await draftStore.wait
          if (draftStore.conflict) throw new ApiError(409, 'VERSION_CONFLICT')
          draftStore.saved.push(settings)
          draftStore.draft = { ...(draftStore.draft ?? {}), settings, versionId: 'v2', updatedAt: '2026-10-01T00:00:00Z' }
          return { success: true, data: draftStore.draft }
        }),
        validateDraft: vi.fn(async () => ({ success: true, data: { valid: true, checks: [], audience: { matched: 172, excluded: 14 } } })),
        previewDraft: vi.fn(async () => ({
          success: true,
          data: {
            targetDate: '2026-10-02T05:00:00.000Z',
            items: [
              { stableStepId: 's1', stepNumber: 1, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), label: '前日', state: 'scheduled' },
              { stableStepId: 's1', stepNumber: 1, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), label: '前日', state: 'duplicate' },
            ],
            summary: { audience: 172, next7Days: 124, next30Days: 400, duplicateCount: 3 },
          },
        })),
        audience: vi.fn(async () => ({ success: true, data: { matched: 5, excluded: 1, sample: [] } })),
        publishDraft: vi.fn(async () => ({ success: true, data: null })),
        getTestRecipient: vi.fn(async () => ({ success: true, data: { kind: 'unset' } })),
      },
      friendFields: { list: vi.fn(async () => ({ success: true, data: [] })) },
      folders: { list: vi.fn(async () => ({ success: true, data: [] })) },
    },
  }
})

import ReminderEditV8, { stageFor } from './edit'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function baseDraft() {
  return {
    reminderId: 'reminder-new',
    versionId: 'v1',
    versionNumber: 1,
    status: 'draft',
    lastTestStatus: null,
    lastTestedAt: null,
    publishedAt: null,
    updatedAt: '2026-09-30T00:00:00Z',
    settings: {
      name: '予約前日のご案内',
      description: null,
      lineAccountId: 'account-a',
      folderId: null,
      triggerType: 'booking',
      deliveryMode: 'time',
      triggerFieldId: null,
      triggerEventId: null,
      repeatYearly: false,
      leapYearPolicy: 'feb28',
      triggerOffsetMinutes: null,
      sendAtTime: null,
      targetTagId: null,
      targetCondition: null,
      stopConditions: { bookingCancelled: true, supportMarkCompleted: true, daysAfterTarget: 7, friendBlocked: true },
      steps: [
        { stableStepId: 's1', offsetMinutes: 0, offsetDays: -1, sendAtTime: '18:00', messageType: 'text', messageContent: '{名前}さん\n明日のご案内です。' },
        { stableStepId: 's2', offsetMinutes: -60, offsetDays: null, sendAtTime: null, messageType: 'text', messageContent: 'まもなくです。' },
      ],
    },
  }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  draftStore.draft = baseDraft()
  draftStore.conflict = false
  draftStore.saved = []
  pushMock.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

async function render(stage: string | null) {
  await act(async () => { root.render(<ReminderEditV8 reminderId="reminder-new" stage={stage} />) })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
}

const buttonByText = (text: string) =>
  [...document.querySelectorAll('button, a')].find((el) => el.textContent?.trim() === text) as HTMLElement | undefined

describe('V8 リマインダを作る②〜⑤', () => {
  it('今の画面と同じ ?stage= の名前を受け付ける', () => {
    expect(stageFor('target')).toBe('target')
    expect(stageFor(null)).toBe('messages')
    expect(stageFor('preview')).toBe('schedule')
    expect(stageFor('test')).toBe('confirm')
    expect(stageFor('done')).toBe('done')
  })

  it('対象者と止める条件（YChR6）は作る型の中に出て、保存すると通知の中身へ進む', async () => {
    await render('target')
    const frame = host.querySelector('[data-page-template="create"]')
    expect(frame?.getAttribute('data-design-node')).toBe('YChR6')
    expect(host.querySelector('[aria-label="設定済みの内容"]')?.textContent).toContain('予約前日のご案内・予約日時')
    await act(async () => { (host.querySelector('[aria-label="基本設定を変更する"]') as HTMLButtonElement).click() })
    expect(pushMock).toHaveBeenCalledWith('/reminders/edit?id=reminder-new&stage=basics')
    await act(async () => { (host.querySelector('svg[data-help-mark]')!.closest('button') as HTMLButtonElement).click() })
    expect(host.textContent).toContain('名前：予約前日のご案内・いまは下書きです')
    expect(host.textContent).toContain('186 人')
    expect(host.textContent).toContain('172 人')
    expect(host.querySelectorAll('[role="switch"], button[aria-pressed], input[type="checkbox"]').length).toBeGreaterThan(0)
    const next = buttonByText('次へ：通知の中身')
    expect(next).toBeTruthy()
    await act(async () => { next!.click() })
    for (let i = 0; i < 3; i += 1) await act(async () => {})
    expect(draftStore.saved).toHaveLength(1)
    expect(pushMock).toHaveBeenCalledWith('/reminders/edit?id=reminder-new')
  })

  it('保存が 409 のときは競合の帯（k32cn）を出し、比べる・読み込むを選べる', async () => {
    draftStore.conflict = true
    await render('basics')
    expect(buttonByText('設定内容を見る')).toBeTruthy()
    const save = buttonByText('下書きを保存')
    expect(save).toBeTruthy()
    await act(async () => { save!.click() })
    for (let i = 0; i < 3; i += 1) await act(async () => {})
    const frame = host.querySelector('[data-page-template="create"]')
    expect(frame?.getAttribute('data-design-node')).toBe('k32cn')
    const band = host.querySelector('[role="alert"]')
    expect(band?.textContent).toContain('ほかの人が先にリマインダ「予約前日のご案内」を保存しました')
    expect(buttonByText('違いを比べる')).toBeTruthy()
    expect(buttonByText('最新を読み込んで続ける')).toBeTruthy()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('通知の中身：開いた通知は日・前・時刻で書き、閉じた通知は本文の頭だけを出す', async () => {
    await render(null)
    // happy-dom の窓は幅 1024 なので、まず右の列からスマホの見え方を開く。
    expect(host.querySelector('[data-page-template="create"]')?.getAttribute('data-design-node')).toBe('r1l0bT')
    const previewButton = buttonByText('LINEでの見え方を見る')
    expect(previewButton).toBeTruthy()
    await act(async () => { previewButton!.click() })
    const help = document.querySelector<HTMLButtonElement>('button[aria-label="LINEでの見え方の説明"]')
    expect(help).toBeTruthy()
    await act(async () => { help!.click() })
    expect(document.body.textContent).toContain('名前や日時は見本の値です。')
    expect(host.querySelector('[aria-label="届く日時の例"]')?.textContent).toContain('2 通目')
    const cards = host.querySelectorAll('[data-open]')
    expect(cards).toHaveLength(1)
    expect(host.textContent).toContain('1日前 18:00')
    expect(host.textContent).toContain('まもなくです。…')
    // 送る時刻は ★V8 の時刻の欄（打てる欄・提案 YCOoR）。欄の字は「18 : 00」。
    expect((host.querySelector('input[aria-label="送る時刻"]') as HTMLInputElement | null)?.value).toBe('18 : 00')
    const add = buttonByText('通知を足す')
    await act(async () => { add!.click() })
    expect(host.textContent).toContain('3 通目')
  })

  it('通知の並べ替え：つまみのドラッグ・上下キー・「後ろへ」は同じ結果になる', async () => {
    const order = () => [...host.querySelectorAll<HTMLElement>('[data-reorder-id]')].map((el) => el.dataset.reorderId)
    const results: Array<Array<string | undefined>> = []
    for (const how of ['drag', 'key', 'button'] as const) {
      act(() => { root.unmount() })
      root = createRoot(host)
      draftStore.draft = baseDraft()
      await render(null)
      expect(order()).toEqual(['s1', 's2'])
      const grip = host.querySelector<HTMLButtonElement>('[data-reorder-id="s1"] button[data-reorder-handle]')
      expect(grip, 'つまみが動かせる形で出ていません').toBeTruthy()
      if (how === 'key') await act(async () => { grip!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
      if (how === 'button') {
        const later = [...host.querySelectorAll<HTMLElement>('[data-reorder-id="s1"] button')].find((el) => el.textContent?.trim() === '後ろへ')
        await act(async () => { later!.click() })
      }
      if (how === 'drag') {
        const target = host.querySelector<HTMLElement>('[data-reorder-id="s2"]')!
        await act(async () => { grip!.dispatchEvent(new Event('dragstart', { bubbles: true })) })
        await act(async () => { target.dispatchEvent(new Event('dragenter', { bubbles: true })) })
        await act(async () => { target.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })) })
        await act(async () => { target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })) })
      }
      for (let i = 0; i < 3; i += 1) await act(async () => {})
      results.push(order())
    }
    expect(results).toEqual([['s2', 's1'], ['s2', 's1'], ['s2', 's1']])
  })

  it('配信予定（T0nis）：重なりの行は「1通にまとめる」と出し、案内の帯で件数を言う', async () => {
    await render('preview')
    expect(host.querySelector('[data-page-template="create"]')?.getAttribute('data-design-node')).toBe('T0nis')
    expect(host.querySelector('button[aria-label="LINEでの見え方の説明"]')).toBeTruthy()
    expect(host.textContent).toContain('今後7日 124 通')
    expect(host.textContent).toContain('重なり→1通にまとめる')
    expect(host.textContent).toContain('1通にまとめて送ります（3 件）')
  })

  it('有効にした（hjNpJ）：下の帯は無く、一覧・配信予定・詳細へ行ける', async () => {
    await render('done')
    expect(host.querySelector('[data-design-node="hjNpJ"]')).toBeTruthy()
    expect(host.querySelector('[data-template-region="footer"]')).toBeNull()
    const completion = host.querySelector('[data-part="create-completion-heading"]')
    expect(completion?.querySelector('[aria-hidden="true"] svg')).toBeTruthy()
    expect(completion?.querySelector('h2')?.textContent).toContain('を有効にしました')
    expect(completion?.querySelector('p')?.textContent).toContain('一時停止する')
    expect(buttonByText('一覧へ戻る')?.getAttribute('href')).toBe('/reminders')
    expect(buttonByText('配信予定を見る')?.getAttribute('href')).toBe('/reminders/detail?id=reminder-new&tab=schedule&status=planned')
    expect(buttonByText('詳細を見る')?.getAttribute('href')).toBe('/reminders/detail?id=reminder-new')
  })
})

describe('V8 リマインダの下書き自動保存（一斉配信と同じ形）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  const status = () => host.querySelector('[data-autosave-status]')?.textContent ?? null
  const setName = async (value: string) => {
    const input = host.querySelector('#v8-reminder-name') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('基本設定を直して2秒止まると、下書きへ静かに保存し「下書き保存済み・0秒前」を出す（画面は移らない）', async () => {
    await render('basics')
    await setName('予約前日のご案内（改）')
    expect(status()).toBe('下書きはまだ保存していません')
    await wait(1900)
    expect(draftStore.saved).toHaveLength(0)
    await wait(200)
    for (let i = 0; i < 3; i += 1) await act(async () => {})
    expect(draftStore.saved).toHaveLength(1)
    expect((draftStore.saved[0] as { name: string }).name).toBe('予約前日のご案内（改）')
    expect(status()).toBe('下書き保存済み・0秒前')
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('自動保存が 409 なら競合の帯を出し、それ以上は送らない', async () => {
    draftStore.conflict = true
    await render('basics')
    await setName('予約前日のご案内（改）')
    await wait(2100)
    for (let i = 0; i < 3; i += 1) await act(async () => {})
    expect(host.querySelector('[data-page-template="create"]')?.getAttribute('data-design-node')).toBe('k32cn')
    draftStore.conflict = false
    await setName('予約前日のご案内（改2）')
    await wait(5000)
    expect(draftStore.saved).toHaveLength(0)
  })
})

it('WEB-087：手動保存中は追加編集を止める', async () => {
  await render('basics')
  let release!: () => void
  draftStore.wait = new Promise(resolve => { release = resolve })
  const name = host.querySelector('#v8-reminder-name') as HTMLInputElement
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(name, '保存する名前'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => buttonByText('下書きを保存')!.click())
  expect(name.closest('fieldset')?.disabled).toBe(true)
  await act(async () => release()); draftStore.wait = null
})
describe('監査 WEB079/080/082', () => {
  it('基準日の種類を印で区別し、イベントへ切り替えても予約の設定を保存しない', async () => {
    await render('basics')
    const event = host.querySelector<HTMLInputElement>('input[value="event"]')!
    expect(event.closest('[data-choice-card]')?.querySelector('.lucide-ticket')).toBeTruthy()
    expect(host.querySelector<HTMLInputElement>('input[value="booking"]')?.closest('[data-choice-card]')?.querySelector('.lucide-calendar-days')).toBeTruthy()
    await act(async () => event.click())
    expect(event.checked).toBe(true)
    expect(draftStore.saved).toHaveLength(0)
  })
  it('遅いフォルダ取得は、その間に入力した名前を消さない', async () => {
    const { api } = await import('@/lib/api')
    let complete!: (v: Awaited<ReturnType<typeof api.folders.list>>) => void
    vi.mocked(api.folders.list).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await render('basics')
    const input = host.querySelector('#v8-reminder-name') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新しい名前')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { complete({ success: true, data: [{ id: 'booking-folder', name: '予約', color: null }] }) })
    expect((host.querySelector('#v8-reminder-name') as HTMLInputElement).value).toBe('新しい名前')
  })
  it('条件に合う人だけを選ぶと空の条件編集を開き、未完成では次へ進まない', async () => {
    await render('target')
    const pick = [...host.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]')].find(el => el.textContent?.includes('条件に合う人だけ') || el.getAttribute('value') === 'condition')!
    await act(async () => { pick.click() })
    expect(host.querySelector('[aria-label="追加する条件を選択する"]')).toBeTruthy()
    await act(async () => { buttonByText('次へ：通知の中身')!.click() })
    expect(draftStore.saved).toHaveLength(0)
    expect(pushMock).not.toHaveBeenCalled()
  })
  it('手動保存待ち中の名前編集を応答で戻さない', async () => {
    const { api } = await import('@/lib/api')
    let complete!: (v: Awaited<ReturnType<typeof api.reminders.saveDraft>>) => void
    vi.mocked(api.reminders.saveDraft).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await render('basics')
    await act(async () => { buttonByText('下書きを保存')!.click() })
    const input = host.querySelector('#v8-reminder-name') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '保存待ちに入力')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { complete({ success: true, data: { ...baseDraft(), versionId: 'v2' } }) })
    expect((host.querySelector('#v8-reminder-name') as HTMLInputElement).value).toBe('保存待ちに入力')
  })
})

it('WEB081: 誕生日のひな形を確認して使うと通知日時と本文も入る',async()=>{
 await render('basics')
 const buttons=[...host.querySelectorAll('button')].filter(button=>button.textContent==='このひな形を使う')
 await act(async()=>buttons.at(-1)!.click())
 const confirm=[...document.querySelectorAll('[role="dialog"] button')].find(button=>button.textContent==='このひな形を使う')
 if(document.querySelector('[role="dialog"]')) await act(async()=>confirm!.click())
 await act(async()=>buttonByText('下書きを保存')!.click())
 const saved=draftStore.saved.at(-1) as { steps: unknown[] }
 expect(saved.steps).toHaveLength(1)
 expect(saved.steps[0]).toMatchObject({offsetDays:0,offsetMinutes:0,sendAtTime:'10:00',messageContent:'お誕生日おめでとうございます。いつもありがとうございます。'})
});
