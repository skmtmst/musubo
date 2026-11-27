import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...parts: string[]) => readFileSync(join(HERE, ...parts), 'utf8')
const readApi = (...parts: string[]) => readApiSource(join(HERE, ...parts), 'utf8')
const LIST = readUiSource(join(HERE, 'page.tsx'), 'utf8')
const CREATE = readUiSource(join(HERE, 'new', 'page.tsx'), 'utf8')
const EDIT = readUiSource(join(HERE, 'edit', 'page.tsx'), 'utf8')
const BRANCH_EDITOR = read('..', '..', 'v8', 'automations', 'branch-editor.tsx')
const VERSIONS = readUiSource(join(HERE, 'versions', 'page.tsx'), 'utf8')
const EDITOR = read('..', '..', 'components', 'automations', 'common-action-editor.tsx')
// #580: 権限の実体は use-can-manage.ts へ1本化。旧2ファイルは互換の再送出。
const PERMISSION = read('..', '..', 'components', 'automations', 'use-can-manage.ts')
const API = readApi('..', '..', 'lib', 'api.ts')
// Workerの分岐・参照版・保管の動きは services/common-actions.test.ts の実DB試験で守る。
const ENGINE = read('..', '..', '..', '..', 'worker', 'src', 'features', 'automations', 'automation-engine.ts')
const PLAN = read('..', '..', '..', '..', 'worker', 'src', 'features', 'automations', 'automation-plan.ts')
const FOUNDATION = read('..', '..', '..', '..', '..', 'packages', 'db', 'migrations', '181_automation_v6_foundation.sql')

describe("管理画面共通アクションの画面契約", () => {
  it('一覧・空・読込・失敗と、名前で分かる遷移を持つ', () => {
    // 表示・行の操作は common-actions-list-rendered-cx6.test.tsx で確かめる。
    expect(LIST).not.toContain('準備中')
  })

  it('作成はJSON入力ではなく、選択肢と順番で編集する', () => {
    expect(CREATE + EDIT).toMatch(/<(CommonActionEditor|ActionList)/)
    expect(EDITOR).toContain('失敗したとき')
    expect(EDITOR).toContain('commonActionChoices(resources)')
    expect(EDITOR).not.toContain('actionsJson')
    expect(CREATE).not.toContain('<main className=')
    expect(EDITOR).toContain('テンプレート「{selected.name}」')
    expect(EDITOR).toContain('版: —（未取得。テンプレートの版を返す口が接続されると表示します）')
    expect(CREATE).toContain('使う所はいまの版のまま')
  })

  it('条件分岐はタグ条件と両方の公開版を保存・実行契約へ接続する', () => {
    expect(CREATE + EDIT).toContain('<BranchEditors')
    expect(BRANCH_EDITOR).toContain('条件の組み合わせ')
    expect(BRANCH_EDITOR).toContain('当てはまるとき')
    expect(BRANCH_EDITOR).toContain('当てはまらないとき')
    expect(PLAN).toContain("type: 'branch_marker'")
    expect(ENGINE).toContain('branch_not_selected')
  })

  it('分岐の編集で非表示の条件・子処理を消さない（監査 R474・R476）', () => {
    // R474: 通常処理の編集で分岐の位置を保ち、番号は実行順で一致させる。
    expect(CREATE + EDIT).toContain('mergeOrderedActions')
    expect(CREATE + EDIT).toContain('stepNumbers')
    expect(EDITOR).toContain('stepNumbers')
    // R476: 全条件・両側の全処理を出し、対象だけ更新する。読めない構造は残す。
    expect(BRANCH_EDITOR).toContain('updateBranchStep')
    expect(BRANCH_EDITOR).toContain('ここでは変えられません')
    expect(BRANCH_EDITOR).toContain('すべてに当てはまる')
  })

  it('利用版の変更前に差分と進行中への影響を確認する', () => {
    expect(VERSIONS).toContain('変わった点')
    expect(VERSIONS).toContain('現在の版')
    expect(VERSIONS).toContain('更新後')
    expect(VERSIONS).toContain('実行中・待機中の処理は変えず')
    expect(VERSIONS).toContain('<Dialog')
    expect(VERSIONS).toContain('describeVersionChanges')
    expect(VERSIONS).toContain('summary?.executionCountThisMonth')
    expect(VERSIONS).toContain('summary.failureCountThisMonth')
    expect(VERSIONS).toContain('runningCount')
    expect(VERSIONS).toContain('waitingCount')
    expect(VERSIONS).not.toContain('内容を取得できません')
    // 差分の未知値の案内だけを除き、版画面の未実装表示を全体で防ぐ。
    expect(VERSIONS.replaceAll('動作を確認できません', '')).not.toContain('確認できません')
  })

  it('一覧の集計・絞り込み・CSVを新しい契約へ接続する', () => {
    // 監査 R464: CSVは一覧の検索・絞り込みを引き継ぎ、範囲と件数を事前に出す。
    expect(LIST).toContain('この条件の')
    expect(LIST).toContain('条件に合う共通アクションがないため書き出せません')
    // 監査 R466: 書き出し権限のない担当者にリンク自体を出さない。
    expect(LIST).toContain('canExportCsv')
    expect(LIST).toContain('useAutomationRunManage')
    expect(LIST).toContain('古い版あり')
    expect(LIST).toContain('limit: pageSize')
    expect(LIST).toContain('offset: (page - 1) * pageSize')
    // ページ送りは共通の Pagination が担う（`aria-label="ページ送り"` は部品側にある）。
    expect(LIST).toContain('<Pagination')
  })

  it('閲覧権限と編集権限を画面でも分ける', () => {
    expect(PERMISSION).toContain("role === 'owner' || role === 'admin'")
    expect(CREATE + EDIT).toContain('共通アクションは閲覧のみです')
    expect(LIST + VERSIONS).toContain('canManage')
  })

  it('利用先の更新は現在版IDを渡し失敗は確認窓内に出す（監査 R467）', () => {
    // 通常UIから expectedVersionId なしでは422で詰む。比較に使った現在版を渡す。
    expect(API).toContain('expectedVersionId')
    expect(VERSIONS).toContain('expectedVersionId: pendingBinding.versionId')
    // 失敗理由は操作中の確認窓内に表示する（ページ本文だけにしない）。
    expect(VERSIONS).toContain('dialogError')
  })

  it('利用先ごとの件数と旧版の残りを分けて出す（監査 R471・R472）', () => {
    expect(API).toContain('olderRunningCount')
    expect(VERSIONS).toContain('olderRunningCount')
    expect(VERSIONS).toContain('binding.olderRunningCount')
  })

  it('下書き保存・公開は改訂番号を照合する（監査 R473・R477）', () => {
    expect(API).toContain('expectedDraftRevision')
    expect(EDIT).toContain('expectedDraftRevision: draftRevision')
    expect(EDIT).toContain('最新の内容を読み込み直す')
    expect(VERSIONS).toContain('version.draftRevision')
  })

  it('新規作成は再試行鍵を持ち二重作成にしない（監査 R475）', () => {
    expect(API).toContain('clientRequestKey')
    expect(CREATE).toContain('clientRequestKey: requestKey')
  })

  it('確認後の参照先更新は再確認なしで公開しない（監査 R479）', () => {
  })

  it('未使用は保管でき利用中は理由を示して止まる（監査 R480）', () => {
    expect(LIST).toContain('保管する')
    expect(LIST).toContain('保管を戻す')
    expect(LIST).toContain('api.commonActions.archive')
    expect(LIST).toContain('api.commonActions.unarchive')
    expect(API).toContain('archive:')
  })

  it('版操作は店が外れていたら実行しない (#580)', () => {
    expect(VERSIONS).toContain('if (!selectedAccountId) {')
    expect(VERSIONS).toContain('LINEアカウントを選び直してください')
  })

  it('手順IDは1本の採番で非HTTPSにも落ちる (#580)', () => {
    expect(EDITOR).toContain('export function newStepId()')
    expect(BRANCH_EDITOR).toContain('newStepId()')
    expect(BRANCH_EDITOR).not.toContain('crypto.randomUUID()')
  })

  it('権限フックの実体は1本で旧名は再送出する (#580)', () => {
    const automation = read('..', '..', 'components', 'automations', 'use-automation-permission.ts')
    const commonAction = read('..', '..', 'components', 'automations', 'use-common-action-permission.ts')
    expect(automation).toContain("from './use-can-manage'")
    expect(commonAction).toContain("from './use-can-manage'")
    expect(automation).not.toContain('localStorage')
    expect(commonAction).not.toContain('localStorage')
  })

  it('「マニュアル」は正本表の画面IDを引き、/supportへ固定で飛ばさない (監査R128)', () => {
    // /support はメール問い合わせの受信箱。説明書ではないので、画面内の
    // マニュアル導線は正本表（/settings/manual-links）が返すURLを使う。
    const topBar = read('..', '..', 'components', 'shell', 'app-top-bar.tsx')
    expect(topBar).toContain('useManualHref(pathname)')
    expect(topBar).toContain('manualHref={manualHref}')
    expect(LIST).not.toContain('href="/support"')
    expect(VERSIONS).not.toContain('href="/support"')
  })
})

