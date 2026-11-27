'use client'

import ActionList from '@/components/shared/action-list';
import Button from '@/components/shared/button';
import Card,{ CardHeader } from '@/components/shared/card';
import Dialog from '@/components/shared/dialog';
import { emptyValue } from '@/components/shared/empty-value';
import { EntityKindField } from '@/components/shared/entity-picker-sources';
import { Field } from '@/components/shared/form-controls';
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason';
import Notice from '@/components/shared/notice';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import { api,type FriendAddRuleAction,type FriendAddRuleDefinition,type FriendAddRuleOptions } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { CircleAlert,CircleCheck } from 'lucide-react';
import type { Dispatch,SetStateAction } from 'react';
import { useEffect,useState } from 'react';
import { EditorRule,Step } from './editor-model';
import styles from './editor.module.css';
import { MESSAGE_TYPE_LABEL,friendAddFlowSteps,friendAddReaddLines } from './flow';
import { resendSuppressionText } from './text';

/* ===== 作る④ あわせて行うこと（板 ） ===== */
export const ACTION_KINDS: Array<{ type: FriendAddRuleAction['type']; label: string; source: 'tag' | 'scenario' }> = [
  { type: 'add_tag', label: 'タグを付ける', source: 'tag' },
  { type: 'remove_tag', label: 'タグを外す', source: 'tag' },
  { type: 'start_scenario', label: 'シナリオを始める', source: 'scenario' },
]

export function ActionsStep({ definition, setDefinition, options, canEdit }: {
  definition: FriendAddRuleDefinition
  setDefinition: Dispatch<SetStateAction<FriendAddRuleDefinition>>
  options: FriendAddRuleOptions
  canEdit: boolean
}) {
  const setActions = (actions:FriendAddRuleAction[]) =>
    setDefinition(current => ({ ...current, actions }))
  const title =(kind: FriendAddRuleAction['type'], id: string) => {
    const list = kind === 'start_scenario' ? options.scenarios : options.tags
    const name = list.find(item => item.id === id)?.name ?? '未設定'
    return kind === 'start_scenario' ? `シナリオ「${name}」を始める` : `タグ「${name}」を${kind === 'remove_tag' ? '外す' : '付ける'}`
  }
  return <Card variant="form" gap="normal" className={styles.card} aria-label="あわせて行うこと">
      <CardHeader size="stacked" title={<>あわせて行うこと</>} meta={<>案内を送ったあと、上から順に行います</>} />
    <ActionList<FriendAddRuleAction> value=
      {definition.actions} onChange={setActions} readOnly={!canEdit} idOf=
          {(_, index) => String (index)} titleOf={action=>action.label}
      choices={ACTION_KINDS.map(kind=> ({ id: kind.type, label: kind.label, make:() =>({ type: kind.type, label: '', targetId: '' }),
        picker: { title: `${kind.source === 'tag' ? 'タグ' : 'シナリオ'}を選ぶ`, items: kind.source === 'tag' ? options.tags : options.scenarios,
          apply:(action, ids) => ({ ...action, targetId: ids[0], label: title(action.type, ids[0]) }) } }))}
      renderEditor={(action, update) =>
            <SaveErrorField names={["target"]}><EntityKindField kind={action.type === 'start_scenario' ? 'scenario' : 'tag'} label="操作の対象" options={action.type === 'start_scenario' ? options.scenarios : options.tags} value={action.targetId} onChange={targetId => update({ ...action, targetId, label: title(action.type, targetId) })} /></SaveErrorField>} />
          </Card>
}

