'use client'

import {
type KeywordRuleDraft
} from '@/components/auto-replies/draft-fields';
import Button from '@/components/shared/button';
import Card,{ CardHeader } from '@/components/shared/card';
import EntitySelect,{ entityOptionMetadata } from '@/components/shared/entity-select';
import Notice from '@/components/shared/notice';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import SearchField from '@/components/shared/search-field';
import { SettingsFormRow } from '@/components/shared/settings-form-card';
import { TextField } from '@/components/shared/text-field';
import { type FriendListItem } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import type {
AutoReplyConflict,
AutoReplyDryRunResult
} from '@line-crm/shared';
import {
ArrowUp,
ArrowUpToLine,
Play
} from 'lucide-react';
import type { Dispatch,SetStateAction } from 'react';
import { REASON_WORDS,RuleRow,displayName,ruleTriggerSummary } from './wizard-model';
import styles from '../../../app/auto-replies/edit/wizard-v8.module.css';

type WizardPriorityStepContext = {
  canEdit?: boolean
  lockedReason?: string
  conflictsReadable?: boolean
  permissionPending?: boolean
  autoReplyId: string | null
  conflicts: AutoReplyConflict[]
  dryRun: AutoReplyDryRunResult | null
  effectiveKeywords: KeywordRuleDraft[]
  firstConflictAbove: RuleRow | null
  friendLoadState: "error" | "loading" | "ready"
  friendQuery: string
  friends: FriendListItem[]
  friendTotal: number
  loadPriorityData: (ruleId: string, accountId: string | null) => Promise<void>
  matchedAccountId: string | null
  moveBeforeFirstConflict: () => void
  moveUp: () => void
  myIndex: number
  myPositionLabel: string
  orderedRules: RuleRow[]
  priorityState: "error" | "idle" | "loading" | "ready"
  runTest: () => Promise<void>
  saving: boolean
  searchFriends: (query: string) => Promise<void>
  selectedFriendId: string
  setFriendQuery: Dispatch<SetStateAction<string>>
  setSelectedFriendId: Dispatch<SetStateAction<string>>
  setTestMessage: Dispatch<SetStateAction<string>>
  testMessage: string
  thisRuleName: string
}

