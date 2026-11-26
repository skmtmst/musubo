// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import RegisterV8 from '@/v8/account-new/register'
import { allV8RowsPassed, toV8CheckRows } from '@/v8/account-new/logic'
import type { FollowerImportState, LineAccountConnectData } from '@/lib/api'
import { deferred } from '@/test-utils/race'

const calls = vi.hoisted(() => ({
  connectCheck: vi.fn(), connect: vi.fn(), list: vi.fn(), registrationReceipt: vi.fn(), accountGet: vi.fn(),
  followerImportState: vi.fn(), stepFollowerImport: vi.fn(), followerInsight: vi.fn(),
  staffList: vi.fn(), tagList: vi.fn(), tagCreate: vi.fn(), tagSet: vi.fn(), friendsList: vi.fn(),
  styleGet: vi.fn(), styleSave: vi.fn(), starterSet: vi.fn(),
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', () => ({
  api: {
    lineAccounts: {
      connectCheck: calls.connectCheck,
      connect: calls.connect,
      list: calls.list,
      registrationReceipt: calls.registrationReceipt,
      get: calls.accountGet,
      followerImportState: calls.followerImportState,
      stepFollowerImport: calls.stepFollowerImport,
      followerInsight: calls.followerInsight,
    },
    staff: { list: calls.staffList },
    friends: { list: calls.friendsList },
    lineAccountTags: { list: calls.tagList, create: calls.tagCreate, setForAccount: calls.tagSet },
  },
}))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: calls.styleGet, save: calls.styleSave, starterSet: calls.starterSet } }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }))
vi.mock('@/components/hq/notice-line-register-dialog', () => ({ default: () => null }))

const passedSteps = [
  'チャネルIDとシークレットでアクセストークンを発行',
  '公式アカウントの名前とアイコンを取得',
  'Webhook URLを登録して、実際に届くかテスト',
  'LINE Loginチャネルを確認して、LIFFアプリを作成',
  '認証済みアカウントかを判定',
].map((message, index) => ({ order: index + 1, state: 'passed', message }))

const baseData = {
  steps: passedSteps,
  verification: {
    tokenOk: true, loginOk: true, sameProvider: true,
    webhook: {
      expectedUrl: 'https://worker.test/webhook',
      registeredUrl: 'https://worker.test/webhook',
      active: true, testPassed: true,
    },
    followerTotal: 1284,
  },
  displayName: 'LINE公式名',
  pictureUrl: null,
  basicId: '@line',
  liffId: '2007123456-auto',
  followerImport: { capability: 'unavailable', phase: 'not_started' },
  remainingActions: [],
}

const checked = { success: true, data: baseData }
const waitingReceipt = { success: true, data: { status: 'waiting', receivedAt: null } }
const confirmedReceipt = { success: true, data: { status: 'confirmed', receivedAt: '2026-10-20T10:00:02.000+09:00' } }

afterEach(() => {
  cleanup()
  try { window.localStorage.clear() } catch { /* 下書きが残っても次の試験は上書きする。 */ }
})
beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  calls.connectCheck.mockResolvedValue(checked)
  calls.connect.mockResolvedValue({ success: true, data: { ...baseData, id: 'new-account' } })
  calls.list.mockResolvedValue({ success: true, data: [] })
  calls.registrationReceipt.mockResolvedValue(confirmedReceipt)
  calls.accountGet.mockResolvedValue({ success: true, data: { id: 'new-account', name: baseData.displayName, basicId: baseData.basicId } })
  calls.staffList.mockResolvedValue({ success: true, data: [] })
  calls.tagList.mockResolvedValue({ success: true, data: [] })
  calls.followerInsight.mockResolvedValue({ success: true, data: { followers: null } })
  calls.friendsList.mockResolvedValue({ success: true, data: { total: 0 } })
  calls.styleGet.mockResolvedValue({ success: true, data: { style: 'standard', styleSelected: false, version: 0 } })
  calls.styleSave.mockResolvedValue({ success: true, data: { version: 1 } })
})

