'use client'

import {
matchTypeWord
} from '@/v8/auto-replies/auto-reply-words';
import {
type KeywordRuleDraft
} from '@/components/auto-replies/draft-fields';
import { useActionOptions } from '@/components/auto-replies/inline-action-list';
import { actionRowTitle } from '@/components/auto-replies/inline-action-rows-v8';
import Button from '@/components/shared/button';
import Notice from '@/components/shared/notice';
import Card,{ CardHeader } from '@/components/shared/card';
import { emptyValue } from '@/components/shared/empty-value';
import { formatNumber } from '@/lib/format';
import {
Check,
CircleAlert
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SummaryRow,WizardForm,WizardStep,weekdaySummary } from './wizard-model';
import styles from '../../../app/auto-replies/edit/wizard-v8.module.css';

type WizardConfirmStepContext = {
  conflictsReadable?: boolean
  permissionPending?: boolean
  actionOptions: ReturnType<typeof useActionOptions>
  autoReplyId: string | null
  confirmState: "error" | "idle" | "loading" | "ready"
  effectiveKeywords: KeywordRuleDraft[]
  folders: { id: string; name: string; color?: string | null; }[]
  form: WizardForm
  goToStep: (next: WizardStep, ruleId?: string) => void
  loadValidation: (ruleId: string) => Promise<void>
  myPositionLabel: string
  selectedTemplate: { id: string; name: string; messageType: string; messageContent: string; folderId?: string | null; updatedAt?: string; } | null
  thisRuleName: string
  v8Checks: { label: string; state: string; detail: string; back: WizardStep; }[]
}

