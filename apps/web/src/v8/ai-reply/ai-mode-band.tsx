'use client'

/*
 * 「AI の使い方」の帯と段の切り替え（板 y4nixm・UbRQ4・yUK7Z、確かめの窓 NmTj4）。
 * - 使っていない：帯「AI を使っていません」［使ってみる］（UbRQ4）
 * - 返信案だけ／自動で答える：帯に今の段と［変える］（y4nixm）。［変える］で段の選び（NmTj4 の帯の右）
 * - 段を変えるときは必ず窓で確かめる。自動で答えるをオンにする窓は NmTj4（オーナーだけ・本人確認つき）
 * - 閲覧のみ・スタッフは［変える］を出さない（yUK7Z）
 */
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { useEffect, useRef, useState } from 'react'
import { Bot, Sparkles, TriangleAlert } from 'lucide-react'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import SegmentedControl from '@/components/shared/segmented'
import StatusBadge from '@/components/shared/status-badge'
import { TextField } from '@/components/shared/text-field'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { notifyToast } from '@/components/shared/toast'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import { formatNumber } from '@/lib/format'
import { AI_SETTINGS_STEP_UP, aiReplyApi, type AiMode, type AiSettings, type AiTestResult } from './api'
import { MODE_CHOICE_LABEL, MODE_NOTE, MODE_TITLE, handoffReasonText, type AiPermissions } from './words'
import styles from './ai-mode-band.module.css'

type Choice = Exclude<AiMode, 'suspended'>

