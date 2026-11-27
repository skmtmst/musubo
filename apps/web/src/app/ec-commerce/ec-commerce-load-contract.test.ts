/*
 * `/ec-commerce`（設計 `eI3gs`）が、一覧を読めなかったときに
 * **本文ごと消えない**ことの契約。
 *
 * 起きたこと（2026-09-02）: `api.ecCommerce.events` の返事が配列でないと、
 * `success` が真のまま非配列が state に入り、描画の途中で
 * `events.map is not a function` を投げていた。エラー境界が本文を丸ごと
 * 「画面を表示できませんでした」に差し替えるので、**撮ると空の絵になる。**
 * 上の口ひとつが読めないだけで、KPI もイベント履歴も設定も全部消える。
 *
 * 形を確かめてから state に入れ、読めなければ理由を帯に出す、を見張る。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../v8/settings/ec-commerce/screen.tsx'), 'utf8')

// 部分失敗・再読込・アカウント切替は ec-commerce-events-panel-mount.test.tsx で描画して確かめる。
describe("管理画面 23-1 EC連携の読み込み", () => {
  it('取込一覧の形を確かめてからstateへ入れる', () => {
    const guard = source.indexOf('Array.isArray(response.data?.items)')
    const assign = source.indexOf('items: response.data.items')
    expect(guard).toBeGreaterThan(-1)
    expect(assign).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(assign)
  })

})

/*
 * 起きたこと(2026-09-09, #685): アカウントAで集計111件を出したあとBへ切り替え、
 * Bの集計が500/403で落ちると、Aの111件がBの数字として残っていた。
 * 取得した値を取得元アカウントと一体で持ち、描く前に突き合わせる、を見張る。
 */
describe("管理画面 23-1 EC連携のアカウント切替", () => {
  it('失敗時に前の値を残すのは同じアカウントの取り直しだけに限る', () => {
    const keeps = source.match(/data: prev\.accountId === accountId \? prev\.data : (null|EMPTY_RECORDS)/g) ?? []
    expect(keeps.length).toBe(4)
    expect(source).not.toContain('data: prev.data,')
  })

  it('ページとお知らせもアカウントと一体で持ち、切替で持ち越さない', () => {
    expect(source).toContain('const page = pageSlot.accountId === accountId ? urlPage : 1')
    expect(source).toContain('const notice = noticeSlot.accountId === accountId ? noticeSlot.notice : null')
  })
})

/*
 * 起きたこと(2026-09-09, #685再差し戻し): アカウントAで再試行を始め、応答が
 * 返る前にBへ切り替えると、retryが抱えたA向けのloadRecords(false)が
 * 共有listLoadSeqを進め、Bの正常な一覧応答をseq不一致で捨てていた。
 * Bは読み込み中のまま固まる。retryingIdもアカウントに結び付いていなかった。
 * accountIdRefで最新アカウントと突き合わせ、古いクロージャの呼び出しを
 * 共有seqに触れる前に止める、を見張る。
 *
 * 司令塔独立審査(Opus, 2026-09-09)の指摘: このdescribe配下の文字列一致は
 * 逆変異(M3〜M7)を当てても表明された文字列が残ったまま挙動だけ壊れ、検知
 * できなかった。実際の挙動(M3〜M7がいずれも赤になること)は
 * `ec-commerce-events-panel-mount.test.tsx` の実React mount試験へ移した。
 * ここは実装の存在確認にとどめ、書式そのものを固定する表明は置かない。
 */
describe("管理画面 23-1 EC連携の再試行とアカウント切替の順序", () => {
  it('最新アカウントをrefで持ち、描画本体で直接更新する', () => {
    expect(source).toContain('const currentAccountIdRef = useRef(accountId)')
    expect(source).toContain('currentAccountIdRef.current = accountId')
  })

  it('retryingIdはアカウントと一体で持つ', () => {
    expect(source).toContain("useState<{ accountId: string | null; id: string | null }>({ accountId, id: null })")
    expect(source).toContain('const retryingId = retryingSlot.accountId === accountId ? retryingSlot.id : null')
  })

  it('setNoticeとloadOverview/loadRecordsは、それぞれ呼び出し先でaccountId不一致を検知して戻る', () => {
    expect(source).toContain('const setNotice = useCallback')
    /* フェンスは呼び出し先1箇所に一本化していて、retry自身は持たない。 */
    const retryIdx = source.indexOf('const retry = async (action: EcActionExecution)')
    const retryOwnGuards = source.slice(retryIdx).match(/if \(retryAccountId !== currentAccountIdRef\.current\) return/g) ?? []
    expect(retryOwnGuards.length).toBe(0)
  })

  it('retryingSlotの後始末は、同じ再試行のぶんだけを消す', () => {
    expect(source).toContain(
      'setRetryingSlot((prev) => (prev.accountId === retryAccountId && prev.id === action.id ? { accountId: retryAccountId, id: null } : prev))',
    )
  })

  it('読み上げ: 知らせの失敗は alert・成功は status で出す', () => {
    expect(source).toContain("role={notice.tone === 'success' ? 'status' : 'alert'}")
  })
})