export function WizardConfirmStep({ conflictsReadable = true, permissionPending = false, actionOptions, autoReplyId, confirmState, effectiveKeywords, folders, form, goToStep, loadValidation, myPositionLabel, selectedTemplate, thisRuleName, v8Checks }: WizardConfirmStepContext) {
  const retryRunningRef = useRef(false)
  const mountedRef = useRef(true)
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const safeKeywords = Array.isArray(effectiveKeywords) ? effectiveKeywords : []
  const safeFolders = Array.isArray(folders) ? folders : []
  const safeActions = Array.isArray(form.actions) ? form.actions : []
  const safeChecks = Array.isArray(v8Checks) ? v8Checks : []
  const safeResponseContent = typeof form.responseContent === 'string' ? form.responseContent : ''
  const parsedDelay = Number(form.replyDelaySeconds)
  const delaySummary = Number.isFinite(parsedDelay) && parsedDelay > 0 ? `${formatNumber(parsedDelay)}秒待つ` : 'すぐ返す'
  const parsedCooldown = Number(form.cooldownMinutes)
  const cooldownSummary = form.cooldownOn
    ? (Number.isFinite(parsedCooldown) && parsedCooldown > 0
      ? `同じ人へは${formatNumber(parsedCooldown)}分あける`
      : '同じ人へは間をあける（時間未設定）')
    : null
  const handleRetryValidation = () => {
    if (!autoReplyId || retryRunningRef.current) return
    retryRunningRef.current = true
    setRetrying(true)
    Promise.resolve(loadValidation(autoReplyId))
      .catch(() => {})
      .finally(() => {
        retryRunningRef.current = false
        if (mountedRef.current) setRetrying(false)
      })
  }
  return (<>
              <Card variant="form" gap="normal" className={styles.cardContent}>
                <CardHeader size="stacked" title={<>設定の確認</>} />
                <div className={styles.summaryList}>
                  <SummaryRow label="名前・フォルダ" onEdit={() => goToStep('basic')}>
                    {thisRuleName}
                    {form.folderId
                      ? `・${safeFolders.find((f) => f.id === form.folderId)?.name ?? '未分類'}`
                      : '・未分類'}
                  </SummaryRow>
                  <SummaryRow label="反応する言葉" onEdit={() => goToStep('trigger')}>
                    {form.respondToAll
                      ? 'すべてのメッセージ'
                      : safeKeywords.length > 0
                        ? `${safeKeywords.map((r) => `「${r.keyword.trim()}」`).join('')}（${matchTypeWord(form.matchType)}）`
                        : emptyValue('unconfigured')}
                  </SummaryRow>
                  <SummaryRow label="いつ" onEdit={() => goToStep('trigger')}>
                    {[
                      // 絵 「月〜金・いつでも」：手順②の「まとめて」と同じ言い方
                      weekdaySummary(form.weekdays).replace(/に反応$/, ''),
                      form.timeMode === 'custom' && (form.activeFrom || form.activeUntil)
                        ? `${form.activeFrom || '00:00'}〜${form.activeUntil || '24:00'}`
                        : 'いつでも',
                    ].join('・')}
                  </SummaryRow>
                  <SummaryRow label="誰に" onEdit={() => goToStep('trigger')}>
                    {form.friendTarget === 'filtered' ? '条件に合う友だち' : 'すべての友だち'}
                  </SummaryRow>
                  <SummaryRow label="返すもの" onEdit={() => goToStep('response')}>
                    {form.mode === 'silent'
                      ? '返信しない（後の処理だけ）'
                      : form.mode === 'template'
                        ? selectedTemplate
                          ? `テンプレート「${selectedTemplate.name}」`
                          : 'テンプレート（未選択）'
                        : form.mode === 'inline-flex'
                          ? 'カード'
                          : form.mode === 'inline-image'
                            ? '画像'
                            : `テキスト ${formatNumber(safeResponseContent.length)}字`}
                  </SummaryRow>
                  <SummaryRow label="返したあと" onEdit={() => goToStep('response')}>
                    {safeActions.length > 0
                      ? safeActions.map((a, i) => `${i + 1} ${actionRowTitle(a, actionOptions)}`).join(' → ')
                      : emptyValue('none')}
                  </SummaryRow>
                  <SummaryRow label="細かい決まり" onEdit={() => goToStep('response')}>
                    {[
                      delaySummary,
                      cooldownSummary,
                      form.skipWhenOperatorActive ? '対応中のトークには返さない' : null,
                      form.oncePerFriend ? '1人1回' : null,
                      form.unmatchedMode === 'notify_operator' ? '外れたら担当者へ' : null,
                    ]
                      .filter(Boolean)
                      .join('・')}
                  </SummaryRow>
                  <SummaryRow label="動く順番" onEdit={() => goToStep('priority')}>
                    {myPositionLabel}
                  </SummaryRow>
                </div>
              </Card>

              <Card variant="form" gap="normal" className={styles.cardContent}>
                <CardHeader size="stacked" title={<>有効にする前の確認</>} />
                {!conflictsReadable ? permissionPending ? <p className={styles.hint}>本人を確認しています…</p> : <Notice tone="info">権限のため確認結果を表示できません。設定の閲覧はできます。</Notice> : null}
                {conflictsReadable && confirmState === 'loading' && <p className={styles.hint}>確かめています…</p>}
                {conflictsReadable && confirmState === 'error' && (
                  <p className={styles.hint}>
                    確認を読み込めませんでした。
                    <button
                      type="button"
                      className={styles.weekdayPreset}
                      disabled={!autoReplyId || retrying}
                      onClick={handleRetryValidation}
                    >
                      読み直す
                    </button>
                  </p>
                )}
                {conflictsReadable && confirmState === 'ready' &&
                  safeChecks.map((gate, index) => {
                    const backTo = gate.back
                    return (
                      <div key={`${gate.label}-${index}`} className={styles.checkRow}>
                        <span
                          className={`${styles.checkIcon} ${gate.state === 'ok' ? styles.checkIconOk : gate.state === 'blocked' ? styles.checkIconWarn : ''}`}
                          aria-hidden="true"
                        >
                          {gate.state === 'ok' ? <Check size={16} /> : gate.state === 'blocked' ? <CircleAlert size={16} /> : emptyValue('unknown')}
                        </span>
                        <div className={styles.checkBody}>
                          <p className={styles.checkTitle}>{gate.label}</p>
                          <p className={styles.checkNote}>{gate.detail}</p>
                        </div>
                        <Button type="button" variant="text" onClick={() => goToStep(backTo)}>
                          見直す
                        </Button>
                      </div>
                    )
                  })}
              </Card>
            </>)
}
