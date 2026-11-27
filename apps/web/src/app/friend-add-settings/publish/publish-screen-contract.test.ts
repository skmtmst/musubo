// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DONE = readFileSync(join(__dirname, '../../../v8/friend-add-publish/done.tsx'), 'utf8')
const LIST = readFileSync(join(__dirname, '../../../v8/friend-add/list.tsx'), 'utf8')
const PAGE = readFileSync(join(__dirname, '../../../v8/friend-add-publish/publish.tsx'), 'utf8')

/** 友だち追加時配信の公開（設計 `ec9vg` 5-F ／ `quhg6` 5-G）。 */
describe('友だち追加時配信の公開画面', () => {
  it('公開に版ごとの鍵を付ける', () => {
    // 二重に押しても2回公開されないよう、同じ下書きには同じ鍵を使う。
    expect(PAGE).toContain('idempotencyKeyFor({ accountId: at.accountId, versionId: rule.versionId ?? rule.id })')
  })

  it('押せないときに理由を出す', () => {
    expect(PAGE).toContain('blockedReason(validation)')
    expect(PAGE).toContain('disabled={!ready}')
  })

  it('過去28日の実績を未来の対象人数として表示しない', () => {
    // 公開後の返事を先取りしたり、設計の数字を置いたりしない。
    // 過去28日の実績を未来の対象人数として見せない。
    expect(PAGE).not.toContain('audienceText(')
    expect(PAGE).not.toContain('validation.estimatedAudienceCount')
  })

  it('確認は鍵で突き合わせ、説明文はサーバ値をそのまま出す', () => {
    // 順番 (配列の位置) で割り振ると、行が欠ける・意味がずれる。
    expect(PAGE).not.toContain('keys[index]')
    expect(PAGE).toContain('check.detail || check.label')
  })

  it('公開後に実行結果へ進め、通知の接続状態を区別する', () => {
    expect(PAGE).toContain('slackConnected: slackOf(detail)')
  })

  it('画面を開くだけで試験を走らせない', () => {
    /*
     * dry-runの返事は `stateChanged: false` だが、**Worker側は
     * `last_test_status` と `last_tested_at` をDBへ記録する**。
     * 読み込みで呼ぶと、意図して試験していない下書きでも公開条件
     * （試験が成功していること）を満たしてしまう。
     * 固定の友だちIDを当てるのも同じ理由で危ない。
     */
    expect(PAGE).not.toContain('friend-kyohei')
    // 最後の試験は、下書きが持っている記録から読む。
  })

  it('アカウントを変えたら前の結果を捨てる', () => {
    /*
     * 消さないと、切替先の取得に失敗したときに前のアカウントの
     * 下書き・確認・公開の結果が残り、別のアカウントの数を見ながら
     * 公開することになる。
     */
    for (const reset of ['setDetail(null)', 'setValidation(null)', 'setPublished(null)', "setError('')"]) {
      expect(PAGE).toContain(reset)
    }
  })

  it('運用者向けの画面に内部の仕組みの名前を出さない', () => {
    expect(PAGE).not.toContain('value="webhookの記録で防ぎます"')
    expect(PAGE).not.toContain('value="有効（webhookの記録で判定）"')
  })

  it('有効化後は実行結果へ進み、停止・編集は一覧で行える', () => {
    expect(DONE).toContain('実行結果を見る')
    expect(DONE).toContain('一覧へ戻る')
    expect(DONE).toContain('一覧の「…」から止められます')
    for (const label of ['止める', '編集する']) expect(LIST).toContain(label)
    expect(LIST).toContain('api.friendAddRules.stop(')
    for (const label of ['未送信', '二重送信', 'シナリオ開始失敗']) expect(PAGE).toContain(label)
  })

  // 複製の実API・元の不変・別経路・所属外・閲覧のみは duplicate-api.test.ts で実SQLiteへ確認する。

  it('公開中にアカウントを変えられたら、返事を映さない', () => {
    /*
     * 公開はWorker側で進むが、その結果を**別のアカウントを見ている画面へ
     * 出すと、切替先で公開したように読める**。押した時点のアカウントと
     * 読み込み回数を控え、戻ってきたときに一致するかを見る。
     */
    expect(PAGE).toContain('const stillHere = ()')
    expect(PAGE).toContain('if (!stillHere()) return')
    expect(PAGE).toContain('if (stillHere()) setBusy(false)')
  })

  it('同じアカウントで読み直したときも取り違えない', () => {
    /*
     * アカウントIDだけでは、同じアカウントで読み直したときの
     * 取り違えを止められない。読み込み回数も一緒に見る。
     */
    expect(PAGE).toContain('generation')
    expect(PAGE).toContain('requestRef.current.generation === generation')
  })
})
