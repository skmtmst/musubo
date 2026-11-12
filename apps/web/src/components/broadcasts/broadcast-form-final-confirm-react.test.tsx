// @vitest-environment happy-dom
/*
 * 一斉配信の最終確認（設計 `FpgxH` 6-1-H ／ IDEA-06）を、本物の作成画面で押して確かめる。
 *
 * 見る筋書き:
 *   1. 予約は確認の窓を通す。下書き保存は窓を通さずに保存する。窓を開く前に入力の不備で止める。
 *   2. 人数は配信前チェックが数えた数だけを使い、未取得は「—」。数えられていなければ送らせない。
 *   3. 画面内の最終確認と確認の窓に、対象・除外・配信日時・送信枠・計算時刻・重複配信を並べる。
 *   4. 条件が変わったら古い確認を使わない。遅れて届いた古い応答で新しい確認を上書きしない。
 *   5. 送っているあいだは確定を押せない。
 */
import React, { act } from 'react'
import { setTextControlValue } from '@/test-utils/text-control'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { formatDateTime } from '@/lib/format'
import type { BroadcastPreflight } from '@/lib/api'

const captured = vi.hoisted(() => ({ regular: undefined as undefined | (() => Promise<void>), single: undefined as undefined | (() => Promise<void>), closeRegular: undefined as undefined | ((value: boolean) => void), closeSingle: undefined as undefined | ((value: boolean) => void) }))
vi.mock('./broadcast-confirm-dialogs', async original => {
  const actual = await original<typeof import('./broadcast-confirm-dialogs')>()
  return { ...actual, renderBroadcastConfirmDialogs: (props: Parameters<typeof actual.renderBroadcastConfirmDialogs>[0]) => {
    if (props.confirmOpen && !props.needsApprovalSingle) { captured.regular = props.confirmMessage; captured.closeRegular = props.setConfirmOpen }
    return actual.renderBroadcastConfirmDialogs(props)
  } }
})
vi.mock('./broadcast-editor-dialogs', async original => {
  const actual = await original<typeof import('./broadcast-editor-dialogs')>()
  return { ...actual, renderBroadcastEditorDialogs: (props: Parameters<typeof actual.renderBroadcastEditorDialogs>[0]) => {
    if (props.confirmOpen && props.needsApprovalSingle) { captured.single = props.save; captured.closeSingle = props.setConfirmOpen }
    return actual.renderBroadcastEditorDialogs(props)
  } }
})

