'use client'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { CircleAlert, CircleCheck, Power, Send } from 'lucide-react'
import type { FriendAddRoutingValidation } from '@line-crm/shared'
import { CreatePage } from '@/components/templates'
import { Steps } from '@/components/templates/steps'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Card, { CardHeader } from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import TargetMissing from '@/components/shared/target-missing'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import { notifyToast } from '@/components/shared/toast'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { api, ApiError, type FriendAddRule } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useStaffRole, loadStaffIdentity } from '@/lib/staff-role'
import { resendSuppressionText } from '@/v8/friend-add/public/text/index'
import { actionSummaryText, blockedReason, canPublish, firstSendText, idempotencyKeyFor, PUBLISH_STEPS, editStepHref } from './flow'
import FriendAddDoneV8 from './done'
import styles from './publish.module.css'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8 友だち追加時の配信 作る⑤ 確認（Pencil ）と、有効にしたあとの完了（）。
 *
 * 入口は /friend-add-settings/publish?id=<設定>。管理画面（app/friend-add-settings/publish）と
 * 同じ口を同じ順に呼ぶ：設定を読む → 確認（validate）と重なり（conflicts）を読む →
 * 「有効にする」で公開（publish・二重公開を防ぐ鍵つき）→ 完了の面へ差し替える。
 * 画面を開くだけではテストを走らせない（走らせると記録だけ付いて「テスト済み」になる）。
 * テストは「テストする（送らずに判定）」を押したときだけ。
 *
 * 2つの面（確認・完了）は同じ流れの前後なので1つのファイル。完了は読み直さず、
 * 公開したときの数をそのまま出す。`?done=1` は作る⑤（編集画面）から有効にして来たとき。
 */

type Phase = 'loading' | 'ready' | 'empty' | 'error' | 'forbidden' | 'missing'
type RuleDetail = {
  rule: FriendAddRule
  staffNotification: { status: 'connected' | 'disconnected' | 'unconfigured' | null; reason: string | null }
}
type Published = { ruleName: string; routeNames: string[]; priority: number; slackConnected: boolean | null }

export default function FriendAddPublishV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <FriendAddPublish />
    </Suspense>
  )
}

function slackOf(detail: RuleDetail | null): boolean | null {
  const status = detail?.staffNotification?.status
  return status === 'connected' ? true : status == null ? null : false
}