const fill = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } })
const next = () => fireEvent.click(screen.getByRole('button', { name: '次へ' }))
const chooseStyle = async (label: string) => {
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: label }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'このスタイルにする' }))
  const save = within(dialog).getByRole('button', { name: '次へ' }) as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
}
/** ②の中だけ進むボタンの名前が違う（v07 Fqy29）。 */
const nextStep = () => fireEvent.click(screen.getByRole('button', { name: '次のステップへ' }))
const back = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

const ack = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }))
const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }))

/**
 * ①事前確認（v07 p6zMkA）を抜ける。Q1=ある／Q2=引き継がない／Q4=使っていない を選ぶと
 * Q3・Q5は尋ねないので、3問＋チェック結果の「次へ」で②-1 Messaging API に入る。
 */
function clearPrecheck() {
  pick('はい、あります')
  pick('いいえ、引き継ぎません')
  pick('使っていません')
  next()
}

/**
 * ①→②-1 Messaging API→②-2 プロバイダーID→②-3 Webhook→②-4 LINEログイン→③Step1。
 * 入力を変えると確認がやり直しになるので先に全部入れる。
 */
function enterCheckStep() {
  render(<RegisterV8 />)
  clearPrecheck()
  fill('v8-channel-id', '123456789')
  fill('v8-channel-secret', 'a'.repeat(32))
  nextStep()
  fill('v8-provider-id', '2005648758')
  nextStep()
  ack('Webhook URL を貼り付けて「更新」を押した')
  ack('Webhookの利用をONにした')
  ack('Webhookの再送をONにした')
  ack('エラーの統計情報をONにした')
  nextStep()
  fill('v8-login-channel-id', '2007123456')
  fill('v8-login-channel-secret', 'b'.repeat(32))
  ack('友だち追加オプションで、この公式アカウントをリンクした')
  ack('チャネルを「開発中」から「公開済み」にした')
  nextStep()
  expect(screen.getByRole('button', { name: '接続を確かめる' })).toBeTruthy()
}

/** 5行は1行ずつ順に出るので、すべて通って「登録する」が出るまで待つ。 */
async function runCheck() {
  fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '登録する' })).toBeTruthy(), { timeout: 5000 })
}

