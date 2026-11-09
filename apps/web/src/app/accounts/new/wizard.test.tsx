// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import NewLineAccountPage from './page'

/*
 * v07（LINE新規追加_v07.pen・2026-10-18承認）の5段の通し。
 * ②は4つ、③は2つの小さな段に分かれ、登録は③Step1の「登録する」で行う。
 * 登録前のタグ・親アカウント・担当範囲・既存LIFF IDの入力は承認済みの設計で外したので、
 * ここでは確かめない（wire の tagIds などは空のまま送る）。
 */

const calls = vi.hoisted(() => ({
  connectCheck: vi.fn(), connect: vi.fn(), followerImportState: vi.fn(), stepFollowerImport: vi.fn(), list: vi.fn(), followerInsight: vi.fn(), registrationReceipt: vi.fn(),
}))
const friends = vi.hoisted(() => ({ list: vi.fn() }))
// 登録完了直後の契約者専用LINEの登録案内（★管理画面 37-7）。既定は「運営側で未設定」なので何も出ない
const accountTags = vi.hoisted(() => ({ list: vi.fn(async () => ({success:true,data:[{id:'tag-own',name:'店舗',color:null}]})) }))
const notices = vi.hoisted(() => ({ lineRegistration: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn(async () => ({ success: true, data: { style: 'standard', styleSelected: false, version: 0 } })), save: vi.fn(async () => ({ success: true, data: { version: 1 } })) } }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', () => ({ api: { lineAccounts: calls, lineAccountTags: accountTags, hqNotices: notices, friends, staff: { list: async () => ({ success: true, data: [] }) } } }))
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
  sessionStorage.clear()
  vi.clearAllMocks(); document.documentElement.dataset.theme='v8'
  calls.list.mockResolvedValue({success:true,data:[]}); calls.followerInsight.mockResolvedValue({success:true,data:{total:null}});
  calls.connectCheck.mockResolvedValue(checked)
  calls.connect.mockResolvedValue({ success: true, data: { ...checked.data, id: 'new-account' } })
  calls.registrationReceipt.mockResolvedValue({ success: true, data: { status: 'confirmed', receivedAt: '2026-10-20T10:00:02.000+09:00' } })
  friends.list.mockResolvedValue({ success: true, data: { total: 0 } })
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
const pick = (name: string | RegExp) => fireEvent.click(screen.getByRole('radio', { name }))

/**
 * ①事前確認を最短で通す。回答時に次の質問へ進み、チェック結果で「次へ」を押す。
 * Q1=はい → Q2=いいえ（Q3は尋ねない）→ Q4=使っていません（Q5は尋ねない）→ チェック結果 → ②へ。
 */
function passPrecheck() {
  pick('はい、あります')
  pick('いいえ、引き継ぎません')
  pick('使っていません')
  expect(screen.getByText('あなたの接続前チェック結果')).toBeTruthy()
  next()
}

/**
 * ①→②-1 Messaging API→②-2 プロバイダーID→②-3 Webhook→②-4 LINEログイン→③Step1。
 * 入力を変えると確認がやり直しになるので、先に全部入れる。
 */
function enterCheckStep() {
  render(<NewLineAccountPage />)
  passPrecheck()
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
  expect(screen.getByRole('button', { name: '接続を確かめる' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: '接続確認', exact: true }))
}

/** 5行は1行ずつ順に出るので、すべて通るまで待つ（5行 × 420ms）。 */
async function runCheck() {
  fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '登録する' })).toBeTruthy(), { timeout: 5000 })
}

