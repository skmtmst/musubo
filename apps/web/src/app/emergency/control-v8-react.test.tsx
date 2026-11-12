// @vitest-environment happy-dom
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import type { LineAccount } from '@line-crm/shared'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import EmergencyControlV8 from '../../v8/emergency/control'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * ★V8-B 運用状態の緊急コントロール（板 ）の契約。
 * 新しい制御タブに切り替わり、何を止めますか・止めるアカウント・
 * 記録の表が出ること、権限が無い人には閲覧のみの帯が出て止める操作が
 * 灰色＋理由で残ること、止める確認の窓は「停止」の言葉が合うまで
 * 進めないことを実DOMで固定する。
 */
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }) }))
const accounts = [{ id: 'acc-1', name: '確認用アカウント' }] as LineAccount[]
const previewTargets: Array<string | null> = []

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={String(href)}>{children}</a>
  ),
}))

const impact = {
  broadcast_dispatch: { itemCount: 3, friendCount: 120, friendCountIsPartial: false, nearestScheduledAt: null, pendingCount: 0 },
  scenario_dispatch: { itemCount: 2, friendCount: 45, friendCountIsPartial: false, nearestScheduledAt: null, pendingCount: 0 },
  reminder_dispatch: { itemCount: 1, friendCount: 10, friendCountIsPartial: false, nearestScheduledAt: null, pendingCount: 0 },
  automation_actions: { itemCount: 0, friendCount: 0, friendCountIsPartial: false, nearestScheduledAt: null, pendingCount: 0 },
  auto_reply_dispatch: { itemCount: 1, friendCount: null, friendCountIsPartial: false, nearestScheduledAt: null, pendingCount: 0 },
}

const controlBase = {
  scopeKey: 'all',
  lineAccountId: null,
  version: 7,
  states: {
    broadcast_dispatch: 'running',
    scenario_dispatch: 'running',
    reminder_dispatch: 'running',
    automation_actions: 'running',
    auto_reply_dispatch: 'running',
  },
  activeIncidentId: null,
  reason: null,
  actorId: null,
  stoppedAt: null,
  updatedAt: '2026-10-02T06:00:00.000Z',
}

let canControl = true
let activeIncidentId: string | null = null

const response = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  verifiedStaffRole('owner')
  previewTargets.length = 0
  canControl = true
  activeIncidentId = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  stopCalls = []
  requestOrder = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/auth/step-up')) {
      requestOrder.push('step-up')
      return response({ success: true, data: { token: 'step-up-test-token' } })
    }
    if (url.includes('/restore-preview')) return response({ success: false, error: '閲覧のみです' }, 403)
    if (url.includes('/api/operations/incidents')) {
      requestOrder.push('incidents')
      const raw = (init as { body?: string } | undefined)?.body
      stopCalls.push({ url, body: (raw ? JSON.parse(raw) : {}) as Record<string, unknown>, headers: new Headers(init?.headers) })
      return response({ success: true, data: { status: 'changed', control: controlBase, incident: null } })
    }
    if (url.includes('/api/operations/control/preview')) {
      const target = new URL(url, 'http://worker.test').searchParams.get('account_id')
      previewTargets.push(target)
      return response({
        success: true,
        data: {
          control: { ...controlBase, scopeKey: target ?? 'all', lineAccountId: target, activeIncidentId, stoppedAt: activeIncidentId ? '2026-10-02T06:00:00.000Z' : null },
          counts: {},
          impact,
          permissions: { canControl },
          calculatedAt: '2026-10-02T06:00:00.000Z',
        },
      })
    }
    if (url.includes('/api/operations/history')) {
      return response({ success: true, data: [] })
    }
    return response({ success: false, error: 'not mocked' }, 500)
  }))
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  host?.remove()
  root = null
  host = null
  vi.unstubAllGlobals()
})