export function AiModeBand({ accountId, accountName, settings, permissions, onChanged }: {
  accountId: string
  accountName: string
  settings: AiSettings | null
  permissions: AiPermissions
  onChanged: (next: AiSettings) => void
}) {
  const mode: AiMode = settings?.mode ?? 'off'
  const [choosing, setChoosing] = useState(false)
  const [pending, setPending] = useState<Choice | null>(null)
  const accountScope = useRef({ accountId })
  if (accountScope.current.accountId !== accountId) accountScope.current = { accountId }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [pendingTarget, setPendingTarget] = useState<{ accountId: string; scope: object } | null>(null)
  const choose = (choice: Choice) => { if (accountId) { setPendingTarget({ accountId, scope: accountScope.current }); setPending(choice) } }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  useEffect(() => { setPending(null); setPendingTarget(null); setBusy(false); setError(''); setStepUp(null); setChoosing(false) }, [accountId])
  const saveErrors = useSaveFormErrors()
  /* 組2 の今の段では Q&A の自動応答は使えない（autoReplyAvailable:false）。選ぶ欄に出さない。 */
  const autoUnavailable = settings?.autoReplyAvailable === false
  const choices = autoUnavailable ? permissions.modeChoices.filter((choice) => choice !== 'auto_qa') : permissions.modeChoices
  const published = settings?.publishedQaCount ?? 0

  const close = () => { if (busy) return; setPending(null); setError('') }
  const save = async (next: Choice, stepUpToken?: string) => {
    const target = pendingTarget
    if (!mounted.current || !target || target.scope !== accountScope.current || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await aiReplyApi.saveSettings(target.accountId, { mode: next, expectedVersion: settings?.version ?? 0 }, stepUpToken)
      if (!mounted.current || target.scope !== accountScope.current) return
      onChanged(res.data)
      setPending(null)
      setChoosing(false)
      notifyToast(next === 'auto_qa' ? '自動で答えるをオンにしました' : next === 'draft_only' ? '返信案だけにしました' : 'AI を使わないにしました')
    } catch (caught) {
      if (!mounted.current || target.scope !== accountScope.current) return
      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: AI_SETTINGS_STEP_UP, action: '自動で答えるをオンにする', retry: (token) => save(next, token) })
      } else {
        if (!saveErrors.capture(caught)) setError(describeApiFailure(caught, 'AI の使い方の変更'))
      }
    } finally {
      if (mounted.current && target.scope === accountScope.current) setBusy(false)
    }
  }

  const action = mode === 'off'
    ? (choices.includes('draft_only') ? <Button onClick={() => choose('draft_only')}>使ってみる</Button> : null)
    : choices.length > 0 && !choosing
      ? <Button onClick={() => setChoosing(true)}>変更する</Button>
      : null

  const choiceValue: Choice = mode === 'suspended' ? 'draft_only' : mode
  const choiceRow = choosing && choices.length > 0 ? (
    <div className={styles.choices}>
      <SegmentedControl
        aria-label="AI の使い方"
        size="compact"
        value={choiceValue}
        options={choices.map((choice) => ({ value: choice, label: MODE_CHOICE_LABEL[choice] }))}
        onChange={(next) => {
          if (next === choiceValue) return
          if (next === 'auto_qa' && published === 0) {
            setError('')
            notifyToast('Q&A を 1 件以上公開すると選べます')
            return
          }
          choose(next)
        }}
      />
      <Button variant="text" onClick={() => setChoosing(false)}>閉じる</Button>
    </div>
  ) : null

  return (
    <SaveErrorScope errors={saveErrors}>
      <Notice
        tone="info"
        icon={<Sparkles aria-hidden="true" />}
        heading={MODE_TITLE[mode]}
        help={mode === 'off' ? 'AI は会話の要約と返信案を作ります。送るのはいつも担当者です。お客さまの電話番号・住所などは伏せてから渡します。' : '自動で答えるのは、店が公開した Q&A の答えの文そのままです。お金・予約の変更・苦情・個人情報の質問や、当たっている見込みが低いものは人へ回します。'}
        helpLabel="AI の使い方の説明"
        action={choiceRow ?? action ?? undefined}
        className={mode === 'off' ? `${styles.band} ${styles.bandOff}` : styles.band}
        data-design-node={mode === 'off' ? 'UbRQ4' : 'y4nixm'}
      >
        {MODE_NOTE[mode]}
        {choosing && autoUnavailable ? <span className={styles.ownerOnly}>Q&A で自動で答えるは、まだ使えません（使えるようになったらお知らせします）</span> : null}
        {choosing && !autoUnavailable && !choices.includes('auto_qa') && mode !== 'off' ? <span className={styles.ownerOnly}>自動で答えるのオンはオーナーだけが変えられます</span> : null}
        {choosing && choices.includes('auto_qa') && published === 0 ? <span className={styles.ownerOnly}>自動で答えるは、Q&A を 1 件以上公開すると選べます</span> : null}
      </Notice>

      <ConfirmDialog
        open={(pending === 'draft_only' || pending === 'off') && pendingTarget?.scope === accountScope.current}
        title={pending === 'off' ? 'AI を使わないにしますか？' : mode === 'auto_qa' ? '自動で答えるを止めますか？' : 'AI の返信案を使いますか？'}
        description={pending === 'off'
          ? '受信箱の要約と返信案を出さなくなります。自動で答えるのも止まります。あとから戻せます。'
          : mode === 'auto_qa'
            ? 'これから届く質問には自動で答えず、担当者が返信案を確かめて送ります。'
            : '受信箱に要約と返信案が出ます。送るのはいつも担当者です。AI に渡す前に、電話番号・住所などは伏せます。'}
        confirmLabel={pending === 'off' ? '使わないにする' : mode === 'auto_qa' ? '止める' : '使う'}
        busy={busy}
        error={error || undefined}
        onConfirm={() => { if (pending) void save(pending) }}
        onCancel={close}
      >
        {pendingTarget ? <OperationTargetSummary accounts={[{ id: pendingTarget.accountId }]} /> : null}
      </ConfirmDialog>

      <AutoAnswerConfirmDialog
        open={pending === 'auto_qa' && pendingTarget?.scope === accountScope.current}
        accountId={pendingTarget?.accountId ?? ''}
        accountName={accountName}
        published={published}
        drafts={settings?.draftQaCount ?? 0}
        busy={busy}
        error={error}
        onConfirm={() => void save('auto_qa')}
        onCancel={close}
      />
      {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
    </SaveErrorScope>
  )
}