/* ===== 作る⑤ 確認（板 ） ===== */
export function PreviewStep({ rule, definition, routeNames, runTest, onTestConditions, testing, testOk, overlapNotes, slackConnected, canEdit, hrefFor, accountId, ruleId, scenarios }: {
  rule: EditorRule
  definition: FriendAddRuleDefinition
  routeNames: string[]
  runTest: () => void
  onTestConditions: () => void
  testing: boolean
  testOk: boolean
  overlapNotes: string[]
  slackConnected: boolean | null
  canEdit: boolean
  hrefFor: (next: Step, extra?: string) => string
  accountId: string
  ruleId?: string
  scenarios: FriendAddRuleOptions['scenarios']
}) {
  const editLockReason = usePermissionLockReason(canEdit)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [matchedLast28Days, setMatchedLast28Days] = useState<number | null>(null)
  const [metricsError, setMetricsError] = useState(false)
  const [metricsAttempt, setMetricsAttempt] = useState(0)
  useEffect(() => {
    if (!detailsOpen || !ruleId) return
    let cancelled = false
    setMatchedLast28Days(null)
    setMetricsError(false)
    void api.friendAddRules.conflicts(accountId, rule.friendKind).then((response) => {
      if (cancelled) return
      if (!response.success) { setMetricsError(true); return }
      setMatchedLast28Days(response.data.rules.find((item) => item.id === ruleId)?.matchedLast28Days ?? null)
    }).catch(() => { if (!cancelled) setMetricsError(true) })
    return () => { cancelled = true }
  }, [detailsOpen, ruleId, accountId, rule.friendKind, metricsAttempt])
  const flowSteps = friendAddFlowSteps({ isFallback: rule.isFallback, routeNames, missingRouteCount: definition.routeIds.length - routeNames.length, friendKind: rule.friendKind, definition, scenarioName: scenarios.find((scenario) => scenario.id === definition.scenarioId)?.name ?? null })
  const readdLines = friendAddReaddLines({ friendKind: rule.friendKind, status: rule.status, definition })
  const noneMode = rule.friendKind === 'returning' && definition.returningMode === 'none'
  const firstSend = noneMode
    ? '配信なし'
    : definition.messageType === 'text' && definition.messageText
      ? `テキスト ${definition.messageText.length}字`
      : MESSAGE_TYPE_LABEL[definition.messageType] ?? emptyValue('unconfigured')
  const actionSummary = definition.actions.length === 0
    ? emptyValue('none')
    : `${definition.actions.slice(0, 2).map((action) => action.label.replace(/「.*」/, '')).join('・')}の${definition.actions.length}つ`
  const overlapOk = overlapNotes.length === 0
  const rows: Array<{ label: string; value: string; href: string }> = [
    { label: '名前・フォルダ', value: `${rule.name || emptyValue('unconfigured')}${rule.folderName ? `・${rule.folderName}` : ''}`, href: hrefFor('basic') },
    { label: 'だれに', value: rule.friendKind === 'returning' ? '以前からの友だち・ブロック解除した人' : 'はじめて友だち追加した人', href: hrefFor('basic') },
    { label: '流入リンク', value: routeNames.length > 0 ? routeNames.join('・') : '未選択', href: hrefFor('routes') },
    { label: '最初に送るもの', value: `${firstSend}${definition.timing === 'immediate' ? '・追加してすぐ' : ''}`, href: hrefFor('message') },
    { label: 'あわせて行うこと', value: actionSummary, href: hrefFor('actions') },
    { label: '順番', value: `${rule.priority}番目（「経路が分からなかった人」の前）`, href: '/friend-add-settings' },
  ]
  const checks = [
    { ok: overlapOk, title: '流入リンクの重なりがない', desc: overlapOk ? `選んだ${definition.routeIds.length}つは、ほかの設定で使われていません` : overlapNotes[0], href: hrefFor('routes') },
    { ok: true, title: '二重送信を防ぐ', desc: `同じ人へは${resendSuppressionText(definition.resendSuppressionHours)}まで`, href: hrefFor('message') },
    { ok: testOk, title: 'テストで判定を確かめた', desc: testOk ? 'テストで判定が通りました' : 'テストで判定が通るまで、有効にはできません', href: null },
    { ok: slackConnected !== false, title: '失敗をSlackへ知らせる', desc: `未送信・二重送信・シナリオ開始失敗を知らせます${slackConnected === true ? '（接続済み）' : slackConnected === false ? '（未接続）' : ''}`, href: '/line-notifications/operator/new' },
  ]
  return (
    <>
      <Card variant="form" gap="normal" className={styles.card} aria-label="設定の確認">
        <CardHeader size="stacked" title={<>設定の確認</>} />
        <dl className={styles.confirmRows}>
          {rows.map((row) => (
            <div key={row.label} className={styles.confirmRow}>
              <dt>{row.label}</dt>
              <dd title={row.value}>{row.value}</dd>
              <dd>{canEdit ? <Button variant="text" size="inline" href={row.href}>変更する</Button> : <Button variant="text" size="inline" disabled lockedReason={editLockReason}>変更する</Button>}</dd>
            </div>
          ))}
        </dl>
        <Button type="button" variant="text" onClick={() => setDetailsOpen(true)}>動きの詳細を確認</Button>
      </Card>
      <Dialog open={detailsOpen} title="追加された人に起きること" onCancel={() => setDetailsOpen(false)} >
        <dl>{flowSteps.map((item) => <div key={item.key}><dt>{item.title}</dt><dd>{item.detail}</dd></div>)}</dl>
        <Field label="再追加・ブロック解除のとき"><ul>{readdLines.map((line) => <li key={line}>{line}</li>)}</ul></Field>
        <Field label="過去28日の該当"><span>{matchedLast28Days === null ? '未取得' : `${formatNumber(matchedLast28Days)}人`}</span></Field>
        {metricsError ? <Notice tone="danger" message="該当数を読み込めませんでした。" action={<Button type="button" onClick={() => setMetricsAttempt((current) => current + 1)}>再試行</Button>} /> : null}
      </Dialog>
      <Card variant="form" gap="normal" className={styles.card} aria-label="テストする（送らずに判定）">
        <CardHeader size="stacked" title={<>テストする（送らずに判定）</>} meta={<>本番の登録・タグ・マイルは変えません</>} />
        <div className={styles.switchRow}>
          <span className={styles.switchText}>送り先：自分（送らずに判定）</span>
          <span className={styles.spacer} aria-hidden="true" />
          {canEdit ? (
            <Button type="button" variant="text" disabled={testing} onClick={onTestConditions}>試す条件を指定</Button>
          ) : null}
          {canEdit ? (
            <Button type="button" disabled={testing} busy={testing} busyLabel="判定中…" onClick={runTest}>テストする（送らずに判定）</Button>
          ) : null}
        </div>
        <p className={styles.cardDesc}>{testOk ? 'テストで判定が通りました。' : 'まだテストしていません'}</p>
      </Card>
      <Card variant="form" gap="normal" className={styles.card} aria-label="有効にする前の確認">
        <CardHeader size="stacked" title={<>有効にする前の確認</>} />
        <ul className={styles.checkList}>
          {checks.map((check) => (
            <li key={check.title} className={styles.checkRow}>
              <span className={styles.checkMark} data-ok={check.ok || undefined} aria-hidden="true">
                {check.ok ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
              </span>
              <span className={styles.checkText}>
                <strong>{check.title}</strong>
                <small>{check.desc}</small>
              </span>
              {check.href
                ? canEdit ? <Button variant="text" size="inline" href={check.href}>見直す</Button> : <Button variant="text" size="inline" disabled lockedReason={editLockReason}>見直す</Button>
                : <Button type="button" variant="text" disabled={!canEdit || testing} lockedReason={editLockReason} onClick={runTest} busy={testing} busyLabel="処理中…">直す</Button>}
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}
