// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewLineAccountPage from './page'
import { ApiError } from '@/lib/api'

/**
 * R523: LINEアカウント登録の保存応答を失うと未保存と誤案内し、再試行で重複する。
 * - 応答のない保存失敗は「DBには保存していません」と断定せず、同じチャネルIDの
 *   登録済みを照合して詳細への復帰を出す。
 * - 重複エラー（同じ情報での再試行）は行き止まりにせず、登録済みの詳細へ案内する。
 * - 行が無い真の失敗は従来どおり失敗として出す。
 */
const calls = vi.hoisted(() => ({
  connectCheck: vi.fn(), connect: vi.fn(), stepFollowerImport: vi.fn(), list: vi.fn(),
}))
const notices = vi.hoisted(() => ({ lineRegistration: vi.fn() }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { lineAccounts: calls, hqNotices: notices, friends: { list: async () => ({success:true,data:{total:0}}) }, lineAccountTags: { list: async () => ({success:true,data:[]}) }, staff: { list: async () => ({success:true,data:[]}) } } }
})
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/accounts/new', useRouter: () => ({ push: vi.fn() }) }))

const passedSteps = [
  'チャネルIDとシークレットでアクセストークンを発行',
  '公式アカウントの名前とアイコンを取得',
  'Webhook URLを登録して、実際に届くかテスト',
  'LINE Loginチャネルを確認して、LIFFアプリを作成',
  '認証済みアカウントかを判定',
].map((message, index) => ({ order: index + 1, state: 'passed', message }))

const checked = {
  success: true,
  data: {
    steps: passedSteps,
    displayName: 'LINE公式名',
    pictureUrl: null,
    basicId: '@line',
    liffId: '2007123456-auto',
    followerImport: { capability: 'unavailable', phase: 'not_started' },
    remainingActions: [],
  },
}

afterEach(() => { cleanup(); window.localStorage?.clear(); delete document.documentElement.dataset.theme })
beforeEach(() => {
  vi.clearAllMocks(); document.documentElement.dataset.theme='v8'
  calls.connectCheck.mockResolvedValue(checked)
  calls.connect.mockResolvedValue({ success: true, data: { ...checked.data, id: 'new-account' } })
  calls.list.mockResolvedValue({ success: true, data: [] })
  notices.lineRegistration.mockResolvedValue({ success: true, data: { available: false } })
})

const fill = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } })
const next = () => fireEvent.click(screen.getByRole('button', { name: '次へ' }))
/** ②の中だけ進むボタンの名前が違う（v07 Fqy29）。 */
const nextStep = () => {
  fireEvent.click(screen.getByRole('button', { name: '次のステップへ' }))
  if (screen.queryAllByText(/正しければ「次のステップへ」をもう一度押して進めます。/).length) {
    fireEvent.click(screen.getByRole('button', { name: '次のステップへ' }))
  }
}
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
 * v07（Fqy29）の順番どおり：①→②-1 Messaging API→②-2 Webhook→②-3 LINEログイン→③Step1。
 * 5行の確認が全部通ると「登録する」が出る（5行 × 420ms）。
 */
function enterCheckStep() {
  render(<NewLineAccountPage />)
  clearPrecheck()
  fill('v8-channel-id', '123456789')
  fill('v8-channel-secret', 'synthetic-secret')
  nextStep()
  fill('v8-provider-id', '2005648758')
  nextStep()
  ack('Webhook URL を貼り付けて「更新」を押した')
  ack('Webhookの利用をONにした')
  ack('Webhookの再送をONにした')
  ack('エラーの統計情報をONにした')
  nextStep()
  fill('v8-login-channel-id', '2007123456')
  fill('v8-login-channel-secret', 'synthetic-login-secret')
  ack('友だち追加オプションで、この公式アカウントをリンクした')
  ack('チャネルを「開発中」から「公開済み」にした')
  nextStep()
}

async function enterSaveStep() {
  enterCheckStep()
  fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '登録する' })).toBeTruthy(), { timeout: 5000 })
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: '登録する' }))
}

describe('R523 保存の応答消失と重複（本物のReact）', () => {
  it('応答を失っても未保存と断定せず、登録済みの詳細へ復帰する', async () => {
    await enterSaveStep()
    // サーバ側では行が作られたが、応答だけ届かない。
    calls.connect.mockRejectedValue(new Error('fetch failed'))
    calls.list.mockResolvedValue({
      success: true,
      data: [{ id: 'acc-9', channelId: '123456789', name: '登録済み' }],
    })
    await save()

    await screen.findByText('保存は終わっている可能性があります。登録済みのアカウントを開いて確認してください。')
    expect(screen.queryByText(/DBには保存していません/)).toBeNull()
    const back = screen.getByRole('link', { name: '登録したアカウントを見る' })
    expect(back.getAttribute('href')).toBe('/accounts/detail?id=acc-9')
    // 重複作成はしない（保存口は1回だけ）。
    expect(calls.connect).toHaveBeenCalledTimes(1)
  })

  it('同じ情報での再試行の重複エラーは行き止まりにせず詳細へ案内する', async () => {
    await enterSaveStep()
    calls.connect.mockResolvedValue({ success: false, error: 'channelId already registered' })
    calls.list.mockResolvedValue({
      success: true,
      data: [{ id: 'acc-9', channelId: '123456789', name: '登録済み' }],
    })
    await save()

    await screen.findByText('このチャネルIDは登録済みです。登録済みのアカウントを開いて確認してください。')
    expect(screen.getByRole('link', { name: '登録したアカウントを見る' }).getAttribute('href')).toBe('/accounts/detail?id=acc-9')
  })

  it('行が無い真の失敗は失敗として出す', async () => {
    await enterSaveStep()
    calls.connect.mockRejectedValue(new Error('fetch failed'))
    calls.list.mockResolvedValue({ success: true, data: [] })
    await save()

    await screen.findByText('登録できませんでした。時間をおいて、もう一度お試しください。')
    expect(screen.queryByText(/DBには保存していません/)).toBeNull()
  })
})


describe('接続確認の失敗後も入力と権限の案内を保つ', () => {
  it.each([
    [403, 'この操作の権限がありません。オーナーか管理者に頼んでください。'],
    [429, '混み合っています。60秒ほど待ってから、もう一度お試しください。'],
  ])('%iでは原因を案内し、登録せず入力を残す', async (status, message) => {
    enterCheckStep()
    calls.connectCheck.mockRejectedValue(new ApiError(status, undefined, undefined, undefined, undefined, 60))
    fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
    await screen.findByText(message)
    expect(calls.connectCheck).toHaveBeenCalledOnce()
    expect(calls.connect).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
    expect(screen.getByRole('button', { name: 'もう一度確かめる' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'LINEログインへ戻る' }))
    expect((document.getElementById('v8-login-channel-id') as HTMLInputElement).value).toBe('2007123456')
    expect((document.getElementById('v8-login-channel-secret') as HTMLInputElement).value).toBe('synthetic-login-secret')
    fireEvent.click(screen.getByRole('button', { name: 'Webhook の設定へ戻る' }))
    fireEvent.click(screen.getByRole('button', { name: 'プロバイダーIDへ戻る' }))
    fireEvent.click(screen.getByRole('button', { name: 'Messaging API へ戻る' }))
    expect((document.getElementById('v8-channel-id') as HTMLInputElement).value).toBe('123456789')
    expect((document.getElementById('v8-channel-secret') as HTMLInputElement).value).toBe('synthetic-secret')
  })
})