export function WizardPriorityStep({ canEdit = true, lockedReason, conflictsReadable = true, permissionPending = false, autoReplyId, conflicts, dryRun, effectiveKeywords, firstConflictAbove, friendLoadState, friendQuery, friends, friendTotal, loadPriorityData, matchedAccountId, moveBeforeFirstConflict, moveUp, myIndex, myPositionLabel, orderedRules, priorityState, runTest, saving, searchFriends, selectedFriendId, setFriendQuery, setSelectedFriendId, setTestMessage, testMessage, thisRuleName }: WizardPriorityStepContext) {
  return (<>
              <Notice tone="info">
                上のルールから順に見て、最初に当たった1つだけが動きます。このルールより上に、同じ受信に当たるルールがあると、このルールは動きません。
                {!conflictsReadable && !permissionPending ? <p>権限のため確認結果を表示できません。設定の閲覧はできます。</p> : null}
              </Notice>

              <Card variant="form" gap="normal" className={styles.cardContent}>
                <CardHeader size="stacked" title={<>動く順番</>} meta={conflictsReadable ? <>黄色は、このルールと同じ受信に当たるルールです（過去28日の受信で確かめました）。</> : <>保存済みのルールを動く順番で表示しています。</>} />
                {priorityState === 'error' ? (
                  <p className={styles.hint}>
                    ルールの並びを読み込めませんでした。
                    <button
                      type="button"
                      className={styles.weekdayPreset}
                      onClick={() => autoReplyId && void loadPriorityData(autoReplyId, matchedAccountId)}
                    >
                      読み直す
                    </button>
                  </p>
                ) : (
                  <ol className={styles.orderList}>
                    {orderedRules.map((rule, index) => {
                      const isSelf = rule.id === autoReplyId
                      const isConflict = conflictsReadable && conflicts.some((c) => c.autoReplyId === rule.id)
                      const certain = conflictsReadable && conflicts.some((c) => c.autoReplyId === rule.id && c.certainty === 'certain')
                      const aboveSelf = myIndex >= 0 && index < myIndex
                      return (
                        <li
                          key={rule.id}
                          className={[
                            styles.orderRow,
                            isSelf ? styles.orderRowSelf : '',
                            certain && aboveSelf ? styles.orderRowConflict : '',
                          ].join(' ')}
                        >
                          <span aria-hidden="true" className={styles.orderGrip} />
                          <span className={styles.orderNum}>{index + 1}</span>
                          <div className={styles.orderBody}>
                            <p className={styles.orderName}>
                              {isSelf ? `${displayName(rule)}（このルール）` : displayName(rule)}
                            </p>
                            {/* 絵 Guoye：どの行も2行目に一言（このルール＝いまの順番・先に動く重なり＝黄・止まっている・動き方・重なりなし）。 */}
                            <p className={styles.orderSub}>
                              {isSelf ? (
                                <span>{`いまの順番：${myIndex === orderedRules.length - 1 ? 'いちばん下' : myPositionLabel}`}</span>
                              ) : rule.lifecycleStatus === 'draft' || !rule.isActive ? (
                                <span>停止中</span>
                              ) : certain && aboveSelf ? (
                                <span className={styles.orderOverlap}>同じ受信に当たる → このルールより先に動きます</span>
                              ) : isConflict ? (
                                <span>{ruleTriggerSummary(rule)}</span>
                              ) : (
                                <span>{conflictsReadable ? '重なりなし' : ruleTriggerSummary(rule)}</span>
                              )}
                            </p>
                          </div>
                          {isSelf && (
                            <span className={styles.orderMove}>
                              <Button type="button" disabled={!canEdit || myIndex <= 0} lockedReason={lockedReason} onClick={moveUp}>
                                <ArrowUp size={16} aria-hidden="true" />
                                上へ
                              </Button>
                              {conflictsReadable && firstConflictAbove && (
                                <Button type="button" disabled={!canEdit} lockedReason={lockedReason} onClick={moveBeforeFirstConflict}>
                                  <ArrowUpToLine size={16} aria-hidden="true" />
                                  {`「${displayName(firstConflictAbove)}」より前へ`}
                                </Button>
                              )}
                            </span>
                          )}
                        </li>
                      )
                    })}
                    {orderedRules.length === 0 && priorityState !== 'loading' && (
                      <li className={styles.hint}>ほかのルールはまだありません。このルールがいちばん上に動きます。</li>
                    )}
                    {priorityState === 'loading' && <li className={styles.hint}>読み込んでいます…</li>}
                  </ol>
                )}
              </Card>

              <Card variant="form" gap="normal" className={styles.cardContent}>
                <CardHeader size="stacked" title={<>試しに送ってみる</>} meta={<>本番には影響しません。友だちには届きません。</>} />
                {/* 絵 Guoye：送信者の行 → 届いたメッセージと「試す」の行。友だちを名前で探す欄は機能なので送信者の行の右に残す。 */}
                <SettingsFormRow layout="columns">
                  <SaveErrorField names={["selectedFriendId","friendId","selected_friend_id"]}><EntitySelect
                    id="wiz-test-friend"
                    size="full"
                    className={styles.testGrow}
                    aria-label="送信者"
                    value={selectedFriendId}
                    onChange={setSelectedFriendId}
                    options={
                      friendLoadState === 'error'
                        ? [{ value: '', label: '友だちを読み込めませんでした' }]
                        : friends.length === 0
                          ? [{ value: '', label: '友だちがいません' }]
                          : friends.map((f) => ({ ...entityOptionMetadata(f),
                              value: f.id,
                              label: f.id === selectedFriendId
                                ? `送信者：${f.displayName || '名前なし'}（名前で探す・候補 ${formatNumber(friendTotal)}人中 ${formatNumber(friends.length)}人）`
                                : f.displayName || '名前なし',
                            }))
                    }
                  /></SaveErrorField>
                  <SearchField
                    placeholder="名前で探す"
                    value={friendQuery}
                    onChange={(value) => {
                      setFriendQuery(value)
                      void searchFriends(value)
                    }}
                    aria-label="友だちを名前で探す"
                  />
                </SettingsFormRow>
                <div className={styles.testRow}>
                  <SaveErrorField names={["testMessage","incomingText","test_message"]}><TextField
                    id="wiz-test-message"
                    className={styles.testGrow}
                    aria-label="届いたメッセージ"
                    value={testMessage}
                    onChange={(e) => setTestMessage(e.target.value)}
                    placeholder={effectiveKeywords[0]?.keyword.trim() ? `${effectiveKeywords[0].keyword.trim()}したいです` : '例：予約変更したいです'}
                  /></SaveErrorField>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => void runTest()}
                    disabled={!canEdit || !selectedFriendId || !testMessage.trim() || saving}
                    lockedReason={lockedReason}
                    disabledReason={canEdit && !selectedFriendId ? '送信者を選んでください。' : canEdit && !testMessage.trim() ? '届いたメッセージを入力してください。' : undefined}
                    title={!selectedFriendId ? '送信者を選んでください' : canEdit && !testMessage.trim() ? '届いたメッセージを入力してください' : undefined}
                    busy={saving}
                    busyLabel="試しています…"
                  >
                    <Play size={16} aria-hidden="true" />
                    試す
                  </Button>
                </div>
                {conflictsReadable && dryRun && (
        <Notice tone={dryRun.draftWon ? "success" : "warn"} role="status" heading={<>{dryRun.draftWon
          ? `当たったルール：このルール「${thisRuleName}」`
          : dryRun.winner
            ? `当たったルール：「${dryRun.winner.name}」`
            : 'どのルールにも当たりませんでした'}</>}>
          <p className={styles.testResultNote}>
            {dryRun.draftWon
              ? 'このルールが返します。'
              : dryRun.winner
                ? `このルールは見送りです：${dryRun.winner.name}が先に動きます。動かすには、順番をそれより前にします。`
                : '届いたメッセージや相手の条件が、どのルールにも合いませんでした。'}
          </p>
          {dryRun.candidates.find((c) => c.autoReplyId === autoReplyId)?.reasonCodes.length ? (
            <p className={styles.testResultNote}>
              見送った理由：
              {[...new Set(dryRun.candidates
                .find((c) => c.autoReplyId === autoReplyId)!
                .reasonCodes.map((code) => Object.prototype.hasOwnProperty.call(REASON_WORDS, code) ? REASON_WORDS[code] : '理由を確認できませんでした'))]
                .join('・')}
            </p>
          ) : null}
        </Notice>
                )}
              </Card>
            </>)
}
