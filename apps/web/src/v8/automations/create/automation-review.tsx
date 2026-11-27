'use client'

import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { emptyValue } from '@/components/shared/empty-value'
import { Field } from '@/components/shared/form-controls'
import FriendPickerField from '@/components/shared/friend-picker-field'
import HelpTip from '@/components/shared/help-tip'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { type AutomationDraftAction } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { UserRound } from 'lucide-react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import styles from './create.module.css'
import { canonicalJson, TestConfirmation, TestRunRecord, testRunStatusLabel } from './draft-model'
import { StoredDraft } from './draft-storage'

export function AutomationReview({
  ruleSentence, previewFailed, previewCount, totalForDraft,
  savedDraft, selectedAccountId, previewRefreshing, refreshAudiencePreview,
  testFriendId, setTestFriendId, canEdit, askOnePersonTest,
  saving, testing, preparingTest, testConfirmation,
  draftActions, testTicketRef, setTestConfirmation, runOnePersonTest,
  testRun, guarded, router, refreshTestRun,
  saveOutcome, publishedRuleId, existingError, setExistingRetry,
  hasSameTrigger, usedScenarioNames, usedTagNames, usedCommonActionNames,
}: {
  ruleSentence: string
  previewFailed: boolean
  previewCount: number | null
  totalForDraft: number | null
  savedDraft: StoredDraft | null
  selectedAccountId: string | null
  previewRefreshing: boolean
  refreshAudiencePreview: (accountId: string, draft: StoredDraft) => Promise<void>
  testFriendId: string
  setTestFriendId: Dispatch<SetStateAction<string>>
  canEdit: boolean
  askOnePersonTest: () => Promise<void>
  saving: boolean
  testing: boolean
  preparingTest: boolean
  testConfirmation: TestConfirmation | null
  draftActions: () => AutomationDraftAction[]
  testTicketRef: RefObject<number>
  setTestConfirmation: Dispatch<SetStateAction<TestConfirmation | null>>
  runOnePersonTest: () => Promise<void>
  testRun: TestRunRecord | null
  guarded: (action: () => void) => void
  router: ReturnType<typeof useRouter>
  refreshTestRun: (record: TestRunRecord, accountId: string) => Promise<void>
  saveOutcome: "failed" | "published" | "idle" | "saved"
  publishedRuleId: string | null
  existingError: boolean
  setExistingRetry: Dispatch<SetStateAction<number>>
  hasSameTrigger: boolean
  usedScenarioNames: string[]
  usedTagNames: string[]
  usedCommonActionNames: string[]
}) {
  return (    <div className={styles.side} aria-label="決めごとの確認">
      <Card variant="aside" aria-label="いまの決めごとを文章にすると">
        <h2 className={styles.sideTitle}>いまの決めごとを文章にすると</h2>
        {/* この文章のとおりに動く。おかしいと感じたら、左の3つを見直す。 */}
        <p className={styles.sideBody}>{ruleSentence}</p>
      </Card>

      <Card variant="aside" aria-label="当てはまりそうな人数">
        <div className={styles.sideHead}>
          <h2 className={styles.sideTitle}>当てはまりそうな人数</h2>
          <p className={styles.sideNote}>
            {previewFailed
              ? '人数を数えられませんでした（下書きは保存済み）'
              : previewCount === null
                ? '下書きを保存すると、いまの条件で数えます'
                : '保存した条件で、いまの友だちを数えた見込み'}
          </p>
        </div>
        <dl className={styles.kvList}>
          <div className={styles.kvRow}>
            <dt>友だち全体</dt>
            <dd>{totalForDraft === null ? emptyValue('unknown') : `${formatNumber(totalForDraft)} 人`}</dd>
          </div>
          <div className={styles.kvRow}>
            <dt>人数</dt>
            <dd>{previewCount === null ? emptyValue('unknown') : `${formatNumber(previewCount)} 人`}</dd>
          </div>
        </dl>
        {previewFailed && savedDraft && selectedAccountId ? (
          <div>
            <Button
              disabled={previewRefreshing}
              onClick={() => void refreshAudiencePreview(selectedAccountId, savedDraft)}
              busy={previewRefreshing}
              busyLabel="数え直しています"
            >
              人数をもう一度数える
            </Button>
          </div>
        ) : null}
      </Card>

      <Card variant="aside" aria-label="1人で試す">
        <div className={styles.sideHead}>
          <div className={styles.sideTitleRow}>
            <h2 className={styles.sideTitle}>1人で試す</h2>
            <HelpTip label="1人で試すの説明">保存した時点の内容で試します。変えた後は保存し直してから試してください。</HelpTip>
          </div>
          <p className={styles.sideNote}>選んだ友だち1人だけに動かします</p>
        </div>
        <Field label="友だち" htmlFor="v8-test-friend"><SaveErrorField names={["testFriendId","test_friend_id"]}><FriendPickerField
            label="試す友だち" accountId={selectedAccountId ?? null}
            value={testFriendId}
            onChange={setTestFriendId} id="v8-test-friend"
          /></SaveErrorField></Field>
        {canEdit ? (
          <div>
            <Button
              onClick={() => void askOnePersonTest()}
              disabled={saving || testing || preparingTest || !savedDraft || !testFriendId.trim() || !!savedDraft.followupManagement}
              disabledReason={savedDraft?.followupManagement ? '来店フォローの画面で、登録済みのテスト宛先へ試してください' : !savedDraft ? '下書きを保存すると試せます。' : !testFriendId.trim() ? '試す友だちを選んでください。' : undefined}
              title={!savedDraft ? '下書きを保存すると試せます' : !testFriendId.trim() ? '試す友だちを入れてください' : undefined}
              busy={preparingTest}
              busyLabel="確認中…"
            >
              <UserRound size={16} aria-hidden="true" />1人で試す
            </Button>
          </div>
        ) : null}
        {testConfirmation ? (
          <div className={styles.subBox} role="dialog" aria-label="1人テストの確認">
            <p className={styles.subTitle}>送る前に確認してください</p>
            <p className={styles.sideNote}>送り先：{testConfirmation.friendId}</p>
            <div className={styles.sideNote}>
              <p>送る内容：</p>
              <ul className={styles.noteList}>
                {testConfirmation.contents.map((content, index) => <li key={`${index}-${content}`}>{content}</li>)}
              </ul>
            </div>
            <p className={styles.sideNote}>起きること：{testConfirmation.effects.join('、')}。取り消せません。</p>
            {canonicalJson(draftActions()) !== testConfirmation.actionsFingerprint ? (
              <p className={styles.sideNote}>画面の入力は、ここに出ている内容と違います。送られるのは、保存済みのこの内容です。</p>
            ) : null}
            <div className={styles.buttonRow}>
              <Button
                onClick={() => {
                  testTicketRef.current += 1
                  setTestConfirmation(null)
                }}
              >
                キャンセル
              </Button>
              <Button variant="primary" disabled={testing} onClick={() => void runOnePersonTest()} busy={testing} busyLabel="送信中…">
                この内容で送る
              </Button>
            </div>
          </div>
        ) : null}
        {testRun ? (
          <div className={styles.subBox} aria-label="1人テストの実行">
            <p className={styles.subTitle}>試した実行：{testRunStatusLabel(testRun.status)}</p>
            <div className={styles.buttonRow}>
              <Button onClick={() => guarded(() => router.push(`/automations/runs?run=${encodeURIComponent(testRun.runId)}`))}>実行の結果を見る</Button>
              <Button disabled={testing} onClick={() => void refreshTestRun(testRun, testRun.accountId)}>結果を読み直す</Button>
            </div>
          </div>
        ) : null}
        {saveOutcome === 'published' && publishedRuleId ? (
          <div className={styles.subBox} aria-label="公開済みの案内">
            <p className={styles.subTitle}>この内容はすでに公開済みです</p>
            <div className={styles.buttonRow}>
              <Button onClick={() => guarded(() => router.push(`/automations?highlight=${publishedRuleId}`))}>公開したルールを見る</Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card variant="aside" aria-label="気をつけること">
        <h2 className={styles.sideTitle}>気をつけること</h2>
        {existingError?<ListState kind="error" title="既存のルールを読み込めませんでした" onRetry={()=>setExistingRetry(value=>value+1)}/>:null}
        <ul className={styles.cautionList}>
          {/* 同じきっかけのルールがほかにあるときは、1行目をその知らせに替える（一覧で確かめられる）。 */}
          <li>{hasSameTrigger ? '・同じきっかけのルールが他にもあり、両方動きます' : '・同じきっかけのルールが2つあると、両方動きます'}</li>
          <li>・止めると、そのあとのきっかけでは動きません</li>
          <li>・友だちになったとき は、ブロック解除では動きません</li>
        </ul>
      </Card>

      <Card variant="aside" aria-label="つながる先">
        <h2 className={styles.sideTitle}>つながる先</h2>
        <dl className={styles.kvList}>
          <div className={styles.kvRow}>
            <dt>シナリオ</dt>
            <dd className={styles.kvLight}>{usedScenarioNames.length > 0 ? usedScenarioNames.join('、') : emptyValue('none')}</dd>
          </div>
          <div className={styles.kvRow}>
            <dt>タグ</dt>
            <dd className={styles.kvLight}>{usedTagNames.length > 0 ? usedTagNames.join('、') : emptyValue('none')}</dd>
          </div>
          <div className={styles.kvRow}>
            <dt>共通アクション</dt>
            <dd className={styles.kvLight}>{usedCommonActionNames.length > 0 ? usedCommonActionNames.join('、') : emptyValue('none')}</dd>
          </div>
        </dl>
      </Card>
    </div>
)
}