test('記録の読み込み中は表の形の骨組みが出て「読み込み中」の文字は無い', async () => {
  vi.useFakeTimers()
  try {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/operations/control/preview')) {
        return response({
          success: true,
          data: {
            control: controlBase,
            counts: {},
            impact,
            permissions: { canControl },
            calculatedAt: '2026-10-02T06:00:00.000Z',
          },
        })
      }
      // 記録だけ返さず、読み込み中のままにする。
      if (url.includes('/api/operations/history')) return new Promise<Response>(() => {})
      return response({ success: false, error: 'not mocked' }, 500)
    }))
    await act(async () => {
      root?.render(<EmergencyControlV8 accounts={accounts} />)
    })
    await act(async () => {
      vi.advanceTimersByTime(350)
    })
    expect(host?.querySelector('[aria-label="止めた・戻した記録を読み込んでいます"]')).not.toBeNull()
    expect(host?.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0)
    expect(host?.textContent).not.toContain('読み込み中')
  } finally {
    vi.useRealTimers()
  }
})

async function renderControl() {
  await act(async () => {
    root?.render(<EmergencyControlV8 accounts={accounts} />)
  })
  /* 口（preview・history）の応答が返って描き終わるまで待つ。 */
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

test('新しい制御タブ（OHwbU）が出る', async () => {
  await renderControl()
  expect(previewTargets[0]).toBeNull()
  expect(host?.querySelector('[data-design-node="OHwbU"]')).not.toBeNull()
  expect(host?.textContent).toContain('何を止めますか')
  expect(host?.textContent).toContain('止めた・戻した記録')
  const labels = Array.from(host?.querySelectorAll('[data-kpi-label]') ?? [])
  expect(labels.find(label => label.textContent === '止めた回数')?.querySelector('.lucide-octagon-pause')).toBeTruthy()
  expect(labels.find(label => label.textContent === 'いまの版')?.querySelector('.lucide-git-branch')).toBeTruthy()
})

test('PKG107: 閲覧のみには停止操作を灰色で残し、状態と記録を残す', async () => {
  canControl = false
  verifiedStaffRole('viewer')
  await renderControl()
  expect(previewTargets[0]).toBe('acc-1')
  expect(host?.textContent).toContain('閲覧のみで見ています')
  const stopButton = Array.from(host?.querySelectorAll('button') ?? [])
    .find((button) => button.textContent === '選んだものを止める')
  await expectPermissionLocked(stopButton)
  const checkboxes = [...host!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(checkboxes).toHaveLength(4)
  expect(checkboxes.every(box => box.disabled)).toBe(true)
  expect(stopCalls).toHaveLength(0)
  // 対象アカウントは状態を見るためにも使うので、閲覧だけでも選べる。
  expect(host?.querySelector('[aria-label="緊急停止の対象アカウント"]')).not.toBeNull()
  expect(host?.textContent).toContain('止めた・戻した記録')
})

/*
 * 板 （緊急停止の確認を1枚の窓に）の契約。対象・理由必須・
 * 確認の言葉・認証番号が1枚にそろい、1つでも欠けたら進めない。
 * 中身は口（preview）の実データを出す。絵の数は書かない。
 */
let stopCalls: Array<{ url: string; body: Record<string, unknown>; headers?: Headers }> = []
let requestOrder: string[] = []

async function openStopDialog() {
  await renderControl()
  const stopButton = Array.from(host?.querySelectorAll('button') ?? [])
    .find((button) => button.textContent === '選んだものを止める')
  expect(stopButton).toBeDefined()
  await act(async () => {
    ;(stopButton as HTMLButtonElement | undefined)?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  /* 確認の窓は body 直下に出る（ポータル）。 */
  expect(document.body.querySelector('[data-design-node="EA8rM"]')).not.toBeNull()
}

function typeText(input: HTMLInputElement, text: string) {
  input.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/* act の外で打つと state に届かないことがあるので、1文字ずつ中で流す。 */
async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    typeText(input, text)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function dialogInput(label: string): HTMLInputElement {
  const el = Array.from(document.body.querySelectorAll('input'))
    .find((input) => input.getAttribute('aria-label') === label)
  expect(el, `入力欄「${label}」がある`).toBeDefined()
  return el as HTMLInputElement
}

async function typeCode(digits: string) {
  for (let i = 0; i < digits.length; i++) {
    const slot = document.body.querySelector(`input[aria-label="${i + 1}桁目"]`) as HTMLInputElement
    expect(slot, `${i + 1}桁目のマスがある`).toBeDefined()
    await act(async () => {
      typeText(slot, digits[i])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function executeButton(): HTMLButtonElement {
  // 確認の窓の中の実行ボタン。帯（stickyBar）にも同じ文言があるため窓の中に限る。
  const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]')
  expect(dialog, '確認の窓がある').not.toBeNull()
  const button = Array.from(dialog!.querySelectorAll('button'))
    .find((button) => button.textContent === '緊急停止する')
  expect(button, '「緊急停止する」がある').toBeDefined()
  return button as HTMLButtonElement
}

test('EA8rM: 止める対象を口の実データで出す', async () => {
  await openStopDialog()
  const dialog = document.body.querySelector('[data-design-node="EA8rM"]')
  expect(dialog?.textContent).toContain('止める対象')
  // preview の影響数（モックの口の値）がそのまま出る。
  expect(dialog?.textContent).toContain('120')
  expect(dialog?.textContent).toContain('止める理由')
  expect(dialog?.textContent).toContain('確認のため「停止」と入力')
  expect(executeButton().hasAttribute('disabled')).toBe(true)
})

test('EA8rM: 理由だけ・言葉違いでは進めない', async () => {
  await openStopDialog()
  // 理由だけでは進めない。
  await typeInto(dialogInput('止める理由'), '宛先の絞り込みを間違えた')
  expect(executeButton().hasAttribute('disabled')).toBe(true)
  // 言葉が違うと進めない。
  await typeInto(dialogInput('確認の言葉'), 'ていし')
  expect(executeButton().hasAttribute('disabled')).toBe(true)
})

test('EA8rM: 番号が5桁では進めない', async () => {
  await openStopDialog()
  await typeInto(dialogInput('止める理由'), '宛先の絞り込みを間違えた')
  await typeInto(dialogInput('確認の言葉'), '停止')
  await typeCode('48151')
  expect(executeButton().hasAttribute('disabled')).toBe(true)
})

test('EA8rM: そろって進めるようになっても理由を抜いたら止まる', async () => {
  await openStopDialog()
  await typeInto(dialogInput('止める理由'), '宛先の絞り込みを間違えた')
  await typeInto(dialogInput('確認の言葉'), '停止')
  await typeCode('481516')
  expect(executeButton().hasAttribute('disabled')).toBe(false)
  // 理由を抜いたらまた止まる。
  await typeInto(dialogInput('止める理由'), '')
  expect(executeButton().hasAttribute('disabled')).toBe(true)
})

test('EA8rM: 全部そろうと本人確認の上で止める', async () => {
  await openStopDialog()
  await typeInto(dialogInput('止める理由'), '宛先の絞り込みを間違えた')
  await typeInto(dialogInput('確認の言葉'), '停止')
  await typeCode('481516')
  const button = executeButton()
  expect(button.hasAttribute('disabled')).toBe(false)
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  const stop = stopCalls.find((call) => call.url.includes('/api/operations/incidents'))
  expect(stop, '停止の口を呼ぶ').toBeDefined()
  expect(stop?.body['reason']).toBe('宛先の絞り込みを間違えた')
  expect(stop?.body['confirmation']).toBe('停止')
  expect(host?.textContent).toContain('サーバー共通の停止状態を更新しました')
})

test('EA8rM: 窓に止める対象・止まらないもの・取り消せないこと・本人確認の方法を出す', async () => {
  await openStopDialog()
  const dialog = document.body.querySelector('[data-design-node="EA8rM"]')
  expect(dialog?.textContent).toContain('すべてのLINEアカウント')
  expect(dialog?.textContent).toContain('環境')
  expect(dialog?.textContent).toContain('停止前にすでに LINE へ渡したものは取り消せません。')
  expect(dialog?.textContent).toMatch(/止まらないもの：.*受信箱からの手の返信/)
  expect(dialog?.textContent).toContain('本人確認（認証アプリの6桁）')
})

test('EA8rM: 止める要求は本人確認のあとに、一回限りの証明と再実行キーを付けて送る', async () => {
  await openStopDialog()
  await typeInto(dialogInput('止める理由'), '宛先の絞り込みを間違えた')
  await typeInto(dialogInput('確認の言葉'), '停止')
  await typeCode('481516')
  await act(async () => {
    executeButton().click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  expect(requestOrder).toEqual(['step-up', 'incidents'])
  const headers = stopCalls[0]?.headers
  expect(headers?.get('X-Step-Up-Token')).toBe('step-up-test-token')
  expect(headers?.get('X-Confirm-Irreversible')).toBe('operation-stop')
  expect(headers?.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)

})

test('自動処理を選んで止めると、オートメーションと自動応答の両方を止める', async () => {
  await renderControl()
  const automations = Array.from(host?.querySelectorAll('label') ?? [])
    .find((label) => label.textContent?.includes('自動処理'))?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined
  expect(automations, '自動処理の選択がある').toBeDefined()
  await act(async () => {
    automations?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const stopButton = Array.from(host?.querySelectorAll('button') ?? [])
    .find((button) => button.textContent === '選んだものを止める')
  await act(async () => {
    ;(stopButton as HTMLButtonElement | undefined)?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(document.body.querySelector('[data-design-node="EA8rM"]')?.textContent).toContain('自動応答')
  await typeInto(dialogInput('止める理由'), '自動応答の文面を間違えた')
  await typeInto(dialogInput('確認の言葉'), '停止')
  await typeCode('481516')
  await act(async () => {
    executeButton().click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  expect(stopCalls[0]?.body['capabilities']).toEqual(expect.arrayContaining(['automation_actions', 'auto_reply_dispatch']))
})

/* 監査 WEB313：補足（任意）に書いた文を、止める要求に乗せる。 */
test('WEB313: 補足を書いたら止める要求の detail に入る', async () => {
  await openStopDialog()
  await typeInto(dialogInput('止める理由'), '宛先の絞り込みを間違えた')
  const detail = document.body.querySelector('#emergency-detail-v8') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(detail, '13時の配信が全員に向いていた')
    detail.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await typeInto(dialogInput('確認の言葉'), '停止')
  await typeCode('481516')
  await act(async () => {
    executeButton().click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  const stop = stopCalls.find((call) => call.url.includes('/api/operations/incidents'))
  expect(stop?.body['detail']).toBe('13時の配信が全員に向いていた')
})

/* 監査 WEB312：停止状態が読めないとき、「動いている」「止めていません」と言わない。 */
test('WEB312: 状態が読めないときは「—」と読み直しを出す', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/operations/control/preview')) return response({ success: false, error: 'down' }, 503)
    if (url.includes('/api/operations/history')) return response({ success: true, data: [] })
    return response({ success: false, error: 'not mocked' }, 500)
  }))
  await renderControl()
  const kpis = host?.querySelector('[aria-label="緊急停止の集計"]')
  expect(kpis?.textContent).not.toContain('動いている')
  expect(host?.textContent).not.toContain('いまは止めていません')
  expect(host?.textContent).toContain('いまの停止状態を確認できませんでした')
})

test('PKG107: 停止中の閲覧のみでは復旧操作を灰色で残し、停止の状態を読める', async () => {
  canControl = false
  verifiedStaffRole('viewer')
  activeIncidentId = 'incident-1'
  await renderControl()
  expect(previewTargets[0]).toBe('acc-1')
  expect(host?.textContent).toContain('止めているとき')
  await expectPermissionLocked([...host!.querySelectorAll('button')].find((el) => el.textContent?.trim() === '復旧する'))
  expect(stopCalls).toHaveLength(0)
 })

afterEach(() => { verifiedStaffRole(null) })
