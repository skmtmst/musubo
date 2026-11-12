import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * V8 シナリオ配信の編集（src/v8/scenario-detail）の動きの試験。BEHAVIOR.md の「今までと変えたところ」を守る。
 * - V8 のテーマで、絵の操作がそろって出る
 * - 閲覧のみ：帯が出て、変える操作のボタンは置かない（押せないボタンを残さない）
 * - 保存が 409（ほかの人が先に保存）なら競合の帯と「比べてから保存」
 * - 下の帯の「複製する」で複製の窓が「〇〇 のコピー」で開く
 * - 選んだ通の中身がスマホに出る（空の箱にしない）
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const updateScenario = vi.hoisted(() => vi.fn())
const createScenario = vi.hoisted(() => vi.fn())
const triggerList = vi.hoisted(() => vi.fn(async () => ({ success: true, data: [{ id: 't1', kind: 'friend_add', tagId: null }] })))
const getScenario = vi.hoisted(() => vi.fn())
const pageTitle = vi.hoisted(() => vi.fn())

const scenario = vi.hoisted(() => ({
  id: 'sc-1',
  name: '新規登録7日間フォロー',
  description: '',
  triggerType: 'friend_add',
  isActive: true,
  contentRevision: 1,
  allowConcurrent: true,
  folderId: null,
  deliveryMode: 'absolute_time',
  onCompleteMode: 'pause',
  lineAccountId: 'account-a',
  audienceCondition: null,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-10-01T05:02:00.000Z',
  steps: [
    {
      id: 'step-1', stepOrder: 1, delayMinutes: 0, offsetDays: 0, offsetMinutes: null, deliveryTime: '10:00',
      templateId: null, onReachTagId: null, afterSend: 'continue', messageType: 'text',
      messageContent: 'ご登録ありがとうございます。', targetCondition: null, question: null, isDraft: false,
    },
    {
      id: 'step-2', stepOrder: 2, delayMinutes: 0, offsetDays: 1, offsetMinutes: null, deliveryTime: '20:00',
      templateId: null, onReachTagId: null, afterSend: 'pause', messageType: 'text',
      messageContent: '使い方のポイント', targetCondition: null, question: null, isDraft: false,
    },
  ],
}))

vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => true }) }))
vi.mock('@/lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message?: string) {
      super(message)
      this.status = status
    }
  },
  api: {
    scenarios: {
      create: createScenario,
      get: getScenario,
      update: updateScenario,
      confirmation: vi.fn(async () => ({ success: true, data: { contentRevision: 1, activeCount: 116, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 116, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] } })),
      simulate: vi.fn(async () => ({ success: true, data: { audience: { newStartPlanned: 116 }, steps: [] } })),
      runs: vi.fn(async () => ({
        success: true,
        data: { steps: [], subscriptions: [], testSends: [], quota: { remaining: null, state: 'unlimited' } },
      })),
      triggers: { list: triggerList },
      actions: { list: vi.fn(async () => ({ success: true, data: [] })) },
      preview: vi.fn(async () => ({ success: true, data: { steps: [] } })),
    },
    folders: { list: vi.fn(async () => ({ success: true, data: [] })) },
    staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) },
  },
}))

vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: vi.fn(async () => ({ success: true, data: scenario })),
    stats: vi.fn(async () => ({
      success: true,
      data: { enrolledTotal: 428, activeNow: 116, completed: 312, paused: 0, steps: [] },
    })),
    templates: vi.fn(async () => ({ success: true, data: [] })),
    tags: vi.fn(async () => ({ success: true, data: [] })),
    friendFields: vi.fn(async () => ({ success: true, data: [] })),
    supportMarks: vi.fn(async () => ({ success: true, data: [] })),
    scenarios: vi.fn(async () => ({ success: true, data: [] })),
    commonVars: vi.fn(async () => ({ success: true, data: [] })),
    reminders: vi.fn(async () => ({ success: true, data: [] })),
    events: vi.fn(async () => ({ success: true, data: [] })),
    invalidateScenario: vi.fn(),
  },
}))

