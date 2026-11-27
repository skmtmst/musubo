// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ get: vi.fn(), preview: vi.fn(), confirm: vi.fn(), create: vi.fn(), update: vi.fn(), send: vi.fn(), config: vi.fn(), request: vi.fn(), preflight: vi.fn(), success: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const empty = async () => ({ success: true, data: [] })
  return { ...actual, api: { ...actual.api,
    broadcasts: { ...actual.api.broadcasts, get: mocks.get, create: mocks.create, update: mocks.update, send: mocks.send, list: empty, preflight: mocks.preflight,
      approval: { config: mocks.config, request: mocks.request, candidates: async () => ({ success: true, data: [{ id: 'reviewer', name: '確認担当' }] }) } },
    folders: { list: empty }, scenarios: { list: empty }, commonVars: { list: empty }, friendFields: { list: empty },
    broadcastMessageAssets: { list: empty }, templates: { list: empty },
    commonActions: { resources: async () => ({ success: true, data: { commonActions: [] } }) },
    accountSettings: { getTestRecipients: empty },
  } }
})
vi.mock('@/lib/api/helpers/gap1', () => ({ chatSafetyApi: { sendPreview: mocks.preview, confirmBroadcast: mocks.confirm } }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/broadcasts/new', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }) }))
import BroadcastForm from './broadcast-form'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
async function flush() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
function button(label: string, scope: ParentNode = document) {
  const element = Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  if (!element) throw new Error(`Missing button: ${label}`)
  return element
}
async function click(label: string, scope: ParentNode = document) { await act(async () => { fireEvent.click(button(label, scope)) }); await flush() }
async function acknowledge(scope: Element) {
  const checkbox = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.labels?.[0]?.textContent?.includes('確認しました'))
  if (!checkbox) throw new Error('確認しましたの欄がありません')
  await act(async () => { fireEvent.click(checkbox) }); await flush()
}
async function render(step: 'confirm' | 'audience' | 'schedule' = 'confirm', scheduled = false, chosen = true) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root.render(<BroadcastForm visualQaAugustCampaign initialScheduledDate={scheduled ? '2099-10-05' : undefined} initialScheduledTime={scheduled ? '10:00' : undefined} currentStep={step} tags={[{ id: 'exclude', name: '配信不要' } as never]} initialCondition={{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }, { type: 'tag_exists', value: 'member' }] }} onSuccess={mocks.success} onCancel={() => {}} />) })
  await flush()
  if (!scheduled && chosen) await act(async () => { fireEvent.click(container.querySelector('input[name=broadcast-send-mode][value=now]')!) })
  await act(async () => { await vi.advanceTimersByTimeAsync(650) }); await flush()
}
async function confirm() { await click('今すぐ送る', container); await act(async () => { await vi.advanceTimersByTimeAsync(200) }); await flush(); return document.querySelector('[role="dialog"]')! }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  mocks.get.mockResolvedValue({ success: true, data: { id: 'draft', version: 2, status: 'sending' } })
  mocks.create.mockResolvedValue({ success: true, data: { id: 'draft', version: 1 } })
  mocks.update.mockResolvedValue({ success: true, data: { id: 'draft', version: 2 } })
  mocks.send.mockResolvedValue({ success: true, data: { id: 'draft', status: 'sending' } })
  mocks.config.mockResolvedValue({ success: true, data: { threshold: 1000, singleOperator: false } })
  mocks.request.mockResolvedValue({ success: true, data: {} })
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 10 } })
  mocks.preview.mockResolvedValue({ success: true, data: { recipients: 10, excluded: { blocked: 0, optedOut: 0, duplicate: 0, hidden: 0, missingDestination: 0 }, purpose: 'marketing', scheduledAt: null, quietHoursShiftTo: null, needsApproval: false, firstText: '本文', sender: null, expectedVersion: 2 } })
  mocks.confirm.mockResolvedValue({ success: true, data: {} })
})
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); vi.useRealTimers() })

