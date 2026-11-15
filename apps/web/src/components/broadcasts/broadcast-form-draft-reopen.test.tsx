// @vitest-environment happy-dom
/*
 * 保存済み下書きを作成画面で開き直して本文を直す試験（BROADCAST-17 / #1061）。
 *
 * 詳細画面の「本文を編集」から /broadcasts/new?draft=<id>&step=message へ来る。
 * 見る筋書き:
 *   1. 下書きを指定して開くと、保存した内容が画面へ入る。
 *   2. 「下書き保存」は新規作成ではなく、いまの版を付けて同じIDへ更新する。
 *   3. 送信済み・複数アカウント横断・別アカウントの下書きは開かせない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const createApi = vi.hoisted(() => vi.fn())
const updateApi = vi.hoisted(() => vi.fn())
const getApi = vi.hoisted(() => vi.fn())
const query = vi.hoisted(() => ({ current: 'draft=draft-1&step=message' }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const emptyList = async () => ({ success: true, data: [] })
  return {
    ...actual,
    api: {
      ...actual.api,
      broadcasts: {
        ...actual.api.broadcasts,
        create: createApi,
        update: updateApi,
        get: getApi,
        list: async () => ({ success: true, data: [] }),
        preflight: async () => ({ success: true, data: { audienceCount: 10 } }),
        previewCount: async () => ({ success: true, data: { count: 10 } }),
      },
      staff: { me: async () => ({ success: true, data: { role: 'owner' } }) },
      featureSettings: { visibility: async () => ({ success: true, data: {} }) },
      folders: { list: emptyList },
      scenarios: { list: emptyList },
      commonVars: { list: emptyList },
      friendFields: { list: emptyList },
      broadcastMessageAssets: { list: emptyList, upload: emptyList },
      templates: { list: emptyList },
      commonActions: { resources: async () => ({ success: true, data: [] }) },
      accountSettings: { getTestRecipients: async () => ({ success: true, data: [] }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/broadcasts/new',
  useSearchParams: () => new URLSearchParams(query.current),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))

// api.ts は読み込み時に NEXT_PUBLIC_API_URL を要求する。画面の
// import より先に立てておく（vi.hoisted は import より先に評価される）。
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import BroadcastForm from './broadcast-form'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let step = 0; step < 12; step += 1) await Promise.resolve()
  })
}

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    lineAccountId: 'acc-1',
    title: '秋のキャンペーン告知',
    messageType: 'text',
    messageContent: '保存していた本文',
    messageBubbles: null,
    targetType: 'all',
    targetTagId: null,
    segmentConditions: null,
    scheduledAt: null,
    status: 'draft',
    draftStep: 'message',
    draftPayload: null,
    messageOptions: null,
    afterActionVersionId: null,
    trackLinks: false,
    version: 7,
    ...over,
  }
}

async function renderForm() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<BroadcastForm tags={[]} onSuccess={() => {}} onCancel={() => {}} />)
  })
  await flush()
}

function unmount() {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
  query.current = 'draft=draft-1&step=message'
}

function titleInput(): HTMLInputElement | null {
  return container.querySelector('input[placeholder="例：8月キャンペーンのお知らせ"]')
}

function saveButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === '下書きを保存する' && !button.disabled,
  )
}

describe('下書きの開き直しと再編集（BROADCAST-17）', () => {
  it('下書きIDで開くと保存した内容が入り、保存は同じIDへの更新になる', async () => {
    getApi.mockResolvedValue({ success: true, data: draftRow() })
    updateApi.mockResolvedValue({ success: true, data: { id: 'draft-1', version: 8 } })
    await renderForm()
    try {
      expect(getApi).toHaveBeenCalledWith('draft-1')
      // 保存していた題と本文が画面へ入っている（＝書き直せる）。
      expect(titleInput()?.value).toBe('秋のキャンペーン告知')
      const body = container.querySelector('[role="textbox"][placeholder="テキストを入力"]') as HTMLTextAreaElement | null
      expect(body?.value).toBe('保存していた本文')

      await act(async () => {
        saveButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
      expect(createApi).not.toHaveBeenCalled()
      expect(updateApi).toHaveBeenCalledTimes(1)
      expect(updateApi.mock.calls[0][0]).toBe('draft-1')
      expect(updateApi.mock.calls[0][1]).toMatchObject({ expectedVersion: 7 })
    } finally {
      unmount()
    }
  })

  it('送信済みの配信は開かせない', async () => {
    getApi.mockResolvedValue({ success: true, data: draftRow({ status: 'sent' }) })
    await renderForm()
    try {
      expect(container.textContent).toContain('この配信はすでに送信が始まっているため、ここでは編集できません')
      expect(titleInput()?.value ?? '').not.toBe('秋のキャンペーン告知')
    } finally {
      unmount()
    }
  })

  it('複数アカウントへまたぐ下書きは開かせない', async () => {
    getApi.mockResolvedValue({ success: true, data: draftRow({ targetType: 'multi-account-dedup' }) })
    await renderForm()
    try {
      expect(container.textContent).toContain('複数アカウントへ配る配信は、この画面では編集できません')
    } finally {
      unmount()
    }
  })

  it('別アカウントの下書きは開かせない', async () => {
    getApi.mockResolvedValue({ success: true, data: draftRow({ lineAccountId: 'acc-other' }) })
    await renderForm()
    try {
      expect(container.textContent).toContain('この下書きは別のLINEアカウントで作られています')
    } finally {
      unmount()
    }
  })
})

it('WEB258: 明示的な分散0分を開き直しても30分へ変えない', async () => {
  getApi.mockResolvedValue({ success: true, data: draftRow({ draftPayload: { stealthSpreadMinutes: 0 } }) })
  updateApi.mockResolvedValue({ success: true, data: { id: 'draft-1', version: 8 } })
  await renderForm()
  try {
    await act(async () => saveButton()!.click()); await flush()
    expect(updateApi.mock.calls[0][1].stealthSpreadMinutes).toBe(0)
  } finally { unmount() }
})

it.each(['now', 'scheduled'])('古い%sの印より予約の現在日時と分散を使って開く', async (draftSendChoice) => {
  getApi.mockResolvedValue({ success: true, data: draftRow({ status: 'scheduled', scheduledAt: '2099-01-02T01:00:00.000Z', stealthSpreadMinutes: 45, draftPayload: { draftSendChoice, stealthSpreadMinutes: 0, draftScheduledDate: '2020-01-01', draftScheduledTime: '01:00' } }) })
  await renderForm()
  try {
    expect(container.querySelector<HTMLInputElement>('input[name="broadcast-send-mode"][value="spread"]')!.checked).toBe(true)
    expect(container.querySelector<HTMLInputElement>('#bc-spread')!.value).toBe('45')
    expect(container.querySelector<HTMLButtonElement>('#bc-date')!.title).toMatch(/^2099年1月2日/)
    expect(container.querySelector<HTMLInputElement>('#bc-time')!.value).toBe('10 : 00')
  } finally { unmount() }
})

it.each([
  { label: '旧全員', row: { targetType: 'all', draftPayload: null }, checked: null },
  { label: '明示した全員', row: { targetType: 'all', draftPayload: { draftTargetMode: 'all' } }, checked: 'all' },
  { label: '旧全員条件', row: { targetType: 'segment', segmentConditions: { operator: 'AND', rules: [{ type: 'is_following', value: true }] }, draftPayload: null }, checked: null },
  { label: '明示した全員条件', row: { targetType: 'segment', segmentConditions: { operator: 'AND', rules: [{ type: 'is_following', value: true }] }, draftPayload: { draftTargetMode: 'all' } }, checked: 'all' },
  { label: 'タグの書きかけ', row: { targetType: 'tag', targetTagId: null, draftPayload: { draftTargetMode: 'tag' } }, checked: 'tag' },
  { label: '予約済みの全員', row: { targetType: 'all', status: 'scheduled', scheduledAt: '2099-01-01T00:00:00Z', draftPayload: null }, checked: 'all' },
  { label: '未選択', row: { targetType: 'tag', targetTagId: null, segmentConditions: null, draftPayload: { draftTargetMode: 'unselected' } }, checked: null },
  { label: '保存済みのタグ', row: { targetType: 'tag', targetTagId: 'tag-1', segmentConditions: null, draftPayload: { draftTargetMode: 'unselected' } }, checked: 'tag' },
  { label: '保存済みの購読条件', row: { targetType: 'segment', segmentConditions: { operator: 'AND', rules: [{ type: 'is_following', value: true }, { type: 'scenario_subscribed', value: 'scenario-1' }] }, draftPayload: { draftTargetMode: 'unselected' } }, checked: 'scenario' },
])('$label: 下書きは、実物の宛先を優先し全員へ化けずに戻る', async ({ row, checked }) => {
  getApi.mockResolvedValue({ success: true, data: draftRow(row) })
  updateApi.mockResolvedValue({ success: true, data: { id: 'draft-1', version: 8 } })
  await renderForm()
  try {
    const selected = container.querySelector<HTMLInputElement>('input[name="broadcast-target-mode"]:checked')
    expect(selected?.value ?? null).toBe(checked)
    if (!checked) {
      await act(async () => saveButton()!.click()); await flush()
      expect(updateApi.mock.calls[0][1]).toMatchObject({ saveAsDraft: true, targetType: 'tag', targetTagId: '', draftTargetMode: 'unselected' })
    }
  } finally { unmount() }
})

it('訂正の本文を保存しても元の宛先を保つ', async () => {
  const conditions = { operator: 'AND', rules: [{ type: 'is_following', value: true }] }
  getApi.mockResolvedValue({ success: true, data: draftRow({ correctionOfBroadcastId: 'source', targetType: 'segment', segmentConditions: conditions }) })
  updateApi.mockResolvedValue({ success: true, data: { id: 'draft-1', version: 8 } })
  await renderForm()
  try {
    await act(async () => saveButton()!.click())
    await flush()
    expect(updateApi).toHaveBeenCalledWith('draft-1', expect.objectContaining({ targetType: 'segment', segmentConditions: conditions, expectedVersion: 7 }))
  } finally { unmount() }
})

it('訂正の作成時に外れた人数を下書きで知らせる', async () => {
 const conditions={operator:'AND',rules:[{type:'is_following',value:true}]}
 getApi.mockResolvedValue({success:true,data:draftRow({correctionOfBroadcastId:'source',correctionExcludedAtCreation:2,targetType:'segment',segmentConditions:conditions})})
 await renderForm()
 try { expect(container.textContent).toContain('2人は友だちから外れたため除きました') } finally { unmount() }
})