const mocks = vi.hoisted(() => ({ account: 'acc-1', params: '', get: vi.fn(), preview: vi.fn(), confirm: vi.fn(), create: vi.fn(), update: vi.fn(), send: vi.fn(), config: vi.fn(), request: vi.fn(), preflight: vi.fn(), success: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const empty = async () => ({ success: true, data: [] })
  return { ...actual, api: { ...actual.api,
    broadcasts: { ...actual.api.broadcasts, get: mocks.get, create: mocks.create, update: mocks.update, send: mocks.send, list: empty, preflight: mocks.preflight,
      approval: { config: mocks.config, request: mocks.request, candidates: async () => ({ success: true, data: [] }) } },
    folders: { list: empty }, scenarios: { list: empty }, commonVars: { list: empty }, friendFields: { list: empty },
    broadcastMessageAssets: { list: empty }, templates: { list: empty },
    commonActions: { resources: async () => ({ success: true, data: { commonActions: [] } }) },
    accountSettings: { getTestRecipients: empty },
  } }
})
vi.mock('@/lib/api/helpers/gap1', () => ({ chatSafetyApi: { sendPreview: mocks.preview, confirmBroadcast: mocks.confirm } }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/broadcasts/new', useSearchParams: () => new URLSearchParams(mocks.params) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: mocks.account, loading: false }) }))
import BroadcastForm from './broadcast-form'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const EVALUATED_AT = '2099-10-05T00:30:00.000Z'
const PREFLIGHT = {
  audienceCount: 37,
  hiddenExcluded: 0,
  warnings: [],
  quota: { state: 'available', monthlyUsed: 100, monthlyLimit: 1000, remaining: 900, planned: 37, reason: null },
  audience: { matched: 37, sendable: 37, evaluatedAt: EVALUATED_AT, representatives: [] },
  concurrentBroadcasts: [{ id: 'other', title: '別の秋の配信', scheduledAt: '2099-10-05T01:30:00.000Z' }],
} satisfies BroadcastPreflight

let root: Root
let container: HTMLDivElement
async function flush() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
async function settle(ms = 650) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await flush() }
function findButton(label: string, scope: ParentNode = document) {
  return Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
}
function button(label: string, scope: ParentNode = document) {
  const element = findButton(label, scope)
  if (!element) throw new Error(`Missing button: ${label}`)
  return element
}
async function click(label: string, scope: ParentNode = document) { await act(async () => { fireEvent.click(button(label, scope)) }); await flush() }
function dialog() { return document.querySelector<HTMLElement>('[role="dialog"]') }
/** 定義の並び（dt → dd）を表にする。 */
function definitions(scope: ParentNode): Record<string, string> {
  return Object.fromEntries(Array.from(scope.querySelectorAll('dt')).map((dt) => [dt.textContent?.trim() ?? '', dt.nextElementSibling?.textContent?.trim() ?? '']))
}

type RenderOptions = { step?: 'confirm' | 'audience' | null; scheduled?: boolean; filled?: boolean; untested?: boolean }
async function render({ step = 'confirm', scheduled = false, filled = true, untested = false }: RenderOptions = {}) {
  if (untested) {
    mocks.params = 'duplicateFrom=source'
    mocks.get.mockResolvedValue({ success: true, data: { id: 'source', version: 2, status: 'draft', title: '試験のお知らせ', messageType: 'text', messageContent: 'お知らせの本文です。' } })
  }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => {
    root.render(<BroadcastForm
      visualQaAugustCampaign={filled && !untested}
      initialScheduledDate={scheduled ? '2099-10-05' : undefined}
      initialScheduledTime={scheduled ? '10:00' : undefined}
      currentStep={step ?? undefined}
      tags={[{ id: 'exclude', name: '配信不要' } as never]}
      initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }] }}
      onSuccess={mocks.success}
      onCancel={() => {}}
    />)
  })
  await flush()
  if (!scheduled) await act(async () => { fireEvent.click(container.querySelector('input[name=broadcast-send-mode][value=now]')!) })
  await settle()
}

/** 1人運用の店で、人数を打ち込んで確かめる窓（確認の中身をすべて並べる窓）を開く。 */
async function openSingleOperatorDialog(untested = false) {
  mocks.config.mockResolvedValue({ success: true, data: { threshold: 5, singleOperator: true } })
  await render({ untested })
  await click('今すぐ送る', container)
  await settle(200)
  const opened = dialog()
  if (!opened) throw new Error('確認の窓が開いていない')
  return opened
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.params = ''; mocks.account = 'acc-1'
  mocks.get.mockResolvedValue({ success: true, data: { id: 'draft', version: 2, status: 'sending' } })
  mocks.create.mockResolvedValue({ success: true, data: { id: 'draft', version: 1 } })
  mocks.update.mockResolvedValue({ success: true, data: { id: 'draft', version: 2 } })
  mocks.send.mockResolvedValue({ success: true, data: { id: 'draft', status: 'sending' } })
  mocks.config.mockResolvedValue({ success: true, data: { threshold: 1000, singleOperator: false } })
  mocks.request.mockResolvedValue({ success: true, data: {} })
  mocks.preflight.mockResolvedValue({ success: true, data: PREFLIGHT })
  mocks.preview.mockResolvedValue({ success: true, data: { recipients: 37, excluded: { blocked: 0, optedOut: 0, duplicate: 0, hidden: 0, missingDestination: 0 }, purpose: 'marketing', scheduledAt: null, quietHoursShiftTo: null, needsApproval: false, firstText: '本文', sender: null, expectedVersion: 2 } })
  mocks.confirm.mockResolvedValue({ success: true, data: {} })
})
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); vi.useRealTimers() })

