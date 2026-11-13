'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import ListState from '@/components/shared/list-state'
import { ApiError, api, type SupportMarkAutomationEvent, type SupportMarkAutomationRule } from '@/lib/api'
import {
  EVENT_LABELS,
  LIST_EMPTY,
  LIST_ERROR,
  MULTI_MATCH_NOTE,
  PRIORITY_MAX,
  PRIORITY_MIN,
  PROTECTION_MAX,
  activeText,
  eventLabel,
  failureOf,
  inExecutionOrder,
  isCurrentResponse,
  protectionText,
  saveCallOf,
  toRuleBody,
  validateRule,
  type Failure,
  type RequestAt,
} from './support-mark-rules-view'
import styles from './support-mark-rules-panel.module.css'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { TextField as SharedTextField } from '@/components/shared/text-field'

type Draft = {
  name: string
  event: SupportMarkAutomationEvent
  priority: string
  manualProtectionMinutes: string
  isActive: boolean
  condition?: SupportMarkAutomationRule['condition']
}

const EMPTY_DRAFT: Draft = {
  name: '', event: 'staff_assigned', priority: '0', manualProtectionMinutes: '0', isActive: true,
}

const draftOf = (rule: SupportMarkAutomationRule): Draft => ({
  name: rule.name,
  event: rule.event,
  priority: String(rule.priority),
  manualProtectionMinutes: String(rule.manualProtectionMinutes),
  isActive: rule.isActive,
  condition: rule.condition,
})

/**
 * 対応マークの自動変更ルール（設計 `GMvBd` 4-3-A）。
 *
 * **名前・色・並び順・初期値と同じ面に置く。** 別画面にすると、
 * 「このマークがいつ付くのか」を見るのに行き来することになる。
 *
 * ルールの正本は `automation_definitions` / `automation_versions`。
 * 公開版は書き換えず、直すたびに新しい版が作られる。削除は履歴を残す
 * アーカイブで、消去ではない。
 */