describe('V8の5手順で送信を確定する', () => {
  it('配信画面に5段の進みと現在の段を表示する', async () => {
    await render('audience')
    const nav = container.querySelector('[aria-label="配信作成の進み"]') as HTMLElement
    expect(nav).toBeTruthy()
    expect(nav.querySelectorAll('li')).toHaveLength(5)
    expect(nav.querySelector('[aria-current="step"]')?.textContent).toContain('配信対象')
  })
  it('最終確認へ直接来ても未選択のままなら理由1行で止まり保存・送信しない', async () => {
    await render('confirm', false, false)
    expect(button('送信設定を確認する', container).disabled).toBe(true)
    expect(container.querySelector('#broadcast-footer-reason')?.textContent).toBe('送る時間を選んでください')
    await click('送信設定を確認する', container)
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
  })
  it('最終確認の窓を開くと下書きを保存して数え直し、確定は見た人数・版を添えて1回だけ送る', async () => {
    await render(); const dialog = await confirm(); await flush()
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.preview).toHaveBeenCalledWith('draft'); expect(mocks.confirm).not.toHaveBeenCalled()
    await acknowledge(dialog)
    await act(async () => { fireEvent.click(button('10 人に送る', dialog)); fireEvent.click(button('10 人に送る', dialog)) }); await flush()
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith('draft', { expectedVersion: 2, confirmedRecipientCount: 10 })
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('draft')
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.success).toHaveBeenCalledExactlyOnceWith({ id: 'draft', version: 2, status: 'sending' })
  })
  it('送信が断られたときは入力と確認窓を残し、成功として移動しない', async () => {
    mocks.confirm.mockRejectedValue(new Error('送信枠が足りません'))
    await render(); const dialog = await confirm(); await flush(); await acknowledge(dialog); await click('10 人に送る', dialog)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.textContent).toContain('8月キャンペーンのお知らせ'); expect(mocks.success).not.toHaveBeenCalled()
  })
  it('承認の設定を取得できないときは、送信確定の操作を出さない', async () => {
    mocks.config.mockResolvedValue({ success: false, error: '取得失敗' })
    await render(); const dialog = await confirm()
    expect(dialog.textContent).toContain('承認の設定を確認できません')
    expect(Array.from(dialog.querySelectorAll('button')).some((item) => /人に送る/.test(item.textContent ?? ''))).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled()
  })
  it('数えられなかったときは「人数を数えられませんでした」と出し、主ボタンは押せない', async () => {
    mocks.preview.mockRejectedValue(new Error('500'))
    await render(); const dialog = await confirm(); await flush()
    expect(dialog.textContent).toContain('人数を数えられませんでした')
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
  it('予約の確定は日時を保存し、確定に予約日時を添える', async () => {
    await render('confirm', true)
    await click('この内容で予約する', container)
    await act(async () => { await vi.advanceTimersByTimeAsync(200) }); await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(mocks.create.mock.calls[0][0].scheduledAt).toBe('2099-10-05T01:00:00.000Z')
    await acknowledge(dialog)
    await click('10 人に 10/5 10:00 で予約する', dialog)
    expect(mocks.confirm).toHaveBeenCalledWith('draft', expect.objectContaining({ scheduledAt: '2099-10-05T01:00:00.000Z' }))
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.success).toHaveBeenCalledTimes(1)
  })
  it('承認対象なら指定した人へ依頼し、即時送信しない', async () => {
    mocks.config.mockResolvedValue({ success: true, data: { threshold: 5, singleOperator: false } })
    await render(); const dialog = await confirm()
    await act(async () => { fireEvent.click(dialog.querySelector('button[aria-label="承認をお願いする人"]')!) }); await flush()
    await act(async () => { fireEvent.click(Array.from(document.querySelectorAll('input[type="radio"]')).find((item) => item.getAttribute('aria-label')?.includes('確認担当'))!) }); await flush()
    await click('選択する', [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!)
    await acknowledge(dialog)
    await click('承認を依頼する', dialog)
    expect(mocks.request).toHaveBeenCalledWith('draft', { approverStaffId: 'reviewer', note: undefined })
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.success).toHaveBeenCalledTimes(1)
  })
  it('0人の条件では送信の確定を出さない', async () => {
    mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 0 } })
    await render()
    expect(button('今すぐ送る', container).disabled).toBe(true)
    await click('今すぐ送る', container)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('1人運用では人数が合うまで保存せず、確認した人数を送信側にも渡す', async () => {
    mocks.config.mockResolvedValue({ success: true, data: { threshold: 5, singleOperator: true } })
    await render(); const dialog = await confirm()
    await acknowledge(dialog)
    const savedBefore = mocks.create.mock.calls.length + mocks.update.mock.calls.length
    await click('今すぐ送る', dialog)
    expect(mocks.create.mock.calls.length + mocks.update.mock.calls.length).toBe(savedBefore)
    await act(async () => { fireEvent.change(dialog.querySelector('input#approval-count')!, { target: { value: '10' } }) }); await flush()
    await click('今すぐ送る', dialog)
    expect(mocks.send).toHaveBeenCalledWith('draft', { confirmedRecipientCount: 10 })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('ORの絞り込みへ除外タグを足しても、除外は必ずANDで効き、人数と保存は同じ条件になる', async () => {
    await render('audience')
    await act(async () => { fireEvent.click(container.querySelector('button[aria-label="除くタグ"]')!) }); await flush()
    await act(async () => { fireEvent.click(Array.from(document.querySelectorAll('input[type="radio"]')).find((item) => item.getAttribute('aria-label')?.includes('配信不要'))!) }); await flush()
    await click('選択する', [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!)
    await act(async () => { await vi.advanceTimersByTimeAsync(650) }); await flush()
    const counted = mocks.preflight.mock.calls.at(-1)![0].segmentConditions
    expect(counted).toMatchObject({ operator: 'AND', rules: [{ type: 'tag_not_exists', value: 'exclude' }], groups: [{ operator: 'AND', rules: [{ type: 'is_following', value: true }], groups: [{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'vip' }, { type: 'tag_exists', value: 'member' }] }] }] })
    await click('下書きを保存する', container)
    expect(mocks.create.mock.calls[0][0].segmentConditions).toEqual(counted)
  })
  it('上限の選択と人数は再確認と下書きへ渡り、既定の全員へ勝手に戻らない', async () => {
    mocks.preflight.mockImplementation(async (input) => ({ success: true, data: { audienceCount: input.deliveryLimit ? 2 : 10, ...(input.deliveryLimit ? { deliveryLimit: {candidateCount:10,recipientCount:2,random:true} } : {}) } }))
    await render('schedule')
    const input = container.querySelector<HTMLInputElement>('#bc-recipient-limit')!
    expect(input.value).toBe('')
    await act(async () => { fireEvent.change(input, {target:{value:'2'}}) }); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(650) }); await flush()
    expect(mocks.preflight.mock.calls.at(-1)![0].deliveryLimit).toEqual({upToRemainingQuota:false,maxRecipients:2})
    await click('下書きを保存する',container)
    expect(mocks.create.mock.calls.at(-1)![0].messageOptions.deliveryLimit).toEqual({upToRemainingQuota:false,maxRecipients:2})
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
  })
  it('鍵が拒否された理由と入れ直す先を示し、再確認しても入力した上限を残す', async () => {
    mocks.preflight.mockResolvedValue({success:true,data:{audienceCount:10,quota:{state:'unavailable',monthlyLimit:null,monthlyUsed:null,remaining:null,planned:10,reason:'LINEの接続用の鍵が受け付けられていません。LINEの設定で鍵を発行し直し、接続設定に入れ直してください。'}}})
    await render('schedule')
    expect(container.textContent).toContain('鍵を発行し直し')
    expect(container.querySelector('a[href="/accounts/detail?id=acc-1"]')?.textContent).toBe('LINEの接続設定を見る')
    await act(async () => { fireEvent.change(container.querySelector('#bc-recipient-limit')!,{target:{value:'2'}}) }); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(650) }); await flush()
    await click('もう一度確認する',container)
    expect(container.querySelector<HTMLInputElement>('#bc-recipient-limit')!.value).toBe('2')
    expect(mocks.preflight.mock.calls.at(-1)![0].deliveryLimit).toEqual({upToRemainingQuota:false,maxRecipients:2})
    expect(container.textContent).not.toContain('残り 0通')
  })

  it('確認窓の上限が減ったら、了承する説明も新しい人数でそろえる', async () => {
    mocks.preflight.mockResolvedValue({success:true,data:{audienceCount:2,deliveryLimit:{candidateCount:10,recipientCount:2,random:true}}})
    mocks.preview.mockResolvedValue({success:true,data:{recipients:1,deliveryLimit:{candidateCount:10,recipientCount:1,random:true},excluded:{blocked:0,optedOut:0,duplicate:0},purpose:'marketing',scheduledAt:null,quietHoursShiftTo:null,needsApproval:false,firstText:'本文',sender:null,expectedVersion:2,stoppable:true}})
    await render();const dialog=await confirm();await flush()
    expect(dialog.textContent).toContain('無作為に最大1人へ送ります')
    expect(dialog.textContent).not.toContain('無作為に最大2人へ送ります')
    expect(button('1 人に送る',dialog).disabled).toBe(true)
    await acknowledge(dialog);await click('1 人に送る',dialog)
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith('draft',{expectedVersion:2,confirmedRecipientCount:1})
  })

})