describe('予約は確認を通し、下書き保存は通さない（段の無い作成画面）', () => {
  it('配信前の窓で操作するLINEアカウントと環境を確認できる', async () => {
    await render({ step: null, scheduled: true })
    await click('配信を予約する', container)
    expect(dialog()?.textContent).toContain('LINEアカウント')
    expect(dialog()?.textContent).toContain('環境')
  })
  it('アカウントを切り替えて戻しても古い配信確認は復活しない', async () => {
    await render({ step: null, scheduled: true })
    await click('配信を予約する', container)
    expect(dialog()).not.toBeNull()
    const oldButton = Array.from(dialog()!.querySelectorAll('button')).find(item => item.textContent?.includes('予約する'))!
    const key = Object.keys(oldButton).find(item => item.startsWith('__reactProps$'))!
    const oldClick = (oldButton as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    mocks.account = 'acc-2'
    await act(async () => { root.render(<BroadcastForm visualQaAugustCampaign initialScheduledDate="2099-10-05" initialScheduledTime="10:00" tags={[{ id: 'exclude', name: '配信不要' } as never]} initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }] }} onSuccess={mocks.success} onCancel={() => {}} />) })
    mocks.account = 'acc-1'
    await act(async () => { root.render(<BroadcastForm visualQaAugustCampaign initialScheduledDate="2099-10-05" initialScheduledTime="10:00" tags={[{ id: 'exclude', name: '配信不要' } as never]} initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }] }} onSuccess={mocks.success} onCancel={() => {}} />) })
    expect(dialog()).toBeNull()
    await act(async () => { await oldClick({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: oldButton, target: oldButton }) })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('「配信を予約する」は保存せずに確認の窓を開く', async () => {
    await render({ step: null, scheduled: true })
    await click('配信を予約する', container)
    expect(dialog()).not.toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('「下書きを保存する」は窓を開かずにそのまま保存する', async () => {
    await render({ step: null })
    await click('下書きを保存する', container)
    expect(dialog()).toBeNull()
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('入力に不備があるときは窓を開く前に止め、理由を出す', async () => {
    await render({ step: null, scheduled: true, filled: false })
    await click('配信を予約する', container)
    expect(dialog()).toBeNull()
    expect(container.querySelector('[role="alert"], .text-danger')).not.toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('人数は配信前チェックが数えた数だけを使う', () => {
  it('対象の段の人数は配信前チェックの数を出す', async () => {
    await render({ step: 'audience' })
    expect(container.textContent).toContain('この条件で送る人数37人')
  })

  it('数えられていないときは送らせず、人数を「—」で出す（0人と書かない）', async () => {
    mocks.preflight.mockRejectedValue(new Error('500'))
    await render()
    expect(button('今すぐ送る', container).disabled).toBe(true)
    expect(container.textContent).toContain('人数を確認してから送れます')
    expect(container.textContent).not.toMatch(/\d+件の確認が残っています/)
    const inPage = definitions(container.querySelector('#broadcast-step-confirm details')!)
    expect(inPage['対象']).toMatch(/—$/)
    expect(inPage['対象']).not.toContain('0人')
  })
})

describe('閉じた配信確認', () => {
  it('通常の確認は開き直すと古い確定を受け付けない', async () => {
    await render()
    await click('今すぐ送る', container); await settle(200)
    const firstAck = Array.from(dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!
    await act(async () => { fireEvent.click(firstAck) }); await flush()
    const oldConfirm = captured.regular!, oldClose = captured.closeRegular!
    expect(oldConfirm).toBeTypeOf('function')
    await click('戻る', dialog()!)
    await act(async () => { await oldConfirm() }); await flush()
    expect(mocks.confirm).not.toHaveBeenCalled()
    await click('今すぐ送る', container); await settle(200)
    act(() => oldClose(false))
    expect(dialog()).not.toBeNull()
    await act(async () => { await oldConfirm() }); await flush()
    expect(mocks.confirm).not.toHaveBeenCalled()
    const acknowledgement = Array.from(dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!
    await act(async () => { fireEvent.click(acknowledgement) }); await flush()
    await click('37 人に送る', dialog()!)
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
  })

  it('一人運用の確認は開き直すと古い確定を受け付けない', async () => {
    const opened = await openSingleOperatorDialog()
    await act(async () => { fireEvent.change(opened.querySelector('input#approval-count')!, { target: { value: '37' } }) }); await flush()
    const acknowledgement = Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!
    await act(async () => { fireEvent.click(acknowledgement) }); await flush()
    const oldSave = captured.single!, oldClose = captured.closeSingle!
    expect(oldSave).toBeTypeOf('function')
    await click('戻って修正', opened)
    await act(async () => { await oldSave() }); await flush()
    expect(mocks.send).not.toHaveBeenCalled()
    await click('今すぐ送る', container); await settle(200)
    act(() => oldClose(false))
    expect(dialog()).not.toBeNull()
    await act(async () => { await oldSave() }); await flush()
    expect(mocks.send).not.toHaveBeenCalled()
    const reopened = dialog()!
    await act(async () => { fireEvent.change(reopened.querySelector('input#approval-count')!, { target: { value: '37' } }) }); await flush()
    const nextAck = Array.from(reopened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!
    await act(async () => { fireEvent.click(nextAck) }); await flush()
    await click('今すぐ送る', reopened)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})

describe('確認の窓に並べるもの', () => {
  it('対象・除外・送信枠・計算時刻・配信日時・送る中身を、配信前チェックの値で並べる', async () => {
    const opened = await openSingleOperatorDialog()
    const rows = definitions(opened)
    expect(Object.keys(rows)).toEqual(expect.arrayContaining(['配信対象', '除外', '送信枠', '計算時刻', '配信日時', '送る中身']))
    expect(rows['配信対象']).toContain('37人')
    expect(rows['送信枠']).toBe('残り 900 / 1,000通（この配信で 37通を使用）')
    // 表示側で今の時刻を作らない。配信前チェックが数えた時刻だけを出す。
    expect(rows['計算時刻']).toBe(formatDateTime(EVALUATED_AT))
    expect(rows['配信日時']).toBe('今すぐ（確認してから送信）')
    // 除外の数としての口が無い応答では、0人と書かずに理由を出す。
    expect(rows['除外']).toContain('除外した人数はまだ取れません')
  })

  it('把握できる重複配信を窓にも出す', async () => {
    const opened = await openSingleOperatorDialog()
    expect(opened.textContent).toContain('同じ時刻の前後1時間に別の予約配信があります')
    expect(opened.textContent).toContain('別の秋の配信')
  })

  it('送っているあいだは確定を押せない', async () => {
    let finish!: (value: unknown) => void
    mocks.send.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const opened = await openSingleOperatorDialog()
    await act(async () => { fireEvent.change(opened.querySelector('input#approval-count')!, { target: { value: '37' } }) }); await flush()
    await act(async () => { fireEvent.click(Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!) }); await flush()
    await act(async () => { fireEvent.click(button('今すぐ送る', opened)) }); await flush()
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(opened.getAttribute('aria-busy')).toBe('true')
    // 確定も戻るも押せない（二重に送らない・送っている途中で窓を閉じない）。
    expect(findButton('今すぐ送る', opened)?.disabled ?? true).toBe(true)
    expect(button('戻って修正', opened).disabled).toBe(true)
    await act(async () => { finish({ success: true, data: { id: 'draft', status: 'sending' } }) }); await flush()
  })
})

describe('画面内の最終確認（IDEA-06）', () => {
  it('A/B有効なら最終段で送信を止め、実際の送信へ進まない', async () => {
    await render({ step: null })
    await click('B 案を追加', container)
    await act(async () => { root.render(<BroadcastForm visualQaAugustCampaign currentStep="confirm" tags={[{ id: 'exclude', name: '配信不要' } as never]} initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }] }} onSuccess={mocks.success} onCancel={() => {}} />) })
    await settle()
    expect(button('今すぐ送る', container).disabled).toBe(true)
    expect(container.textContent).toContain('B案を消すとA案を配信できます')
    await click('今すぐ送る', container)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('B案を消すとA案だけを実際の送信経路へ渡せる', async () => {
    await render({ step: null })
    await click('B 案を追加', container)
    const bEditor = container.querySelector('[data-message-composer] [role="textbox"][placeholder="テキストを入力"]')!
    await act(async () => { setTextControlValue(bEditor as HTMLElement, 'B案だけの本文') })
    expect(bEditor.textContent).toContain('B案だけの本文')
    await act(async () => { fireEvent.click(container.querySelector('button[aria-label="A/B の案の操作"]')!) }); await flush()
    await click('B 案を消す')
    await act(async () => { root.render(<BroadcastForm visualQaAugustCampaign currentStep="confirm" tags={[{ id: 'exclude', name: '配信不要' } as never]} initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }] }} onSuccess={mocks.success} onCancel={() => {}} />) })
    await settle()
    await click('今すぐ送る', container); await settle(200)
    const opened = dialog()!
    const acknowledgement = Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!
    await act(async () => { fireEvent.click(acknowledgement) }); await flush()
    await click('37 人に送る', opened)
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    const saved = JSON.stringify(mocks.create.mock.calls) + JSON.stringify(mocks.update.mock.calls)
    expect(saved).not.toContain('B案だけの本文')
    expect(saved).toContain('8月限定キャンペーン')
  })

  it('確認窓を開いた後にA/Bが有効になっても確定は送信しない', async () => {
    await render()
    await click('今すぐ送る', container); await settle(200)
    expect(dialog()).not.toBeNull()
    const props = { visualQaAugustCampaign: true, tags: [{ id: 'exclude', name: '配信不要' } as never], initialCondition: { operator: 'OR' as const, rules: [{ type: 'tag_exists' as const, value: 'vip' }] }, onSuccess: mocks.success, onCancel: () => {} }
    await act(async () => { root.render(<BroadcastForm {...props} />) }); await flush()
    await click('B 案を追加', container)
    await act(async () => { root.render(<BroadcastForm {...props} currentStep="confirm" />) }); await settle(200)
    const opened = dialog()!
    const ack = Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))
    if (ack && !ack.checked) await act(async () => { fireEvent.click(ack) })
    const confirm = button('37 人に送る', opened)
    const key = Object.keys(confirm).find(item => item.startsWith('__reactProps$'))!
    const handler = (confirm as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
    await act(async () => { handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: confirm, target: confirm }) }); await flush()
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('単頁でA/Bのまま予約を押すと確認窓を開かず理由を出す', async () => {
    await render({ step: null, scheduled: true })
    await click('B 案を追加', container)
    await click('配信を予約する', container)
    expect(dialog()).toBeNull()
    expect(container.textContent).toContain('A/Bは送信未対応です')
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('内訳に対象・除外・配信日時・送信枠・計算時刻を並べる', async () => {
    await render()
    const rows = definitions(container.querySelector('#broadcast-step-confirm details')!)
    expect(rows['対象']).toContain('37人')
    expect(rows['除外']).toBe('—')
    expect(rows['配信日時']).toBe('今すぐ（確認してから送信）')
    expect(rows['送信枠']).toBe('残り 900 / 1,000通（この配信で 37通を使用）')
    expect(rows['計算時刻']).toBe(formatDateTime(EVALUATED_AT))
  })

  it('送信枠が取れない・足りないときは、0や空白で誤魔化さずに分けて出す', async () => {
    mocks.preflight.mockResolvedValue({ success: true, data: { ...PREFLIGHT, quota: { ...PREFLIGHT.quota, state: 'unavailable' } } })
    await render()
    expect(definitions(container.querySelector('#broadcast-step-confirm details')!)['送信枠']).toBe('確認できませんでした')
    act(() => root.unmount()); container.remove()

    mocks.preflight.mockResolvedValue({ success: true, data: { ...PREFLIGHT, quota: { ...PREFLIGHT.quota, state: 'insufficient', remaining: 10 } } })
    await render()
    expect(definitions(container.querySelector('#broadcast-step-confirm details')!)['送信枠']).toBe('不足しています（残り 10 / 1,000通）')
  })

  it('把握できる重複配信を画面内にも出す', async () => {
    await render()
    const section = container.querySelector('#broadcast-step-confirm')!
    expect(section.textContent).toContain('同じ時刻の前後1時間に別の予約配信があります')
    expect(section.textContent).toContain('別の秋の配信')
  })
})

describe('条件が変わったら古い確認を使わない', () => {
  it('承認方法が異なるアカウントに切り替えても確認を読み直せる', async () => {
    let finishConfig!: (value: unknown) => void
    mocks.config.mockImplementation((account: string) => account === 'acc-1'
      ? Promise.resolve({ success: true, data: { threshold: 5, singleOperator: true } })
      : new Promise(resolve => { finishConfig = resolve }))
    mocks.create.mockImplementation(async () => ({ success: true, data: { id: `draft-${mocks.account}`, version: 1 } }))
    mocks.update.mockImplementation(async (id: string) => ({ success: true, data: { id, version: 2 } }))
    await render()
    await click('今すぐ送る', container); await settle(200)
    mocks.account = 'acc-2'
    await act(async () => { root.render(<BroadcastForm visualQaAugustCampaign currentStep="confirm" tags={[{ id: 'exclude', name: '配信不要' } as never]} initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }] }} onSuccess={mocks.success} onCancel={() => {}} />) })
    await settle()
    await click('今すぐ送る', container); await settle(200)
    await act(async () => { finishConfig({ success: true, data: { threshold: 1000, singleOperator: false } }) }); await settle(200)
    expect(mocks.preview).toHaveBeenLastCalledWith('draft-acc-2')
    expect(button('37 人に送る', dialog()!)).toBeTruthy()
  })
  it('アカウント切替先で確認窓を開き直すと切替先の下書きを確認する', async () => {
    mocks.create.mockImplementation(async () => ({ success: true, data: { id: `draft-${mocks.account}`, version: 1 } }))
    mocks.update.mockImplementation(async (id: string) => ({ success: true, data: { id, version: 2 } }))
    await render()
    await click('今すぐ送る', container); await settle(200)
    expect(mocks.preview).toHaveBeenCalledWith('draft-acc-1')
    mocks.account = 'acc-2'
    await act(async () => { root.render(<BroadcastForm visualQaAugustCampaign currentStep="confirm" tags={[{ id: 'exclude', name: '配信不要' } as never]} initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }] }} onSuccess={mocks.success} onCancel={() => {}} />) })
    await settle()
    await click('今すぐ送る', container); await settle(200)
    expect(mocks.preview).toHaveBeenLastCalledWith('draft-acc-2')
    const opened = dialog()!
    const acknowledgement = Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!
    await act(async () => { fireEvent.click(acknowledgement) }); await flush()
    await click('37 人に送る', opened)
    expect(mocks.confirm).toHaveBeenCalledWith('draft-acc-2', expect.anything())
  })
  async function addExcludeTag() {
    await act(async () => { fireEvent.click(container.querySelector('button[aria-label="除くタグ"]')!) }); await flush()
    await act(async () => { fireEvent.click(Array.from(document.querySelectorAll('input[type="radio"]')).find((item) => item.getAttribute('aria-label')?.includes('配信不要'))!) }); await flush()
    await click('選ぶ', [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!)
  }

  it('条件を変えた直後は、前の条件で数えた人数を出さない', async () => {
    await render({ step: 'audience' })
    expect(container.textContent).toContain('この条件で送る人数37人')
    mocks.preflight.mockImplementation(() => new Promise(() => {}))
    await addExcludeTag()
    expect(container.textContent).not.toContain('37人')
  })

  it('遅れて届いた古い応答で、新しい条件の人数を上書きしない', async () => {
    let finishOld!: (value: unknown) => void
    mocks.preflight.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    await render({ step: 'audience' })
    mocks.preflight.mockResolvedValue({ success: true, data: { ...PREFLIGHT, audienceCount: 20 } })
    await addExcludeTag()
    await settle()
    expect(container.textContent).toContain('この条件で送る人数20人')
    await act(async () => { finishOld({ success: true, data: { ...PREFLIGHT, audienceCount: 99 } }) }); await flush()
    expect(container.textContent).toContain('この条件で送る人数20人')
    expect(container.textContent).not.toContain('99人')
  })
})