vi.mock('@/components/scenarios/trigger-editor', () => ({
  default: ({ onChanged, onClose }: { onChanged?: (count: number) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="開始のきっかけ（試験）">
      <button type="button" onClick={() => { onChanged?.(1); onClose() }}>きっかけを保存（試験）</button>
    </div>
  ),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/scenarios/detail',
  useSearchParams: () => new URLSearchParams('id=sc-1'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: '本店' },
    accounts: [{ id: 'account-a', name: '本店' }],
    loading: false,
  }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: pageTitle,
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import ScenarioDetailV8 from './detail'
import ScenarioDetailPage from '@/app/scenarios/detail/page'
import { scenarioReferenceData } from '@/components/scenarios/scenario-reference-data'
import { ApiError } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function render(node: React.ReactNode = <ScenarioDetailV8 scenarioId="sc-1" showStarted={false} />) {
  if (role.value) rememberStaffIdentity({ role: role.value } as StaffMember); else forgetStaffIdentity()
  act(() => {
    root.render(node)
  })
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  await screen.findByRole('heading', { level: 1, name: '新規登録7日間フォロー' })
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  role.value = 'owner'
  updateScenario.mockReset()
  createScenario.mockReset()
  updateScenario.mockResolvedValue({ success: true, data: { id: 'sc-1' } })
  getScenario.mockReset()
  getScenario.mockResolvedValue({ success: true, data: { ...scenario, updatedAt: '2026-10-01T05:10:00.000Z' } })
  vi.mocked(scenarioReferenceData.scenario).mockReset()
  vi.mocked(scenarioReferenceData.scenario).mockResolvedValue({ success: true, data: scenario })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  forgetStaffIdentity()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

describe('V8 シナリオ配信の編集', () => {
  it('読み込んだシナリオ名をパンくずの画面名に使う', async () => {
    await render()
    expect(pageTitle).toHaveBeenLastCalledWith('新規登録7日間フォロー')
  })

  it.each([
    'こんにちは、{{name}}さん。{{reservation_datetime}}からです。',
    'こんにちは、{名前}さん。{予約日時}からです。',
  ])('下見は差し込みを共通の見本値に置き換える（%s）', async (messageContent) => {
    vi.mocked(scenarioReferenceData.scenario).mockResolvedValueOnce({ success: true, data: {
      ...scenario,
      steps: [{ ...scenario.steps[0], messageContent }, scenario.steps[1]],
    } } as never)
    await render()
    const preview = screen.getByRole('region', { name: 'LINEでの見え方' })
    expect(within(preview).getByText('選んだ通（1通目）の見え方')).toBeTruthy()
    expect(within(preview).getByText('こんにちは、見本 143さん。10月2日 18:00からです。')).toBeTruthy()
    expect(document.querySelector('[data-preview-sample-note]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'LINEでの見え方の説明' }))
    expect(screen.getByText('名前や日時は見本の値です。')).toBeTruthy()
    expect(within(preview).queryByText(messageContent)).toBeNull()
  })

  it('本文が空なら見本の説明を出さない', async () => {
    vi.mocked(scenarioReferenceData.scenario).mockResolvedValueOnce({ success: true, data: {
      ...scenario,
      steps: [{ ...scenario.steps[0], messageContent: '' }],
    } } as never)
    await render()
    expect(screen.queryByRole('button', { name: 'LINEでの見え方の説明' })).toBeNull()
  })

  it('絵（PMLkX）の操作と3つの箱・数の帯が出る', async () => {
    await render(<ScenarioDetailPage />)
    expect(screen.getByText('購読開始から0日後 10:00').closest('[data-page-template="detail"]')).toBeTruthy()
    for (const name of ['配信結果を見る', 'まとめて下見', 'まとめてテストを送る', '設定を変える', '一時停止する', 'このシナリオを削除する', 'キャンセル', '複製する', '保存する']) {
      expect(name === '配信結果を見る' ? screen.getByRole('link', { name }) : getPageAction({ name }), name).toBeTruthy()
    }
    expect(screen.getByText('保存済み 10月1日 14:02')).toBeTruthy()
    expect(screen.getByText('友だち追加のとき')).toBeTruthy()
    expect(screen.getByText('送っています')).toBeTruthy()
    expect(screen.getByText('何もしない（一時停止）')).toBeTruthy()
    expect(screen.getByText('購読開始から0日後 10:00')).toBeTruthy()
    expect(screen.getByText('1日後 20:00')).toBeTruthy()
    // 選んだ通（先頭）の中身が右のスマホに出る（「配る内容がまだありません」の空の箱にしない）。
    expect(screen.getByText('選んだ通（1通目）の見え方')).toBeTruthy()
    expect(screen.queryByText('配る内容がまだありません')).toBeNull()
    expect(screen.getAllByText('ご登録ありがとうございます。').length).toBeGreaterThan(1)
  })

  it('新しい通の本文が空のまま追加すると、本文の欄が赤くなり真下に理由が出て、その欄へ移る', async () => {
    await render()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'メッセージを追加する' })) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '追加する' })) })
    for (let i = 0; i < 2; i += 1) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    const reason = document.getElementById('step-content-error')
    expect(reason?.textContent).toBe('メッセージ内容を入力してください')
    const body = screen.getByPlaceholderText('メッセージ内容を入力…')
    expect(body.getAttribute('aria-invalid')).toBe('true')
    expect(body.contains(document.activeElement) || document.activeElement === body).toBe(true)
  })

  it('閲覧のみ：帯が出て、変える操作のボタンを置かない（押せないボタンも残さない）', async () => {
    role.value = 'staff'
    await render()
    expect(screen.getByText('この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。')).toBeTruthy()
    for (const name of ['まとめてテストを送る', '設定を変える', '一時停止する', '変える', 'このシナリオを削除する', '複製する', '保存する', 'メッセージを追加する', 'テンプレートを追加する', '＋ ここに挿入', '名前・説明・置き場を変える', 'このシナリオのその他操作', '1通目を上へ']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull()
    }
    // 見る操作は残す。残ったボタンはどれも押せる。
    expect(getPageAction({ name: 'まとめて下見' })).toBeTruthy()
    const disabled = [...host.querySelectorAll('button')].filter((b) => b.disabled).map((b) => b.textContent || b.getAttribute('aria-label'))
    expect(disabled).toEqual([])
  })

  it('保存が 409 なら競合の帯（kz2B6）を出し、保存ボタンは「比べてから保存」になる', async () => {
    updateScenario.mockRejectedValueOnce(new (ApiError as unknown as new (s: number, m?: string) => Error)(409, 'conflict'))
    await render()
    expect(screen.getByRole('button', { name: '保存する' }).querySelector('svg.lucide-check')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ほかの人が 14:10 にシナリオ「新規登録7日間フォロー」を保存しました')
    expect(within(alert).getByRole('button', { name: '最新を読み込んで続ける' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: '比べてから保存' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    expect(screen.getByRole('button', { name: '比べてから保存' }).querySelector('svg.lucide-git-compare-arrows')).not.toBeNull()
  })

  it('下の帯の「複製する」で複製の窓（Al4Ek）が開き、名前は「〇〇 のコピー」', async () => {
    await render()
    fireEvent.click(screen.getByRole('button', { name: '複製する' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('このシナリオを複製する')
    expect(dialog.textContent).toContain('引き継ぐもの')
    expect((within(dialog).getByLabelText('新しい名前') as HTMLInputElement).value).toBe('新規登録7日間フォロー のコピー')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

it('名前の保存中は×・閉じる・Escを止め、入力を残す', async () => {
  let finish!: (value: unknown) => void
  updateScenario.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render()
  fireEvent.click(screen.getByRole('button', { name: '名前・説明・置き場を変える' }))
  const dialog = screen.getByRole('dialog', { name: '名前・説明・置き場を変える' })
  fireEvent.change(within(dialog).getByLabelText('シナリオ名'), { target: { value: '変更した名前' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で保存する' }))
  for (const button of within(dialog).getAllByRole('button', { name: '閉じる' })) {
    fireEvent.click(button)
  }
  fireEvent.keyDown(document, { key: 'Escape' })
  expect((within(dialog).getByLabelText('シナリオ名') as HTMLInputElement).value).toBe('変更した名前')
  expect(screen.getByRole('dialog', { name: '名前・説明・置き場を変える' })).toBeTruthy()
  await act(async () => { finish({ success: true, data: { id: 'sc-1' } }); await Promise.resolve() })
})

describe('監査 WEB227/228', () => {
  it('WEB227：到達の帯の幅は「50%」で、「50%%」にしない', async () => {
    const { scenarioReferenceData } = await import('@/components/scenarios/scenario-reference-data')
    vi.mocked(scenarioReferenceData.stats).mockResolvedValue({
      success: true,
      data: { enrolledTotal: 10, activeNow: 2, completed: 3, paused: 0, steps: [{ stepOrder: 1, reachedCount: 5, reachRate: 0.5 }] },
    } as never)
    await render()
    await waitFor(() => expect(host.querySelector('[class*="statBarFill"]')).toBeTruthy())
    const fill = host.querySelector<HTMLElement>('[class*="statBarFill"]')!
    expect(fill.style.width).toBe('50%')
  })

  it('WEB228：「内容と対象を確かめました」にチェックを入れるまで「この内容ではじめる」を押せない', async () => {
    const { scenarioReferenceData } = await import('@/components/scenarios/scenario-reference-data')
    vi.mocked(scenarioReferenceData.scenario).mockResolvedValue({ success: true, data: { ...scenario, isActive: false } } as never)
    await render()
    fireEvent.click(screen.getByRole('button', { name: /配信を再開する/ }))
    const start = await screen.findByRole('button', { name: 'この内容ではじめる' })
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(start)
    expect(updateScenario).not.toHaveBeenCalledWith('sc-1', { isActive: true })
  })
})

it('WEB229：開始のきっかけを保存したら、見出しのきっかけの名前を読み直す（同じ数でも）', async () => {
  await render()
  expect(host.textContent).toContain('友だち追加のとき')
  triggerList.mockResolvedValue({ success: true, data: [{ id: 't2', kind: 'form_answer', tagId: null }] })
  fireEvent.click(screen.getByRole('button', { name: /設定を変える/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'きっかけを保存（試験）' }))
  await waitFor(() => expect(host.textContent).toContain('フォームに答えたとき'))
})

describe('整理後も保存・開始・停止と通の状態を保つ', () => {
  it('複製の開始に失敗したら英語の番号を出さず、名前と再試行を残す', async () => {
    const { ApiError } = await import('@/lib/api')
    createScenario.mockRejectedValueOnce(new ApiError(500, 'API error: 500'))
    await render()
    fireEvent.click(screen.getByRole('button', { name: '複製する', exact: true }))
    const dialog = screen.getByRole('dialog', { name: 'このシナリオを複製する' })
    fireEvent.change(within(dialog).getByLabelText('新しい名前'), { target: { value: '入力したコピー名' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '複製する', exact: true }))
    await waitFor(() => expect(createScenario).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('複製に失敗しました。通信を確かめて、もう一度お試しください。')).toBeTruthy())
    expect(screen.queryByText('API error: 500')).toBeNull()
    expect((within(dialog).getByLabelText('新しい名前') as HTMLInputElement).value).toBe('入力したコピー名')
    expect(within(dialog).getByRole('button', { name: '複製する', exact: true }).hasAttribute('disabled')).toBe(false)
  })

  it('複製失敗の番号をそのまま出さず、途中のコピーと段階を保持する', async () => {
    const { ApiError } = await import('@/lib/api')
    const { DuplicateAborted } = await import('./detail-model')
    const failure = new DuplicateAborted('copy-1', '2通目', new ApiError(500, 'API error: 500'))
    expect(failure.message).toBe('複製できませんでした')
    expect([failure.copyId, failure.stage]).toEqual(['copy-1', '2通目'])
    expect(new DuplicateAborted('copy-1', '名前', new ApiError(422, '名前が重複しています')).message).toBe('名前が重複しています')
  })

  it('名前の保存で欄の検査に失敗したら、入力と窓を残して理由と焦点を欄へ返す', async () => {
    const { ApiError } = await import('@/lib/api')
    updateScenario.mockRejectedValueOnce(Object.assign(new ApiError(422, '名前を直してください'), {
      fields: { name: '同じ名前があります' },
    }))
    await render()
    fireEvent.click(screen.getByRole('button', { name: '名前・説明・置き場を変える' }))
    const dialog = screen.getByRole('dialog', { name: '名前・説明・置き場を変える' })
    const name = within(dialog).getByLabelText('シナリオ名') as HTMLInputElement
    fireEvent.change(name, { target: { value: '入力した名前' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で保存する' }))
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
    expect(within(dialog).getByText('同じ名前があります')).toBeTruthy()
    expect(name.value).toBe('入力した名前')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(screen.getByRole('dialog', { name: '名前・説明・置き場を変える' })).toBeTruthy()
  })

  it('下書きの通は行の中で区別でき、選んだ本文も保持する', async () => {
    const { scenarioReferenceData } = await import('@/components/scenarios/scenario-reference-data')
    vi.mocked(scenarioReferenceData.scenario).mockResolvedValue({ success: true, data: {
      ...scenario, steps: [{ ...scenario.steps[0], isDraft: true }],
    } } as never)
    await render()
    expect(within(host.querySelector('ol')!).getByText('下書き')).toBeTruthy()
    expect(screen.getAllByText('ご登録ありがとうございます。').length).toBeGreaterThan(1)
  })

  it('停止前は送らず、確認した時だけ停止を保存し、窓を閉じる', async () => {
    const { scenarioReferenceData } = await import('@/components/scenarios/scenario-reference-data')
    vi.mocked(scenarioReferenceData.scenario).mockResolvedValue({ success: true, data: scenario } as never)
    await render()
    fireEvent.click(screen.getByRole('button', { name: '一時停止する', exact: true }))
    const dialog = await screen.findByRole('alertdialog')
    expect(updateScenario).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '一時停止する', exact: true }))
    await waitFor(() => expect(updateScenario).toHaveBeenCalledWith('sc-1', { isActive: false, expectedContentRevision: 1, expectedSubscriptions: { activeCount: 116, rowIdSum: 0, rowIdSquareSum: 0 } }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('停止に失敗したら確認窓と再試行を残し、成功したように見せない', async () => {
    const { scenarioReferenceData } = await import('@/components/scenarios/scenario-reference-data')
    vi.mocked(scenarioReferenceData.scenario).mockResolvedValue({ success: true, data: scenario } as never)
    updateScenario.mockRejectedValueOnce(new Error('手元の故障対照'))
    await render()
    fireEvent.click(screen.getByRole('button', { name: '一時停止する', exact: true }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '一時停止する', exact: true }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '一時停止する', exact: true }).hasAttribute('disabled')).toBe(false)
  })
})

describe('通の編集中の見え方', () => {
  it('新しい通の編集中はその内容だけを下見し、閉じると選択中の通に戻る', async () => {
    await render()
    expect(screen.getAllByRole('region', { name: 'LINEでの見え方' })).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'メッセージを追加する' })) })
    expect(screen.getAllByRole('region', { name: 'LINEでの見え方' })).toHaveLength(1)
    const current = screen.getByRole('complementary', { name: '3通目の下見' })
    fireEvent.change(screen.getByPlaceholderText('メッセージ内容を入力…'), { target: { value: '新しい本文' } })
    expect(within(current).getByRole('region', { name: 'LINEでの見え方' }).textContent).toContain('新しい本文')
    const actions = screen.getByRole('button', { name: '追加する', exact: true }).parentElement!
    fireEvent.click(within(actions).getByRole('button', { name: 'キャンセル' }))
    expect(screen.queryByRole('complementary', { name: '3通目の下見' })).toBeNull()
    expect(screen.getByText('選んだ通（1通目）の見え方')).toBeTruthy()
    expect(screen.getAllByRole('region', { name: 'LINEでの見え方' })).toHaveLength(1)
  })

  it('既存の通を編集中も編集中の通の下見を1つだけ表示する', async () => {
    await render()
    fireEvent.click(screen.getByRole('button', { name: '使い方のポイント' }))
    expect(screen.getByRole('complementary', { name: '2通目の下見' })).toBeTruthy()
    expect(screen.getAllByRole('region', { name: 'LINEでの見え方' })).toHaveLength(1)
  })
})

it.each(['テンプレートを追加する', '分岐を追加する', '＋ ここに挿入'])('%s でも編集中の下見だけを表示する', async (name) => {
  await render()
  const button = screen.getAllByRole('button', { name })[0]
  await act(async () => { fireEvent.click(button) })
  expect(screen.getByRole('complementary', { name: /通目の下見/ })).toBeTruthy()
  expect(screen.getAllByRole('region', { name: 'LINEでの見え方' })).toHaveLength(1)
})