/** ③Step1で登録し、③Step2・④を通って⑤まで進む。 */
async function saveAndFinish() {
  fireEvent.click(screen.getByRole('button', { name: '登録する' }))
  const heading = await screen.findByRole('heading', { name: '友だち追加できるか確かめます' })
  expect(document.activeElement).toBe(heading)
  await waitFor(() => expect((screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement).disabled).toBe(false))
  next()
  const dialog = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  expect(document.querySelector('[data-step-heading]')?.textContent).toBe('使い方のスタイルを選ぶ')
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  const skip = within(dialog).getByRole('button', { name: 'あとで設定する' })
  await waitFor(() => expect((skip as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(skip)
}

describe('LINEアカウント作成ウィザード', () => {
  it('質問・段・小さな段を進めたら現在の題へ焦点を移し、本文全体には当てない', () => {
    render(<NewLineAccountPage />)
    const expectHeadingFocus = () => {
      const heading = document.activeElement as HTMLElement
      expect(['H2', 'H3']).toContain(heading.tagName)
      expect(heading.getAttribute('tabindex')).toBe('-1')
      expect(heading.hasAttribute('data-step-heading')).toBe(true)
      expect(heading.closest('[data-step-content]')).not.toBeNull()
      expect(document.querySelectorAll('[data-step-content][tabindex]')).toHaveLength(0)
      return heading
    }
    const firstText = expectHeadingFocus().textContent
    pick('はい、あります')
    const second = expectHeadingFocus()
    expect(second.textContent).not.toBe(firstText)
    expect(second).toBe(screen.getByRole('heading', { name: second.textContent! }))
    pick('いいえ、引き継ぎません')
    expectHeadingFocus()
    pick('使っていません')
    expect(expectHeadingFocus()).toBe(screen.getByRole('heading', { name: 'ご利用環境の確認' }))
    next()
    expect(expectHeadingFocus()).toBe(screen.getByRole('heading', { name: 'Messaging API の情報を入れる' }))
    fill('v8-channel-id', '123456789')
    fill('v8-channel-secret', 'synthetic-secret')
    nextStep()
    expect(expectHeadingFocus()).toBe(screen.getByRole('heading', { name: 'プロバイダーIDを確認する' }))
    fireEvent.click(screen.getByRole('button', { name: 'Messaging API へ戻る', exact: true }))
    expect(expectHeadingFocus()).toBe(screen.getByRole('heading', { name: 'Messaging API の情報を入れる' }))
    expect((document.getElementById('v8-channel-id') as HTMLInputElement).value).toBe('123456789')
  })

  it('①の質問に答えてから②の4つの小さな段へ順に進む', () => {
    render(<NewLineAccountPage />)
    expect(screen.getByText('ご利用環境の確認', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('質問 1')).toBeTruthy()
    expect(screen.queryByText('このあとの質問')).toBeNull()
    passPrecheck()
    expect(screen.getByText('Messaging API の情報を入れる', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Step 1 / 4')).toBeTruthy()
    fill('v8-channel-id', '123456789')
    fill('v8-channel-secret', 'synthetic-secret')
    nextStep()
    expect(screen.getByText('プロバイダーIDを確認する', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Step 2 / 4')).toBeTruthy()
    fill('v8-provider-id', '2005648758')
    nextStep()
    expect(screen.getByText('Webhook（受信のつなぎ）を設定する', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Step 3 / 4')).toBeTruthy()
    ack('Webhook URL を貼り付けて「更新」を押した')
    ack('Webhookの利用をONにした')
    ack('Webhookの再送をONにした')
    ack('エラーの統計情報をONにした')
    nextStep()
    expect(screen.getByText('LINEログインの情報を入れる', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('Step 4 / 4')).toBeTruthy()
    const providerLink = screen.getByRole('link', { name: 'LINE Developers のプロバイダーを開く' })
    expect(providerLink.getAttribute('href')).toBe('https://developers.line.biz/console/provider/2005648758')
    expect(providerLink.getAttribute('target')).toBe('_blank')
  })

  it('前の質問へ戻り、選択済みの回答をもう一度押しても次の質問へ進む', async () => {
    render(<NewLineAccountPage />)
    fireEvent.click(screen.getByRole('radio', { name: 'はい、あります' }))
    fireEvent.click(screen.getByRole('button', { name: '戻る', exact: true }))
    const selected = await screen.findByRole('radio', { name: 'はい、あります' }) as HTMLInputElement
    await waitFor(() => expect(selected.checked).toBe(true))
    expect(screen.getByText('Q1. LINE公式アカウントはありますか？', { selector: 'h3' })).toBeTruthy()
    expect(screen.queryByText('このあとの質問')).toBeNull()
    fireEvent.click(selected.closest('label')!)
    expect(screen.getByText('Q2. いまの友だちを引き継ぎますか？', { selector: 'h3' })).toBeTruthy()
    expect(screen.queryByText('このあとの質問')).toBeNull()
  })

  it('LINE側でやることの印が残っていると次の段へ進めない', () => {
    render(<NewLineAccountPage />)
    passPrecheck()
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
    const step = () => screen.getByRole('button', { name: '次のステップへ' }) as HTMLButtonElement
    expect(step().disabled).toBe(true)
    ack('友だち追加オプションで、この公式アカウントをリンクした')
    expect(step().disabled).toBe(true)
    ack('チャネルを「開発中」から「公開済み」にした')
    expect(step().disabled).toBe(false)
  })

  it('①-1 Q1がいいえなら公式アカウント作成リンクを別タブで出し、先へ進めない', () => {
    render(<NewLineAccountPage />)
    pick('いいえ、まだありません')
    const link = screen.getByRole('link', { name: /LINE公式アカウントを作る/ })
    expect(link.getAttribute('href')).toBe('https://manager.line.biz/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByRole('button', { name: '次へ' })).toBeNull()
  })

  it('①-9 Q2がはいなら認証済みアカウントの印にチェックするまで進めない', () => {
    render(<NewLineAccountPage />)
    pick('はい、あります')
    expect(screen.getByText('Q2. いまの友だちを引き継ぎますか？', { selector: 'h3' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '次へ' })).toBeNull()
    pick('はい、引き継ぎます')
    expect(screen.getByText('Q2. いまの友だちを引き継ぎますか？', { selector: 'h3' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '次へ' })).toBeNull()
    ack('認証済みアカウントであることを確認した')
    expect(screen.getByText('Q3. ほかのLINE配信ツールを使っていますか？', { selector: 'h3' })).toBeTruthy()
  })

  it('①の条件付き質問を自動で進め、最後の次へだけで②へ進む', () => {
    render(<NewLineAccountPage />)
    pick('はい、あります')
    pick('いいえ、引き継ぎません')
    expect(screen.getByText('Q3. ほかのLINE配信ツールを使っていますか？', { selector: 'h3' })).toBeTruthy()
    pick('使っています')
    expect(screen.getByText('Q4. そのツールを、これからどうしますか？', { selector: 'h3' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '次へ' })).toBeNull()
    pick(/musuboに乗り換える/)
    expect(screen.getByText('あなたの接続前チェック結果')).toBeTruthy()
    expect(screen.getByText('二重に届かない切り替え方をご案内します')).toBeTruthy()
    next()
    expect(screen.getByText('Messaging API の情報を入れる', { selector: 'h2' })).toBeTruthy()
  })

  it('回答を変更すると新しい分岐の質問へ進み、戻る操作も使える', () => {
    render(<NewLineAccountPage />)
    pick('はい、あります')
    pick('いいえ、引き継ぎません')
    pick('使っていません')
    fireEvent.click(screen.getAllByRole('button', { name: '変更' })[1])
    expect(screen.getByText('Q2. いまの友だちを引き継ぎますか？', { selector: 'h3' })).toBeTruthy()
    pick('はい、引き継ぎます')
    ack('認証済みアカウントであることを確認した')
    expect(screen.getByText('Q3. ほかのLINE配信ツールを使っていますか？', { selector: 'h3' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '戻る' }))
    expect(screen.getByText('Q2. いまの友だちを引き継ぎますか？', { selector: 'h3' })).toBeTruthy()
  })

  it('友だちを引き継ぐ場合も人数を再質問しない', () => {
    render(<NewLineAccountPage />)
    pick('はい、あります')
    pick('はい、引き継ぎます')
    ack('認証済みアカウントであることを確認した')
    expect(screen.getByText('Q3. ほかのLINE配信ツールを使っていますか？', { selector: 'h3' })).toBeTruthy()
    expect(screen.queryByText(/友だちの数は50万人/)).toBeNull()
  })

  it('②Step1は Messaging API の2項目を必須にし、マニュアルを別タブで開く', () => {
    render(<NewLineAccountPage />)
    passPrecheck()
    const ids = ['v8-channel-id', 'v8-channel-secret']
    expect(ids.every((id) => (document.getElementById(id) as HTMLInputElement).required)).toBe(true)
    expect(document.getElementById('v8-provider-id')).toBeNull()
    expect(document.getElementById('channel-access-token')).toBeNull()
    expect(document.getElementById('liff-id')).toBeNull()
    /* ②-1は公式アカウントマネージャーからMessaging API設定を開く。 */
    const manager = screen.getByRole('link', { name: /LINE公式アカウントマネージャーを開く/ })
    expect(manager.getAttribute('href')).toBe('https://manager.line.biz/')
    expect(manager.getAttribute('target')).toBe('_blank')
    const manual = screen.getByRole('link', { name: /マニュアルを開く/ })
    expect(manual.getAttribute('href')).toBe('/manuals/line-connect/index.html')
    expect(manual.getAttribute('target')).toBe('_blank')
  })

  it('5行で止まった箇所を示し、失敗時は登録できない', async () => {
    calls.connectCheck.mockResolvedValue({
      success: true,
      data: {
        ...checked.data,
        steps: passedSteps.map((item, index) => index === 2
          ? { ...item, state: 'failed', message: 'Webhookの利用をオンにしてください' }
          : index > 2 ? { ...item, state: 'skipped' } : item),
      },
    })
    enterCheckStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE Developersで同じプロバイダーにあることを確かめた' }))
    fireEvent.click(screen.getByRole('button', { name: '接続を確かめる' }))
    expect(await screen.findByText('Webhook URL の登録で止まりました', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
    expect(screen.getByRole('button', { name: 'もう一度確かめる' })).toBeTruthy()
    expect(calls.connect).not.toHaveBeenCalled()
  })

  it('5つの確認が通ってから登録し、完了画面まで進む', async () => {
    let finishNotice!: (response: { success: boolean; data: { available: boolean } }) => void
    notices.lineRegistration.mockReturnValueOnce(new Promise((resolve) => { finishNotice = resolve }))
    enterCheckStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE Developersで同じプロバイダーにあることを確かめた' }))
    await runCheck()
    await saveAndFinish()
    const completeHeading = await screen.findByRole('heading', { name: 'LINEアカウントの登録が完了しました' })
    await waitFor(() => expect(document.activeElement).toBe(completeHeading))
    expect(calls.connect).toHaveBeenCalledWith(expect.objectContaining({
      name: undefined,
      channelId: '123456789',
      channelSecret: 'synthetic-secret',
      loginChannelId: '2007123456',
      loginChannelSecret: 'synthetic-login-secret',
    }), undefined)
    expect(screen.getByRole('link', { name: '登録したアカウントを見る' }).getAttribute('href')).toBe('/accounts/detail?id=new-account')
    expect(screen.getByRole('link', { name: '統括コンソールへ戻る' }).getAttribute('href')).toBe('/hq')
    expect(document.body.textContent).not.toContain('synthetic-secret')
    await waitFor(() => expect(notices.lineRegistration).toHaveBeenCalled())
    expect(screen.getByText('案内を読み込んでいます…')).toBeTruthy()
    finishNotice({ success: true, data: { available: false } })
    await waitFor(() => expect(document.body.textContent).not.toContain('musubo 運営（契約者専用）'))
  })

  it('登録完了の直後に、契約者専用LINEの登録案内を一度だけ出す（案内だけで、閉じられる）', async () => {
    notices.lineRegistration.mockResolvedValue({ success: true, data: {
      available: true, accountName: 'musubo 運営（契約者専用）', basicId: '@musubo', addFriendUrl: 'https://line.me/R/ti/p/@musubo',
      linked: false, code: '123456', codeExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    } })
    enterCheckStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE Developersで同じプロバイダーにあることを確かめた' }))
    await runCheck()
    await saveAndFinish()
    await screen.findByText('LINEアカウントの登録が完了しました')
    const notice = await screen.findByRole('dialog', { name: '運営からの通知をLINEで受け取る' })
    await screen.findByText('123456')
    fireEvent.click(within(notice).getByRole('button', { name: '閉じる', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '運営からの通知をLINEで受け取る' })).toBeNull())
    expect(notices.lineRegistration).toHaveBeenCalledTimes(1)
  })

  it('Penの探索中は円形ローダーだけが動き、完了後は人数と満タンの棒を表示する', async () => {
    let finishStep!: (value: unknown) => void
    calls.connect.mockResolvedValue({
      success: true,
      data: {
        ...checked.data,
        id: 'verified-account',
        followerImport: { capability: 'available', phase: 'importing_ids' },
      },
    })
    /* 画面を開いている間は step で続きを進める（読むだけでは自動処理を待つことになる）。 */
    calls.stepFollowerImport.mockImplementation(() => new Promise((resolve) => { finishStep = resolve }))
    calls.followerImportState.mockResolvedValue({ success: true, data: {
      capability: 'available', phase: 'importing_ids', received: 0, imported: 0,
      alreadyPresent: 0, reactivated: 0, claimedUnassigned: 0, conflicts: 0, invalid: 0,
      profilesProcessed: 0, profilesUpdated: 0,
    } })
    enterCheckStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE Developersで同じプロバイダーにあることを確かめた' }))
    await runCheck()
    await saveAndFinish()
    await screen.findByText('友だちを確認しています', { selector: 'h2' })
    const progress = screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' })
    expect(progress.getAttribute('aria-valuenow')).toBeNull()
    expect(progress.getAttribute('aria-valuetext')).toBe('対象人数を確認中')
    expect(progress.childElementCount).toBe(0)
    expect(screen.getByText('友だちを確認しています', { selector: 'h2' }).previousElementSibling?.firstElementChild?.getAttribute('class')).toContain('handoverSpinner')
    expect(screen.queryByRole('link', { name: '登録したアカウントを見る' })).toBeNull()
    await waitFor(() => expect(calls.stepFollowerImport).toHaveBeenCalled())
    finishStep({ success: true, data: {
      state: { capability: 'available', phase: 'completed', received: 10, imported: 10 },
      busy: false, profilesFetched: 10,
    } })
    await screen.findByText('友だちの引き継ぎが完了しました', { selector: 'h2' })
    expect(screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' }).getAttribute('aria-valuenow')).toBe('10')
    expect(screen.getByText('10人の友だちを引き継ぎました')).toBeTruthy()
  })

  it('Penの進行中は前日集計と現在の4人を区別し、1人処理で棒を25%にする', async () => {
    calls.connect.mockResolvedValue({ success: true, data: {
      ...checked.data, id: 'partial-account',
      verification: { ...checked.data.verification, followerTotal: 2 },
      followerImport: { capability: 'available', phase: 'importing_ids' },
    } })
    calls.stepFollowerImport
      .mockResolvedValueOnce({ success: true, data: { state: {
        capability: 'available', phase: 'hydrating_profiles', received: 4,
        imported: 1, alreadyPresent: 0, profilesProcessed: 0, profilesUpdated: 0,
      }, busy: true, profilesFetched: 0 } })
      .mockImplementation(() => new Promise(() => {}))
    enterCheckStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE Developersで同じプロバイダーにあることを確かめた' }))
    await runCheck()
    await saveAndFinish()
    await screen.findByText('4人のうち1人を引き継ぎました。残り3人を処理中です。')
    expect(screen.getByText('前日集計は2人でした。現在の対象数は4人です。')).toBeTruthy()
    const progress = screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' })
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    expect(progress.getAttribute('aria-valuemax')).toBe('4')
    expect(progress.firstElementChild?.getAttribute('style')).toContain('scaleX(0.25)')
  })

  it('引き継ぎ要求が失敗しても理由を示し、画面を開いている間に再試行する', async () => {
    calls.followerImportState.mockImplementation(() => new Promise(() => {}))
    calls.connect.mockResolvedValue({
      success: true,
      data: { ...checked.data, id: 'retry-account', followerImport: { capability: 'available', phase: 'importing_ids' } },
    })
    calls.stepFollowerImport
      .mockResolvedValueOnce({ success: false, error: 'temporarily_unavailable' })
      .mockResolvedValueOnce({ success: true, data: { state: {
        capability: 'available', phase: 'completed', received: 4, imported: 3, alreadyPresent: 1,
        profilesProcessed: 4, profilesUpdated: 3,
      }, busy: false, profilesFetched: 3 } })
    enterCheckStep()
    fireEvent.click(screen.getByRole('checkbox', { name: 'いまの友だちの引き継ぎ' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE Developersで同じプロバイダーにあることを確かめた' }))
    await runCheck()
    await saveAndFinish()
    await screen.findByText('進み具合を確認できません', { selector: 'h2' })
    expect(screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' }).childElementCount).toBe(0)
    expect(screen.getByText('進み具合を確認できません', { selector: 'h2' }).previousElementSibling?.firstElementChild?.getAttribute('class')).toContain('handoverSpinner')
    expect(screen.getByRole('button', { name: '状態を再確認' })).toBeTruthy()
    await waitFor(() => expect(calls.stepFollowerImport).toHaveBeenCalledTimes(2), { timeout: 6500 })
    await screen.findByText('友だちの引き継ぎが完了しました', { selector: 'h2' })
    expect(screen.getByRole('progressbar', { name: '友だちの引き継ぎ進捗' }).getAttribute('aria-valuenow')).toBe('4')
  })
})