describe('確認が残る配信の了承', () => {
  it('1人運用でも確認しましたを選ぶまで送れず、選ぶと人数の確認後に送れる', async () => {
    const opened = await openSingleOperatorDialog(true)
    await act(async () => { fireEvent.change(opened.querySelector('input#approval-count')!, { target: { value: '37' } }) }); await flush()
    expect(button('今すぐ送る', opened).disabled).toBe(true)
    await act(async () => { fireEvent.click(button('今すぐ送る', opened)) }); await flush()
    expect(mocks.send).not.toHaveBeenCalled()
    const acknowledgement = Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => input.labels?.[0]?.textContent?.includes('確認しました'))
    expect(acknowledgement).toBeDefined()
    await act(async () => { fireEvent.click(acknowledgement!) }); await flush()
    await click('今すぐ送る', opened)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('通常の確認でも了承が必要で、窓を開き直すと了承は外れる', async () => {
    await render()
    await click('今すぐ送る', container); await settle(200)
    const opened = dialog()!
    expect(button('37 人に送る', opened).disabled).toBe(true)
    const acknowledgement = Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => input.labels?.[0]?.textContent?.includes('確認しました'))
    expect(acknowledgement).toBeDefined()
    await act(async () => { fireEvent.click(acknowledgement!) }); await flush()
    expect(button('37 人に送る', opened).disabled).toBe(false)
    await click('戻る', opened)
    await click('今すぐ送る', container); await settle(200)
    expect(button('37 人に送る', dialog()!).disabled).toBe(true)
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('窓を開いたまま内容を変えると、前の了承では予約できない', async () => {
    await render({ step: null, scheduled: true })
    await click('配信を予約する', container); await settle(200)
    const opened = dialog()!
    const acknowledgement = Array.from(opened.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))!
    await act(async () => { fireEvent.click(acknowledgement) }); await flush()
    expect(button('37 人に 10/5 10:00 で予約する', opened).disabled).toBe(false)
    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="例：8月キャンペーンのお知らせ"]') ?? Array.from(container.querySelectorAll<HTMLInputElement>('input')).find(input => input.value === '8月キャンペーンのお知らせ')
    expect(titleInput).toBeDefined()
    await act(async () => { fireEvent.change(titleInput!, { target: { value: '変更後の配信名' } }) }); await flush()
    expect(acknowledgement.checked).toBe(false)
    expect(button('37 人に 10/5 10:00 で予約する', opened).disabled).toBe(true)
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it('確認できない送信枠とテスト送信を行に出し、要確認の件数と警告の行数をそろえる', async () => {
    mocks.preflight.mockResolvedValue({ success: true, data: { ...PREFLIGHT, quota: { ...PREFLIGHT.quota, state: 'unavailable' } } })
    await render({ untested: true })
    await click('配信イメージを見る', container)
    const section = container.querySelector('#broadcast-step-confirm')!
    const rows = Array.from(section.querySelectorAll('[data-preflight-check]'))
    expect(rows.length).toBeGreaterThanOrEqual(6)
    const pending = rows.filter(row => row.getAttribute('data-check-state') === 'pending')
    expect(pending).toHaveLength(3)
    for (const row of rows) {
      const icon = row.querySelector('svg')!
      expect(icon.classList.contains(row.getAttribute('data-check-state') === 'pending' ? 'text-warning' : 'text-success')).toBe(true)
    }
    expect(pending.map(row => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('送信枠'), expect.stringContaining('テスト送信')]))
    expect(section.textContent).toContain(`${pending.length}件の確認が残っています`)
    expect(rows.find(row => row.textContent?.includes('送信枠'))?.getAttribute('data-check-state')).toBe('pending')
  })
})

it('配信作成の段を切り替えても入力欄は横に移動しない', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const animate = vi.spyOn(HTMLElement.prototype, 'animate')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const props = { visualQaAugustCampaign: true, tags: [], onSuccess: mocks.success, onCancel: () => {} }
  await act(async () => { root.render(<BroadcastForm {...props} currentStep="audience" />) }); await flush()
  await act(async () => { root.render(<BroadcastForm {...props} currentStep="message" />) }); await flush()
  const calls = animate.mock.calls.filter((_, index) => (animate.mock.contexts[index] as HTMLElement).hasAttribute('data-step-content'))
  expect(calls.at(-1)?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }])
  animate.mockRestore(); vi.unstubAllGlobals()
})