describe('V8 登録ウィザードの gated 進行', () => {
  it('②Step1の2項目が空では次の段へ進めない', async () => {
    render(<RegisterV8 />)
    clearPrecheck()
    const button = screen.getByRole('button', { name: '次のステップへ' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-description')).toBe('チャネルIDとチャネルシークレットを入力してください。')
    nextStep()
    expect(screen.queryByText('Webhook（受信のつなぎ）を設定する', { selector: 'h2' })).toBeNull()
    fill('v8-channel-id', '2007123456')
    expect(button.disabled).toBe(true)
    fill('v8-channel-secret', 'a'.repeat(32))
    expect(button.disabled).toBe(false)
    expect(calls.connectCheck).not.toHaveBeenCalled()
    expect(screen.queryByText('Webhook（受信のつなぎ）を設定する', { selector: 'h2' })).toBeNull()
  })

  /*
    絵の正本ノードは、ソース文字の検索ではなく実際に描かれた印で確かめる。
    v07（LINE新規追加_v07.pen・2026-10-18承認）: p6zMkA=①／Fqy29=②／Lwxyh=③／X0pGdw=④／Plmq1=⑤。
    ノードとURLの対応は scripts/visual-qa/v8-design-map-route-contract.test.ts。
  */
  const shownNode = () => document.querySelector('[data-design-node]')?.getAttribute('data-design-node')

  it('5つの段は絵の正本ノードを描く', async () => {
    const confirmation = deferred<typeof confirmedReceipt>()
    calls.registrationReceipt.mockReturnValueOnce(confirmation.promise)
    enterCheckStep()
    expect(shownNode()).toBe('Lwxyh')
    await runCheck()
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    await screen.findByText('友だち追加できるか確かめます', { selector: 'h2' })
    expect(shownNode()).toBe('Lwxyh')
    expect(calls.accountGet).not.toHaveBeenCalled()
    expect(calls.styleGet).not.toHaveBeenCalled()
    await act(async () => confirmation.resolve(confirmedReceipt))
    await waitFor(() => expect(shownNode()).toBe('X0pGdw'))
    expect(calls.registrationReceipt).toHaveBeenCalledExactlyOnceWith('new-account')
    await chooseStyle('飲食店')
    await waitFor(() => expect(shownNode()).toBe('Plmq1'))
    expect(await screen.findByText('LINEアカウントの登録が完了しました')).toBeTruthy()
    expect(calls.accountGet).toHaveBeenCalledExactlyOnceWith('new-account')
    expect(calls.styleGet).toHaveBeenCalledExactlyOnceWith('new-account', true)
    expect(calls.styleSave).toHaveBeenCalledExactlyOnceWith('new-account', { expectedVersion: 0, style: 'restaurant', answers: { image: { mode: 'later' } } }, true)
    expect(calls.starterSet).not.toHaveBeenCalled()
  })

  it('登録しても受信が確認されるまでは接続確認の段を表示する', async () => {
    calls.registrationReceipt.mockResolvedValue(waitingReceipt)
    const current = () => screen.getByRole('navigation', { name: '登録の進捗' })
      .querySelector('[aria-current="step"]')?.textContent
    enterCheckStep()
    expect(current()).toContain('接続確認')
    await runCheck()
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    await screen.findByText('友だち追加できるか確かめます', { selector: 'h2' })
    expect(current()).toContain('接続確認')
    expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()
  })

  it('④のポップアップを閉じても、スタイルを選ぶまでは⑤へ進まない', async () => {
    enterCheckStep()
    await runCheck()
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'あとで設定する' })).toBeNull()
    expect(screen.queryByText('LINEアカウントの登録が完了しました')).toBeNull()
    expect(calls.styleSave).not.toHaveBeenCalled()
    const stickyBar = document.querySelector<HTMLElement>('[data-shared-part="sticky-bar"]')!
    fireEvent.click(within(stickyBar).getByRole('button', { name: 'スタイルを選ぶ' }))
    await chooseStyle('飲食店')
    expect(await screen.findByText('LINEアカウントの登録が完了しました')).toBeTruthy()
    expect(calls.styleSave).toHaveBeenCalledExactlyOnceWith('new-account', { expectedVersion: 0, style: 'restaurant', answers: { image: { mode: 'later' } } }, true)
    expect(sessionStorage.getItem('musubo-registration-style')).toBeNull()
  })

  it('登録までは済んだ段を押して戻れ、入れた値は残る。登録したら戻れない', async () => {
    calls.registrationReceipt.mockResolvedValue(waitingReceipt)
    enterCheckStep()
    const nav = () => screen.getByRole('navigation', { name: '登録の進捗' })
    fireEvent.click(within(nav()).getByRole('button', { name: 'アカウント接続に戻る' }))
    expect(nav().querySelector('[aria-current="step"]')?.textContent).toContain('アカウント接続')
    expect((document.getElementById('v8-channel-id') as HTMLInputElement).value).toBe('123456789')
    nextStep()
    nextStep()
    nextStep()
    nextStep()
    await runCheck()
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    await screen.findByText('友だち追加できるか確かめます', { selector: 'h2' })
    expect(within(nav()).queryByRole('button', { name: 'アカウント接続に戻る' })).toBeNull()
  })

  it('友だち人数があっても今回の受信が未確認なら自動で進まない', async () => {
    calls.registrationReceipt.mockResolvedValue(waitingReceipt)
    enterCheckStep()
    await runCheck()
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    await screen.findByText('友だち追加できるか確かめます', { selector: 'h2' })
    await waitFor(() => expect(calls.registrationReceipt).toHaveBeenCalledWith('new-account'))
    expect(screen.getByText('接続を待っています…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '次へ', exact: true })).toBeNull()
    expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()
    expect(shownNode()).toBe('Lwxyh')
  })

  it('受信処理と通信の失敗から再確認し、受信が確認されたときだけ自動で進む', async () => {
    calls.registrationReceipt
      .mockResolvedValueOnce(waitingReceipt)
      .mockResolvedValueOnce({ success: true, data: { status: 'error', receivedAt: null } })
      .mockRejectedValueOnce(new Error('temporary connection error'))
    enterCheckStep()
    await runCheck()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登録する' })) })
      expect(screen.getByText('接続を待っています…')).toBeTruthy()
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(screen.getByText('受信の確認に問題があります')).toBeTruthy()
      expect(shownNode()).toBe('Lwxyh')
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(screen.getByText('受信を確認できませんでした')).toBeTruthy()
      expect(shownNode()).toBe('Lwxyh')
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(screen.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeTruthy()
      expect(shownNode()).toBe('X0pGdw')
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(calls.registrationReceipt.mock.calls).toEqual(Array.from({ length: 4 }, () => ['new-account']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('①と②も絵の正本ノードを描く', () => {
    render(<RegisterV8 />)
    expect(shownNode()).toBe('p6zMkA')
    clearPrecheck()
    expect(shownNode()).toBe('Fqy29')
  })

  /*
    手順の順番は絵の正本がすべて（利用者指示 2026-10-17）。
    `②-1 Step1 Messaging API`／`②-2 Step2 プロバイダーID`／`②-3 Step3 Webhook の設定`／`②-4 Step4 LINEログインの2項目`、
    戻るの行き先の名前（事前確認へ戻る→Messaging API へ戻る→プロバイダーIDへ戻る→Webhook の設定へ戻る）、
    `Lwxyh` Step1 の「LINEログインへ戻る」を、実際のボタン操作でたどって確かめる。
  */
  /** 出ている段は、描かれた札（Card の aria-label）で見る。 */
  const PANELS = ['Messaging API の情報を入れる', 'プロバイダーIDを確認する', 'Webhook（受信のつなぎ）を設定する', 'LINEログインの情報を入れる'] as const
  const shownPanel = () => PANELS.find((label) => document.querySelector(`[aria-label="${label}"]`))
  const stepBadgeText = () => screen.getByText(/^Step \d \/ 4$/).textContent

  it('②は承認済みの絵どおり Messaging API→プロバイダーID→Webhook→LINEログイン の順に進む', () => {
    render(<RegisterV8 />)
    clearPrecheck()
    expect(stepBadgeText()).toBe('Step 1 / 4')
    expect(shownPanel()).toBe('Messaging API の情報を入れる')

    fill('v8-channel-id', '123456789')
    fill('v8-channel-secret', 'a'.repeat(32))
    nextStep()
    expect(stepBadgeText()).toBe('Step 2 / 4')
    expect(shownPanel()).toBe('プロバイダーIDを確認する')
    fill('v8-provider-id', '2005648758')
    nextStep()
    expect(stepBadgeText()).toBe('Step 3 / 4')
    expect(shownPanel()).toBe('Webhook（受信のつなぎ）を設定する')
    expect(document.getElementById('v8-login-channel-id')).toBeNull()

    ack('Webhook URL を貼り付けて「更新」を押した')
    ack('Webhookの利用をONにした')
    ack('Webhookの再送をONにした')
    ack('エラーの統計情報をONにした')
    nextStep()
    expect(stepBadgeText()).toBe('Step 4 / 4')
    expect(shownPanel()).toBe('LINEログインの情報を入れる')
  })

  it('②の「次のステップへ」は、その段のチェックが全部入るまで押せない', () => {
    render(<RegisterV8 />)
    clearPrecheck()
    fill('v8-channel-id', '123456789')
    fill('v8-channel-secret', 'a'.repeat(32))
    nextStep()
    fill('v8-provider-id', '2005648758')
    nextStep()
    const button = () => screen.getByRole('button', { name: '次のステップへ' }) as HTMLButtonElement
    expect(button().disabled).toBe(true)
    ack('Webhook URL を貼り付けて「更新」を押した')
    ack('Webhookの利用をONにした')
    ack('Webhookの再送をONにした')
    expect(button().disabled).toBe(true)
    ack('エラーの統計情報をONにした')
    expect(button().disabled).toBe(false)
  })

  it('IDの誤入力はその欄で止め、桁違いは確認してから先へ進める', () => {
    render(<RegisterV8 />)
    clearPrecheck()
    fill('v8-channel-id', '１２３４')
    fireEvent.blur(document.getElementById('v8-channel-id')!)
    expect(screen.getByText(/チャネルIDは余分な空白を除き、半角数字/)).toBeTruthy()
    fill('v8-channel-id', '1234')
    fill('v8-channel-secret', 'a'.repeat(32))
    nextStep()
    expect(screen.getByText(/桁数が通常と異なる可能性があります（現在4桁）/)).toBeTruthy()
    expect(stepBadgeText()).toBe('Step 1 / 4')
    nextStep()
    expect(stepBadgeText()).toBe('Step 2 / 4')
  })

  it('LINEログインにMessaging APIと同じIDを入れると次へ進めない', () => {
    enterCheckStep()
    back('LINEログインへ戻る')
    fill('v8-login-channel-id', '123456789')
    nextStep()
    expect(screen.getByText(/Messaging APIと同じIDです/)).toBeTruthy()
    expect(stepBadgeText()).toBe('Step 4 / 4')
    fill('v8-login-channel-id', '2007123456')
    nextStep()
    expect(screen.getByRole('button', { name: '接続を確かめる' })).toBeTruthy()
  })

  it('戻るボタンは行き先の名前で、絵の正本の順に逆戻りする', () => {
    enterCheckStep()
    expect(shownNode()).toBe('Lwxyh')

    back('LINEログインへ戻る')
    expect(shownPanel()).toBe('LINEログインの情報を入れる')
    back('Webhook の設定へ戻る')
    expect(shownPanel()).toBe('Webhook（受信のつなぎ）を設定する')
    back('プロバイダーIDへ戻る')
    expect(shownPanel()).toBe('プロバイダーIDを確認する')
    back('Messaging API へ戻る')
    expect(shownPanel()).toBe('Messaging API の情報を入れる')
    back('事前確認へ戻る')
    expect(shownNode()).toBe('p6zMkA')
  })

  it('③は確かめる前は5行とも待ちで、勝手に問い合わせない', () => {
    enterCheckStep()
    expect(screen.getByText('いただいた4項目で、2つのチャネルに接続できるか試します。')).toBeTruthy()
    expect(document.querySelectorAll('[data-phase="waiting"]').length).toBe(5)
    expect(calls.connectCheck).not.toHaveBeenCalled()
  })

  it('5行が通ってから登録でき、登録すると③Step2へ進む', async () => {
    calls.registrationReceipt.mockResolvedValue(waitingReceipt)
    enterCheckStep()
    expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
    expect(calls.connect).not.toHaveBeenCalled()
    await runCheck()
    expect(document.querySelectorAll('[data-phase="ok"]').length).toBe(5)
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    await waitFor(() => expect(calls.connect).toHaveBeenCalledOnce())
    expect(await screen.findByText('友だち追加できるか確かめます', { selector: 'h2' })).toBeTruthy()
  })

  it('登録後は画面から取り込みの続きを進め、完了を画面へ反映する', async () => {
    const inProgress: FollowerImportState = {
      version: 1, capability: 'available', phase: 'importing_ids',
      eligibilityCheckedAt: null, startedAt: '2026-10-20T10:00:00+09:00', completedAt: null, updatedAt: '2026-10-20T10:00:01+09:00',
      received: 0, imported: 0, reactivated: 0, claimedUnassigned: 0, alreadyPresent: 0, conflicts: 0, invalid: 0,
      profilesProcessed: 0, profilesUpdated: 0, profileErrors: 0, lastError: null,
    }
    const completed: FollowerImportState = {
      ...inProgress, phase: 'completed', completedAt: '2026-10-20T10:00:03+09:00', updatedAt: '2026-10-20T10:00:03+09:00',
      received: 10, imported: 10, profilesProcessed: 10, profilesUpdated: 10,
    }
    const earlierState = deferred<{ success: true; data: FollowerImportState }>()
    calls.connect.mockResolvedValue({ success: true, data: { ...baseData, id: 'new-account', followerImport: { capability: inProgress.capability, phase: inProgress.phase } } })
    calls.followerImportState.mockReturnValueOnce(earlierState.promise)
    calls.stepFollowerImport.mockResolvedValue({ success: true, data: { state: completed, busy: false, profilesFetched: 10 } })
    enterCheckStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
    await runCheck()
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
    expect(calls.stepFollowerImport).not.toHaveBeenCalled()
    await chooseStyle('飲食店')
    await waitFor(() => expect(calls.stepFollowerImport).toHaveBeenCalledExactlyOnceWith('new-account'))
    expect(calls.followerImportState).toHaveBeenCalledExactlyOnceWith('new-account')
    // 取り込み完了後は引き継ぎ結果の板を出し、汎用の完了文は出さない。
    await screen.findByText('友だちの引き継ぎが完了しました', { selector: 'h2' })
    await act(async () => earlierState.resolve({ success: true, data: inProgress }))
    expect(screen.getByRole('heading', { name: '友だちの引き継ぎが完了しました' })).toBeTruthy()
    expect(screen.queryByText('LINEアカウントの登録が完了しました')).toBeNull()
    expect(screen.getByText('10人の友だちを引き継ぎました')).toBeTruthy()
  })

  it('「Webhookの利用」がオフなら、その行で止めて保存しない', async () => {
    const failedSteps = passedSteps.map((step) => ({ ...step }))
    failedSteps[2] = { ...failedSteps[2], state: 'failed', message: 'LINE Developersで「Webhookの利用」をオンにしてください' }
    calls.connectCheck.mockResolvedValue({
      success: true,
      data: {
        ...baseData,
        steps: failedSteps,
        verification: {
          ...baseData.verification,
          webhook: { ...baseData.verification.webhook, active: false, testPassed: false },
        },
      },
    })
    enterCheckStep()
    fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
    // 行の文字は止まった時点で出るが、案内は5行の演出が終わってから出る。
    expect(await screen.findByText('「Webhookの利用」をONにしてください', {}, { timeout: 5000 })).toBeTruthy()
    const failedRow = screen.getByText('URLは登録できましたが、「Webhookの利用」がOFFのままです。下の案内のとおりONにしてください。').closest('li')
    expect(failedRow?.getAttribute('data-phase')).toBe('error')
    expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
    expect(calls.connect).not.toHaveBeenCalled()
  })
})

describe('toV8CheckRows（5行の組み立て）', () => {
  const failedAt = (order: number, message: string) =>
    passedSteps.map((step) => (step.order === order ? { ...step, state: 'failed', message } : step))

  it('検査前はすべて「まだ」', () => {
    const rows = toV8CheckRows(null)
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.state === 'todo')).toBe(true)
    expect(allV8RowsPassed(rows)).toBe(false)
  })

  it('全部通ると5行とも通り、友だち追加URLは LINE ID から作る', () => {
    const rows = toV8CheckRows(baseData as unknown as LineAccountConnectData)
    expect(rows.every((row) => row.state === 'passed')).toBe(true)
    expect(allV8RowsPassed(rows)).toBe(true)
  })

  it('チャネルが落ちると1・2行目が止まり、保存の関所も落ちる', () => {
    const connection = {
      ...baseData,
      steps: failedAt(1, 'チャネルID・チャネルシークレットを確認してください。'),
      verification: { ...baseData.verification, tokenOk: false, sameProvider: false },
    } as unknown as LineAccountConnectData
    const rows = toV8CheckRows(connection)
    expect(rows[0].state).toBe('failed')
    expect(rows[1].state).toBe('failed')
    expect(allV8RowsPassed(rows)).toBe(false)
  })

  it('Webhook が止まると4・5行目は「まだ」のまま（3が通ると確かめる）', () => {
    const connection = {
      ...baseData,
      steps: failedAt(3, 'LINE Developersで「Webhookの利用」をオンにしてください'),
      verification: {
        ...baseData.verification,
        webhook: { ...baseData.verification.webhook, active: false, testPassed: false },
      },
    } as unknown as LineAccountConnectData
    const rows = toV8CheckRows(connection)
    expect(rows[2].state).toBe('failed')
    expect(rows[3].state).toBe('todo')
    expect(rows[4].state).toBe('todo')
    expect(allV8RowsPassed(rows)).toBe(false)
  })
})