export default function SupportMarkRulesPanel({
  accountId,
  markId,
  markName,
  onCloseGuard,
}: {
  accountId: string | null
  markId: string | null
  markName: string
  onCloseGuard?: (guard: ((action: () => void) => void) | null) => void
}) {
  const saveErrors = useSaveFormErrors()

  const [rules, setRules] = useState<SupportMarkAutomationRule[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden' | 'not-connected'>('loading')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [touched, setTouched] = useState(false)
  const [pendingArchive, setPendingArchive] = useState<{ rule: SupportMarkAutomationRule; accountId: string; markId: string; markName: string; epoch: number } | null>(null)
  const scope = useRef({ accountId, markId, markName, epoch: 0 })
  if (scope.current.accountId !== accountId || scope.current.markId !== markId || scope.current.markName !== markName) scope.current = { accountId, markId, markName, epoch: scope.current.epoch + 1 }
  const baseline = useRef(JSON.stringify(EMPTY_DRAFT))
  const guard = useUnsavedGuard({ dirty: editingId !== null && JSON.stringify(draft) !== baseline.current, busy: saving, subject: '自動変更ルール', onDiscard: () => { setEditingId(null); setDraft(EMPTY_DRAFT); setFailure(null) } })
  useEffect(() => { onCloseGuard?.(guard.guarded); return () => onCloseGuard?.(null) }, [guard.guarded, onCloseGuard])

  /*
    **遅い返事を別のマークへ映さない。**
    アカウントとマークと世代の3つが一致したときだけ受け取る。
    マークを続けて押すと、前の返事があとから届くことがある。
  */
  const requestRef = useRef<RequestAt>({ accountId: null, markId: null, generation: 0 })

  /*
    **新しいルール1件に要求キー1つ。** 二度押し・応答喪失の送り直しで
    同じルールが2件できないよう、作る窓を開けるたびに取り直す。
    保存に失敗した直しの再送は同じキーで送る。
  */
  const ruleKeyRef = useRef<string>(crypto.randomUUID())

  const load = useCallback(async () => {
    if (!accountId || !markId) return
    requestRef.current = {
      accountId, markId, generation: requestRef.current.generation + 1,
    }
    const at: RequestAt = { ...requestRef.current }
    const stillHere = () => isCurrentResponse(requestRef.current, at)

    setState('loading')
    try {
      const res = await api.supportMarks.automationRules(markId, accountId)
      if (!stillHere()) return
      if (!res.success) throw new Error('failed')
      setRules(inExecutionOrder(res.data))
      setState('ready')
    } catch (err) {

      if (!stillHere()) return
      const fieldFailure = saveErrors.capture(err)
      /*
        権限不足・未接続・取得失敗を分ける。**次にすることが違う。**
        権限なら人に頼む、未接続なら待つ、取得失敗ならもう一度試す。

        **404 を「取得失敗」に混ぜない。** 混ぜると「読み直す」を出すことに
        なり、何度押しても直らない口を押させ続ける。この画面が呼ぶ口は
        まだ Worker に無く（API は skmtmst/line-harness-oss#758）、
        入るまでは 404 が返る。
      */
      if (!(err instanceof ApiError)) { { if (!fieldFailure) setState('error'); } return }
      if (err.status === 403) { { if (!fieldFailure) setState('forbidden'); } return }
      { if (!fieldFailure) setState(err.status === 404 ? 'not-connected' : 'error') }
    }
  }, [accountId, markId, saveErrors])

  /*
    **開いたときに読むだけ。** 保存や削除の口は呼ばない。
    以前ほかの画面で、開いただけで試験送信が走り、公開の条件を
    満たしてしまったことがある。
  */
  useEffect(() => {
    /* アカウントやマークが変わったら、前の内容と結果をその場で捨てる。 */
    setRules([])
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setFailure(null)
    setTouched(false)
    setPendingArchive(null)
    if (!accountId || !markId) {
      requestRef.current = { accountId, markId, generation: requestRef.current.generation + 1 }
      setState('ready')
      return
    }
    void load()
  }, [accountId, markId, load])

  if (!markId) {
    return (
      <SaveErrorScope errors={saveErrors}><ListState
        kind="empty"
        title="マークを選んでください"
        description="左の一覧から選ぶと、そのマークの自動変更ルールを確認・保存できます。"
      /></SaveErrorScope>
    )
  }

  const errors = validateRule({
    name: draft.name,
    priority: Number(draft.priority),
    manualProtectionMinutes: Number(draft.manualProtectionMinutes),
  })
  const errorFor = (field: 'name' | 'priority' | 'manualProtectionMinutes') =>
    touched ? errors.find((e) => e.field === field)?.message : undefined

  const openNew = () => guard.guarded(() => {
    baseline.current = JSON.stringify(EMPTY_DRAFT)
    setEditingId('new')
    setDraft(EMPTY_DRAFT)
    setFailure(null)
    setTouched(false)
    ruleKeyRef.current = crypto.randomUUID()
  })

  const openEdit = (rule: SupportMarkAutomationRule) => guard.guarded(() => {
    const next = draftOf(rule)
    baseline.current = JSON.stringify(next)
    setEditingId(rule.id)
    setDraft(next)
    setFailure(null)
    setTouched(false)
  })

  const save = async () => {
    if (!accountId || !markId || errors.length > 0) return
    const call = saveCallOf(editingId, rules)
    if (!call) return
    const body = toRuleBody(draft)
    setSaving(true)
    setFailure(null)
    try {
      const res = call.kind === 'update'
        ? await api.supportMarks.updateAutomationRule(call.ruleId, accountId, call.expectedVersion, body)
        : await api.supportMarks.createAutomationRule(markId, accountId, body, ruleKeyRef.current)
      if (!res.success) throw new Error('failed')
      guard.disarm()
      setEditingId(null)
      await load()
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      /*
        **版競合では窓を閉じない。** 閉じると、直した内容が消えたのか
        保存できたのか分からなくなる。書いた内容は残したまま断る。
      */
      { if (!fieldFailure) setFailure(failureOf({ status: err instanceof ApiError ? err.status : undefined })) }
    } finally {
      setSaving(false)
    }
  }

  const archive = async () => {
    if (!pendingArchive || pendingArchive.epoch !== scope.current.epoch || pendingArchive.accountId !== accountId || pendingArchive.markId !== markId) return
    const confirmation = pendingArchive
    setSaving(true)
    setFailure(null)
    try {
      const res = await api.supportMarks.archiveAutomationRule(
        confirmation.rule.id, confirmation.accountId, confirmation.rule.version,
      )
      if (scope.current.epoch !== confirmation.epoch) return false
      if (!res.success) throw new Error('failed')
      setPendingArchive(null)
      void load()
      return true
    } catch (err) {
      if (scope.current.epoch !== confirmation.epoch) return false
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure) setFailure(failureOf({ status: err instanceof ApiError ? err.status : undefined })) }
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><section className={styles.panel} data-design-node="GMvBd">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h3 className={styles.title}>自動変更ルール</h3>
          <p className={styles.note}>
            受信・返信・担当割当・期限超過などをきっかけに、「{markName}」へ自動で変えられます。
          </p>
        </div>
        <Button
          variant="primary"
          data-qa-open="GMvBd"
          onClick={openNew}
          disabled={state === 'forbidden' || state === 'not-connected'}
        >
          ＋ ルールを作る
        </Button>
      </header>

      {failure ? (
        <Notice tone={failure.kind === "forbidden" ? "danger" : "warn"} role="alert" data-failure-kind={failure.kind} action={<>
          {failure.canReload ? (
            <Button onClick={() => void load()}>最新の内容を読み直す</Button>
          ) : null}
        </>}>
          <p>{failure.message}</p>
        </Notice>
      ) : null}

      {state === 'loading' ? (
        <ListState kind="loading" title="自動変更ルールを読み込んでいます" />
      ) : state === 'forbidden' ? (
        <ListState
          kind="forbidden"
          title="自動変更ルールを見る権限がありません"
          description="このLINEアカウントの自動変更ルールは、管理者だけが扱えます。"
        />
      ) : state === 'not-connected' ? (
        /*
          **押しても何も起きない操作を並べない**（`管理画面-common-rules` §5-5）。
          読み直しの口も出さない——押しても直らないため。
        */
        <ListState
          kind="empty"
          title="自動変更ルールはまだ接続されていません"
          description="ルールを保存する仕組みが、このアカウントではまだ動いていません。接続されるとここに一覧が出ます。それまでは対応マークを手で変えてください。"
        />
      ) : state === 'error' ? (
        <ListState
          kind="error"
          title={LIST_ERROR.title}
          description={LIST_ERROR.description}
          onRetry={() => void load()}
        />
      ) : rules.length === 0 && editingId === null ? (
        <ListState kind="empty" title={LIST_EMPTY.title} description={LIST_EMPTY.description} />
      ) : (
        <>
          {/* 実行順そのものを並びにしている。上のほうが先に効く。 */}
          <p className={styles.note}>{MULTI_MATCH_NOTE}</p>
          <ol className={styles.list}>
            {rules.map((rule, index) => (
              <li key={rule.id} className={styles.row}>
                <span className={styles.rank}>{index + 1}</span>
                <div className={styles.rowBody}>
                  <p className={styles.rowName}>{rule.name}</p>
                  <p className={styles.rowMeta}>
                    {eventLabel(rule.event)}
                    <span className={styles.dot}>・</span>
                    「{markName}」に変更
                  </p>
                  <p className={styles.rowDetail}>優先順位 {rule.priority}・手動変更のあと {protectionText(rule.manualProtectionMinutes)}</p>
                </div>
                <span className={rule.isActive ? styles.on : styles.off}>{activeText(rule.isActive)}</span>
                <span className={styles.rowActions}>
                  <Button onClick={() => openEdit(rule)}>変更</Button>
                  <Button onClick={() => { setFailure(null); accountId && markId && requestRef.current.accountId === accountId && requestRef.current.markId === markId && setPendingArchive({ rule, accountId, markId, markName, epoch: scope.current.epoch }) }}>停止する</Button>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}

      {editingId !== null ? (
        <div className={styles.form}>
          <h4 className={styles.formTitle}>{editingId === 'new' ? 'ルールを作る' : 'ルールを変更'}</h4>
          <label className={styles.field}>
            <span className={styles.label}>ルールの名前</span>
            <SaveErrorField names={["name","draft.name"]}><SharedTextField
              className={styles.input}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="例: 担当者が決まったら対応中へ"
            /></SaveErrorField>
            {errorFor('name') ? <span className={styles.fieldError}>{errorFor('name')}</span> : null}
          </label>

          <fieldset className={styles.field}>
            <legend className={styles.label}>きっかけ</legend>
            <div className={styles.events}>
              {EVENT_LABELS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={draft.event === item.value}
                  onClick={() => setDraft((d) => ({ ...d, event: item.value }))}
                  className={draft.event === item.value ? styles.eventOn : styles.event}
                >
                  <span className={styles.eventLabel}>{item.label}</span>
                  <span className={styles.eventNote}>{item.note}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className={styles.pair}>
            <label className={styles.field}>
              <span className={styles.label}>優先順位</span>
              <SaveErrorField names={["priority","draft.priority"]}><SharedTextField
                className={styles.input}
                type="number"
                min={PRIORITY_MIN}
                max={PRIORITY_MAX}
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
              /></SaveErrorField>
              <span className={styles.hint}>大きいほど先に見ます。</span>
              {errorFor('priority') ? <span className={styles.fieldError}>{errorFor('priority')}</span> : null}
            </label>
            <label className={styles.field}>
              <span className={styles.label}>手動変更のあと自動で変えない時間（分）</span>
              <SaveErrorField names={["manualProtectionMinutes","draft.manualProtectionMinutes","manual_protection_minutes","draft.manual_protection_minutes"]}><SharedTextField
                className={styles.input}
                type="number"
                min={0}
                max={PROTECTION_MAX}
                value={draft.manualProtectionMinutes}
                onChange={(e) => setDraft((d) => ({ ...d, manualProtectionMinutes: e.target.value }))}
              /></SaveErrorField>
              {/* 0のときに「0なら保護しません。保護しない」と重ねて言わない。 */}
              <span className={styles.hint}>
                {Number(draft.manualProtectionMinutes) === 0
                  ? '0なら、手で変えたあとでも自動で変わります。'
                  : `手で変えたあと ${protectionText(Number(draft.manualProtectionMinutes))} は自動で変わりません。`}
              </span>
              {errorFor('manualProtectionMinutes')
                ? <span className={styles.fieldError}>{errorFor('manualProtectionMinutes')}</span>
                : null}
            </label>
          </div>

          <SaveErrorField names={["isActive","draft.isActive","is_active","draft.is_active"]}><Checkbox
            checked={draft.isActive}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, isActive: checked }))}
          >このルールを動かす</Checkbox></SaveErrorField>

          <div className={styles.formActions}>
            <Button onClick={() => guard.guarded(() => { setEditingId(null); setFailure(null) })} disabled={saving}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              /* 撮影の目印。文言で探すと、ほかの「保存」に当たって空振りする。 */
              data-qa-open="GMvBd-save"
              onMouseDown={() => setTouched(true)}
              onClick={() => void save()}
              disabled={saving || errors.length > 0} busy={saving}>保存する
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingArchive !== null && pendingArchive.epoch === scope.current.epoch}
        title="このルールを停止しますか？"
        /* 消去ではない。履歴が残ることを先に言う。 */
        description={
          `「${pendingArchive?.rule.name ?? ''}」を停止します。`
          + 'これ以降このルールでマークは変わりません。'
          + 'これまでの変更履歴は監査記録として残ります。'
        }
        confirmLabel="このルールを停止"
        destructive
        busy={saving}
        error={failure?.message} onSuccess={() => setPendingArchive(null)} onConfirm={() => archive()}
        onCancel={() => { if (!saving) setPendingArchive(null) }}
      ><OperationTargetSummary accounts={[{ id: pendingArchive?.accountId ?? '' }]} externalTarget={{ label: '対応マーク', name: pendingArchive?.markName }} /></ConfirmDialog>
      <UnsavedLeaveDialog subject="自動変更ルールへの変更" open={guard.leaveTarget !== null} busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    </section></SaveErrorScope>
  )
}