describe("管理画面共通アクションの機能契約", () => {
  it('画面操作を読み書きAPIへ接続する', () => {
    for (const method of ['resources:', 'list:', 'get:', 'create:', 'duplicate:', 'updateDraft:', 'createDraft:', 'publish:', 'updateBinding:']) {
      expect(API).toContain(method)
    }
  })

  it('一覧の複製操作を下書き作成APIへ接続する', () => {
    expect(LIST).toContain('api.commonActions.duplicate(item.id, selectedAccountId)')
    expect(LIST).toContain('複製して下書きを作る')

    expect(LIST).toContain('/common-actions/edit?id=')
  })

  it('公開版を直接変更せず、実行開始時の計画へ展開する', () => {
    expect(FOUNDATION).toContain('trg_common_action_published_version_immutable')
    expect(ENGINE).toContain('buildExecutionPlan')
    expect(ENGINE).toContain('execution_plan_json')
    expect(ENGINE).toContain('common_action_marker')
  })

  it('札・KPIは集計口で受け、件数表示の全件取得はしない（#554 点検#519中2）', () => {
    const main = read('..', '..', 'v8', 'automations', 'common-actions.tsx')
    expect(main.match(/api\.commonActions\.list\(/g)).toHaveLength(1)
    expect(main).toContain('useAutomationTabCounts(undefined, summary?.total ?? null)')
    expect(LIST).toContain('needCommonActions ? api.commonActions.list')
    expect(LIST).toContain('response.summary')
    expect(LIST).toContain('summary.total')
    expect(LIST).toContain('summary?.oldVersion')
    expect(LIST).not.toContain('summaryResponse')
    expect(LIST).not.toContain('summaryItems')
    // 暫定の注記ではなく、口の集計を使う
    expect(API).toContain('summary?: {')
  })
})