/** 板 NmTj4「自動で答える前の確かめ」。送る相手・目的・日時・送り手・本文の 5 行と、取り消せない旨・テストの質問。 */
export function AutoAnswerConfirmDialog({ open, accountId, accountName, published, drafts, busy, error, onConfirm, onCancel }: {
  open: boolean
  accountId: string
  accountName: string
  published: number
  drafts: number
  busy: boolean
  error: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const [question, setQuestion] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AiTestResult | null>(null)
  const [testError, setTestError] = useState('')
  const runTest = async () => {
    if (!question.trim()) return
    setTesting(true)
    setTestError('')
    try {
      const res = await aiReplyApi.test(accountId, question.trim())
      setResult(res.data)
    } catch (caught) {
      setResult(null)
      setTestError(describeApiFailure(caught, 'テスト'))
    } finally {
      setTesting(false)
    }
  }
  const rows: Array<{ label: string; value: React.ReactNode; note?: string }> = [
    { label: '送る相手', value: <strong className={styles.recipient}>これから届く質問すべて（この店）</strong>, note: 'お金・予約の変更・苦情・個人情報の質問は答えず、人へ回します' },
    { label: '送る目的', value: <StatusBadge tone="warning">取引</StatusBadge>, note: 'お客さまの質問への答えです' },
    { label: '送る日時', value: <strong>オンにした時から</strong>, note: '［返信案だけ］に戻すと、すぐ自動で送るのを止めます' },
    { label: '送り手', value: <strong>送り手なし（アカウントの名前）</strong> },
    { label: '本文', value: `公開中の Q&A ${formatNumber(published)} 件${drafts > 0 ? `（確かめ待ちの ${formatNumber(drafts)} 件は使いません）` : ''}`, note: '答えの頭に「自動の答え」と書きます' },
  ]
  return (
    <Dialog
      open={open}
      title="自動で答える前の確かめ"
      titleNote={`Q&A・${accountName}`}
      designNode="NmTj4"
      designWidth={560}
      busy={busy}
      error={error || undefined}
      confirmLabel="自動で答えるをオンにする"
      confirmIcon={<Bot size={16} aria-hidden="true" />}
      cancelLabel="戻る"
      footerLead={<span className={styles.footLead}>閉じても送りません</span>}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <OperationTargetSummary accounts={[{ id: accountId }]} />
      <dl className={styles.rows}>
        {rows.map((row) => (
          <div key={row.label} className={styles.row}>
            <dt className={styles.rowLabel}>{row.label}</dt>
            <dd className={styles.rowValue}>
              <span className={styles.rowMain}>{row.value}</span>
              {row.note ? <span className={styles.rowNote}>{row.note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <Notice tone="warn" role="note" icon={<TriangleAlert size={16} aria-hidden="true" />} heading={<>自動で送った答えは取り消せません。</>}>
        <p className={styles.warnText}>答えられないときは人へ回し、受信箱に「人へ回した」で残します。</p>
      </Notice>
      <div className={styles.test}>
        <TextField aria-label="テストの質問" placeholder="例：駐車場はありますか" value={question} onChange={(event) => { setQuestion(event.target.value); setResult(null) }} />
        <Button onClick={() => void runTest()} busy={testing} disabled={!question.trim()}>テストの質問で試す</Button>
      </div>
      {result ? (
        <p className={styles.testResult} role="status">
          {result.qaTitle ? `「${result.qaTitle}」の答えで返します（テストなので送りません）` : `人へ回します：${handoffReasonText(result.handoffReason)}（テストなので送りません）`}
        </p>
      ) : null}
      {testError ? <Notice tone="danger">{testError}</Notice> : null}
    </Dialog>
  )
}