function FriendAddPublish() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('初回案内を作る')
  usePageCrumbs([{ label: '友だち追加時の配信', href: '/friend-add-settings' }])
  const router = useRouter()
  const searchParams = useSearchParams()
  const ruleId = searchParams.get('id')
  const { selectedAccountId, accounts } = useAccount()
  const accountName = accounts.find((account) => account.id === selectedAccountId)?.name ?? '公式アカウント'
  const role = useStaffRole()
  // 役割が読めるまでは今までどおり出す。staff と分かったら変える操作を隠す（最後の守りはサーバ）。
  const canEdit = useFeatureAccess('friendAdd')
  const [me, setMe] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [detail, setDetail] = useState<RuleDetail | null>(null)
  const [validation, setValidation] = useState<FriendAddRoutingValidation | null>(null)
  const [overlapNotes, setOverlapNotes] = useState<string[]>([])
  const [published, setPublished] = useState<Published | null>(null)
  const [failure, setFailure] = useState<{ title: string; description: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testNote, setTestNote] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /*
   * どのアカウントの、何回目の読み込みかを持つ。切り替え・読み直しのあとに
   * 前の要求の返事が遅れて届いても、別の設定の数を映さない（管理画面 と同じ番兵）。
   */
  const requestRef = useRef<{ accountId: string | null; generation: number }>({ accountId: null, generation: 0 })

  useEffect(() => {
    let alive = true
    void loadStaffIdentity().then((res) => { if (alive && res.success) setMe(res.data.name ?? null) }).catch(() => {})
    return () => { alive = false }
  }, [])

  /** 確認（validate）と重なり（conflicts）を読み、確認の結果を作る。テストのあとにも読み直す。 */
  const readChecks = useCallback(async (accountId: string, rule: FriendAddRule, isCurrent: () => boolean) => {
    const [validationRes, conflictRes] = await Promise.all([
      api.friendAddRules.validate(accountId, rule.id),
      api.friendAddRules.conflicts(accountId, rule.friendKind),
    ])
    if (!isCurrent()) return
    if(!validationRes.success || !conflictRes.success)throw new Error('checks unavailable')
    const matched = conflictRes.success
      ? conflictRes.data.rules.find((item) => item.id === rule.id)?.matchedLast28Days ?? 0
      : null
    const conflicts = conflictRes.data.conflicts.filter((item) => item.ruleIds.length === 0 || item.ruleIds.includes(rule.id))
    setOverlapNotes(conflicts.map((item) => item.message))
    if (validationRes.success) {
      setValidation({
        canPublish: validationRes.data.canPublish,
        // 過去28日の実績を未来の対象人数として見せない（共有型が求めるので持つだけ）。
        estimatedAudienceCount: matched,
        checks: validationRes.data.checks.map((check) => ({ key: check.key, label: check.label, status: check.status, detail: check.detail })),
        conflicts: conflicts.map((item) => ({ code: item.code, message: item.message })),
        lastTestStatus: rule.lastTestStatus,
      })
    }
  }, [])

  useEffect(() => {
    if (!selectedAccountId) return
    if (!ruleId) { setPhase('missing'); return }
    let alive = true
    const generation = requestRef.current.generation + 1
    requestRef.current = { accountId: selectedAccountId, generation }
    const isCurrent = () => alive && requestRef.current.accountId === selectedAccountId && requestRef.current.generation === generation
    setPhase('loading')
    setBusy(false)
    setTesting(false)
    setFailure(null)
    // アカウント固有の結果を先に捨てる。残すと、別のアカウントの数を見ながら公開することになる。
    setDetail(null)
    setValidation(null)
    setOverlapNotes([])
    setPublished(null)
    setError('')
    setNotice('')
    setTestNote(null)
    void (async () => {
      try {
        const res = await api.friendAddRules.get(selectedAccountId, ruleId)
        if (!isCurrent()) return
        if (!res.success) {
          setFailure({ title: '下書きを読み込めませんでした', description: '時間をおいて読み直してください。' })
          setPhase('error')
          return
        }
        const loaded: RuleDetail = { rule: res.data.rule, staffNotification: res.data.staffNotification }
        setDetail(loaded)
        if (canEdit) await readChecks(selectedAccountId, loaded.rule, isCurrent)
        if (!isCurrent()) return
        setPhase('ready')
      } catch (caught) {
        if (!isCurrent()) return
        const fieldFailure = saveErrors.capture(caught)
        // 404 は「確認する下書きがない」。失敗と混ぜない。
        if (caught instanceof ApiError && caught.status === 404) { setPhase('empty'); return }
        if (caught instanceof ApiError && caught.status === 403) {
          { if (!fieldFailure)
          setFailure({ title: 'この設定を公開する権限がありません', description: permissionDeniedMessage('store') }) }
          setPhase('forbidden')
          return
        }
        { if (!fieldFailure)
        setFailure({ title: '下書きを読み込めませんでした', description: '時間をおいて読み直してください。' }) }
        setPhase('error')
      }
    })()
    return () => { alive = false }
  }, [ruleId, selectedAccountId, reloadKey, readChecks, saveErrors, canEdit])

  /** テストする（送らずに判定）。本番の登録・タグ・マイルは変えない。終わったら確認を読み直す。 */
  const runTest = async () => {
    if (!canEdit || !selectedAccountId || !detail || testing) return
    const at = { accountId: selectedAccountId, generation: requestRef.current.generation }
    const stillHere = () => requestRef.current.accountId === at.accountId && requestRef.current.generation === at.generation
    setTesting(true)
    setError('')
    setNotice('')
    try {
      const res = await api.friendAddRules.test(at.accountId, detail.rule.id, { routeId: null, expectedAt: null, friendId: null })
      if (!stillHere()) return
      const matched = 'data' in res && res.data ? res.data.matched : false
      const reasons = 'data' in res && res.data ? res.data.reasons : []
      if (!res.success || !matched) {
        setTestNote(reasons[0] ?? 'テストで判定が通りませんでした')
        if (!res.success) setError(res.error)
      } else {
        setTestNote('テストで判定が通りました。実際の送信・登録・タグ付けはしていません')
      }
      // 記録はサーバが持つ（last_test_status）。読み直して「有効にする」の可否に映す。
      const fresh = await api.friendAddRules.get(at.accountId, detail.rule.id)
      if (!stillHere()) return
      if (fresh.success) {
        const next: RuleDetail = { rule: fresh.data.rule, staffNotification: fresh.data.staffNotification }
        setDetail(next)
        await readChecks(at.accountId, next.rule, stillHere)
      }
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (stillHere()) { if (!fieldFailure)
 setError('テストを実行できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      if (stillHere()) setTesting(false)
    }
  }

  /** 有効にする。押した時点のアカウント・読み込み回数と違ったら、返事を映さない。 */
  const publish = async () => {
    if (!selectedAccountId || !detail || busy) return
    const at = { accountId: selectedAccountId, generation: requestRef.current.generation }
    const stillHere = () => requestRef.current.accountId === at.accountId && requestRef.current.generation === at.generation
    setBusy(true)
    setError('')
    try {
      const rule = detail.rule
      const res = await api.friendAddRules.publish(at.accountId, rule.id, idempotencyKeyFor({ accountId: at.accountId, versionId: rule.versionId ?? rule.id }))
      if (!stillHere()) return
      if (!res.success) throw new Error('failed')
      setPublished({ ruleName: rule.name, routeNames: rule.routeNames, priority: rule.priority, slackConnected: slackOf(detail) })
    } catch (caught) {
      if (!stillHere()) return
      const fieldFailure = saveErrors.capture(caught)
      { if (!fieldFailure)

      setError(caught instanceof ApiError && caught.status === 403
        ? permissionDeniedMessage('store')
        : '有効化できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (stillHere()) setBusy(false)
    }
  }

  /** 下書きのまま保存：この画面では何も書き換えないので、下書きはもう保存済み。一覧へ戻る。 */
  const keepDraft = () => {
    notifyToast('下書きのまま残しました')
    router.push('/friend-add-settings')
  }

  if (phase === 'loading') return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="設定を読み込んでいます" /></SaveErrorScope>
  if (phase === 'forbidden') {
    return <SaveErrorScope errors={saveErrors}><ListState kind="forbidden" title={failure?.title} description={failure?.description} action={<Button href="/friend-add-settings">設定へ戻る</Button>} /></SaveErrorScope>
  }
  if (phase === 'missing') {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="unspecified" title="公開する下書きが指定されていません" description="一覧から、公開する下書きを選び直してください。" backHref="/friend-add-settings" backLabel="設定へ戻る" /></SaveErrorScope>
  }
  if (phase === 'empty') {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="確認する下書きがありません" description="友だち追加時の配信を作ってから、この画面で公開します。" backHref="/friend-add-settings" backLabel="設定へ戻る" /></SaveErrorScope>
  }
  if (phase === 'error' || !detail) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="error"
        title={failure?.title ?? '下書きを読み込めませんでした'}
        description={failure?.description ?? '通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。'}
        onRetry={() => setReloadKey((key) => key + 1)}
      /></SaveErrorScope>
    )
  }

  /* 有効にしたあと。`?done=1` は作る⑤から有効にして来たとき（読み込んだ設定で出す）。 */
  if (published) return <SaveErrorScope errors={saveErrors}><FriendAddDoneV8 {...published} ruleId={ruleId} /></SaveErrorScope>
  if (searchParams.get('done') === '1' && detail.rule.status === 'published') {
    return <SaveErrorScope errors={saveErrors}><FriendAddDoneV8 ruleId={ruleId} ruleName={detail.rule.name} routeNames={detail.rule.routeNames} priority={detail.rule.priority} slackConnected={slackOf(detail)} /></SaveErrorScope>
  }

  const rule = detail.rule
  const def = rule.definition
  const noneMode = rule.friendKind === 'returning' && def.returningMode === 'none'
  const editHref = (step: string) => `/friend-add-settings?view=edit&id=${encodeURIComponent(rule.id)}&step=${step}`
  const statusLabel = rule.status === 'published' ? '有効' : rule.status === 'stopped' ? '停止中' : '下書き'
  const testOk = validation?.lastTestStatus === 'succeeded'
  const ready = canEdit && canPublish({ validation, busy })
  const blocked = blockedReason(validation)
  const duplicateCheck = validation?.checks.find((check) => check.key === 'duplicate_prevention')
  const slack = slackOf(detail)
  const routeNames = rule.isFallback ? ['経路が分からなかった人'] : rule.routeNames

  const rows: Array<{ label: string; value: string; href: string }> = [
    { label: '名前・フォルダ', value: `${rule.name || emptyValue('unconfigured')}${rule.folderName ? `・${rule.folderName}` : ''}`, href: editHref('basic') },
    { label: 'だれに', value: rule.friendKind === 'returning' ? '以前からの友だち・ブロック解除した人' : 'はじめて友だち追加した人', href: editHref('basic') },
    { label: '流入リンク', value: routeNames.length > 0 ? routeNames.join('・') : '未選択', href: editHref('routes') },
    { label: '最初に送るもの', value: firstSendText(rule), href: editHref('message') },
    { label: 'あわせて行うこと', value: actionSummaryText(rule), href: editHref('actions') },
    { label: '順番', value: `${rule.priority}番目（「経路が分からなかった人」の前）`, href: '/friend-add-settings' },
  ]
  const checks: Array<{ ok: boolean; title: string; desc: string; href: string | null; action: string }> = [
    {
      ok: overlapNotes.length === 0,
      title: '流入リンクの重なりがない',
      desc: overlapNotes.length === 0 ? `選んだ${def.routeIds.length}つは、ほかの設定で使われていません` : overlapNotes[0],
      href: editHref('routes'),
      action: '見直す',
    },
    {
      ok: duplicateCheck ? duplicateCheck.status === 'passed' : (def.resendSuppressionHours ?? 24) > 0,
      title: '二重送信を防ぐ',
      desc: `同じ人へは${resendSuppressionText(def.resendSuppressionHours)}まで`,
      href: editHref('message'),
      action: '見直す',
    },
    {
      ok: testOk,
      title: 'テストで判定を確かめた',
      desc: testOk ? 'テストで判定が通りました' : 'テストで判定が通るまで、有効にはできません',
      href: null,
      action: 'テストする',
    },
    {
      ok: slack !== false,
      title: '失敗をSlackへ知らせる',
      desc: `未送信・二重送信・シナリオ開始失敗を知らせます${slack === true ? '（接続済み）' : slack === false ? '（未接続）' : ''}`,
      href: '/line-notifications/operator/new',
      action: '見直す',
    },
  ]
  /* 4つの行に入らないサーバの確認（参照先が無い など）は、理由を帯で出す。 */
  const otherFailed = validation?.checks.filter((check) => check.status === 'failed' && check.key !== 'duplicate_prevention') ?? []

  const summary = (
    <CreateSummaryCard rows={[
      { label: 'だれに', value: rule.friendKind === 'returning' ? '以前からの友だち' : 'はじめての人' },
      { label: '流入リンク', value: routeNames.length === 0 ? '未選択' : routeNames.length === 1 ? routeNames[0] : `${routeNames.length}つ（${routeNames[0]}ほか）` },
      { label: '最初に送るもの', value: noneMode ? '配信なし' : `${def.messageType === 'text' ? 'テキスト' : 'メッセージ'}＋${def.actions.length}つ` },
      { label: '状態', value: `${statusLabel} → 有効にする` },
    ]} />
  )
  const message = noneMode
    ? '再追加では配信しません。案内後の操作だけを行います。'
    : def.messageText || `シナリオ「${rule.scenarioName ?? '選択中'}」を始めます。`
  const phone = (
    <LinePreview accountName={accountName}>
      <p className={styles.talkChip}><span>友だち追加しました</span></p>
      <LinePreviewMessage accountName={accountName} avatar={accountName.slice(0, 1)} time="今">
        {message}
      </LinePreviewMessage>
    </LinePreview>
  )
  const preview = (
    <>
      {summary}
      {phone}
    </>
  )

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="U8Xm3X"
      title="初回案内を作る"
      steps={(
        <Steps
          label="初回案内の作る手順"
          readOnly={!canEdit} summaries={{ 基本設定: rule.name, 流入リンク: routeNames.join('・') || '未選択', 初回案内: firstSendText(rule), あわせて行うこと: actionSummaryText(rule) }}
          steps={PUBLISH_STEPS.map((label, index) => ({
            label,
            state: index < PUBLISH_STEPS.length - 1 ? 'done' as const : 'current' as const,
            onSelect: ruleId && index < PUBLISH_STEPS.length - 1 ? () => router.push(editStepHref(ruleId, index)) : undefined,
          }))}
        />
      )}
      help={`名前：${rule.name}・いまは${statusLabel}です`}
      preview={preview}
      notice={!canEdit ? <ReadOnlyNotice role="status">閲覧のみで見ています。有効にする操作はオーナーか管理者に頼んでください。</ReadOnlyNotice> : undefined}
      status={busy ? '有効にしています' : undefined}
      footerActions={canEdit ? (
        <>
          <Button href="/friend-add-settings">キャンセル</Button>
          <Button type="button" onClick={keepDraft} disabled={busy}>下書きのまま保存</Button>
          <Button
            type="button"
            variant="primary"
            disabled={!ready}
            title={!ready && blocked ? blocked : undefined}
            busy={busy}
            busyLabel="有効化中…"
            onClick={() => void publish()}
          >
            <Power size={16} aria-hidden="true" />有効にする
          </Button>
        </>
      ) : (
        /* 閲覧のみ：一覧へ戻る道を残す。 */
        <Button href="/friend-add-settings">一覧へ戻る</Button>
      )}
    >
      {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
      {notice ? <Notice tone="success" message={notice} onClose={() => setNotice('')} /> : null}

      <Card variant="form" gap="normal" className={styles.card} aria-label="設定の確認">
        <CardHeader size="stacked" title={<>設定の確認</>} />
        <dl className={styles.confirmRows}>
          {rows.map((row) => (
            <div key={row.label} className={styles.confirmRow}>
              <dt>{row.label}</dt>
              <dd title={row.value}>{row.value}</dd>
              <dd className={styles.rowAction}>
                {<PermissionGatedButton allowed={canEdit} href={row.href} variant="text">変える</PermissionGatedButton>}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card variant="form" gap="normal" className={styles.card} aria-label="テストする（送らずに判定）">
        <CardHeader size="stacked" title={<>テストする（送らずに判定）</>} meta={<>本番の登録・タグ・マイルは変えません</>} />
        <div className={styles.testRow}>
          <p className={styles.cardDesc}>送り先：{me ?? 'あなた'}（自分）</p>
          {canEdit ? (
            <Button type="button" disabled={testing} busy={testing} busyLabel="判定中…" onClick={() => void runTest()}>
              <Send size={16} aria-hidden="true" />テストする（送らずに判定）
            </Button>
          ) : null}
        </div>
        <p className={styles.cardDesc} role="status">
          {testNote ?? (rule.lastTestStatus === 'succeeded'
            ? `テストで判定が通っています${rule.lastTestedAt ? `（${rule.lastTestedAt.slice(0, 16).replace('T', ' ')}）` : ''}`
            : rule.lastTestStatus === 'failed' ? '最後のテストで判定が通りませんでした' : 'まだテストしていません')}
        </p>
      </Card>

      <Card variant="form" gap="normal" className={styles.card} aria-label="有効にする前の確認">
        <CardHeader size="stacked" title={<>有効にする前の確認</>} />
        {canEdit ? <ul className={styles.checkList}>
          {checks.map((check) => (
            <li key={check.title} className={styles.checkRow}>
              <span className={styles.checkMark} data-ok={check.ok || undefined} aria-hidden="true">
                {check.ok ? <CircleCheck size={20} /> : <CircleAlert size={20} />}
              </span>
              <span className={styles.checkText}>
                <strong>{check.title}</strong>
                <small>{check.desc}</small>
              </span>
              {canEdit ? (
                check.href
                  ? <Button href={check.href} variant="text">{check.action}</Button>
                  : <Button type="button" variant="text" disabled={testing} onClick={() => void runTest()} busyLabel="判定中…">{check.action}</Button>
              ) : null}
            </li>
          ))}
        </ul> : <Notice tone="info">有効にする前の確認は、編集できる人が行います。</Notice>}
        {otherFailed.length > 0 ? (
          <Notice tone="warn" message={`${otherFailed.map((check) => check.detail || check.label).join('・')}`} />
        ) : null}
      </Card>

    </CreatePage></SaveErrorScope>
  )
}
