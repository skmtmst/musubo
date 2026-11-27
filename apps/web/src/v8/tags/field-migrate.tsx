'use client'

import { knownValue } from '@/lib/known-value'

import Card, { CardHeader } from '@/components/shared/card'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/components/shared/list-navigation'
import { useSearchParams } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import type { FriendField, FriendFieldType } from '@line-crm/shared';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { CreatePage } from '@/components/templates';
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import ListState from '@/components/shared/list-state'
import TargetMissing from '@/components/shared/target-missing'
import Select from '@/components/shared/select'
import SegmentedControl from '@/components/shared/segmented'
import { ApiError, api, describeSaveFailure } from '@/lib/api';
import type { FriendFieldMigrationPreview, FriendFieldMigrationRun } from '@/lib/api';
import { createResponseGate } from '@/lib/latest-request';
import { FIELD_TYPE_HINTS } from '@/components/friend-fields/field-list';
import { formatDateTime, formatNumber } from '@/lib/format';
import { FIELD_TYPE_WORDS } from './field-editor';
import styles from './create.module.css'
import { Field } from '@/components/shared/form-controls';
import { permissionDeniedMessage, withPermissionFailure, describeApiFailure } from '@/components/shared/api-error-message';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { TextField } from '@/components/shared/text-field'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { CreateSummaryCard } from '@/components/templates/create-parts'

/*
 * ★V8 友だち情報欄の移行（種類を変える。Pencil ）。
 *
 * 読み込み・移行先の作成（R519）・事前確認・実行・結果の見守り（R547・R548）・アカウント切替の扱いは
 * 今の画面（src/v8/tags/field-migrate.tsx）から写した。見せ方を絵に合わせた：
 * 頭は「「〇〇」の種類を変える」と今の種類・人数、注意の帯、段「移行の先」に移行後の種類と見本の表
 * （今の値 → 移したあと・人数。種類だけで読む事前確認＝何も書き込まない）、その下に移行先の名前など。
 * 事前確認したあとは、結果・切り替わる使用先・実行の結果の段を足す。
 * 受け付ける URL：`/tags/fields/migrate?id=<移行元の項目>`。
 */

export function fieldMigrationFailureMessage(reason: unknown, phase: 'start' | 'resume'): string {
  const action = phase === 'start' ? '開始' : '再開'
  if (!(reason instanceof ApiError) || reason.status >= 500) return `移行を${action}できませんでした。事前確認からやり直してください。`
  return describeApiFailure(reason, `移行の${action}`)
}

const TYPES = Object.keys(FIELD_TYPE_WORDS) as FriendFieldType[]

/** 移行実行の状態を画面の言葉へ。APIの内部名はそのまま出さない。 */
const RUN_STATUS_LABELS: Record<FriendFieldMigrationRun['status'], string> = {
  previewed: '事前確認済み',
  queued: '実行待ち',
  running: '実行中',
  partial: '一部の友だちだけ移行できました',
  succeeded: '移行が完了しました',
  failed: '移行できませんでした。事前確認からやり直してください',
  stale: '確認後に内容が変わったため停止しました',
}

const RUN_RUNNING = new Set<FriendFieldMigrationRun['status']>(['previewed', 'queued', 'running'])

/** 見本の表の行：事前確認の行を「今の値 → 移したあと」でまとめ、そのまま移せる人数を先頭に。 */
export function sampleRows(preview: FriendFieldMigrationPreview): Array<{ from: string; to: string; count: number }> {
  const groups = new Map<string, { from: string; to: string; count: number }>()
  for (const row of preview.rows) {
    const from = row.sourceValue || '（空）'
    const to = row.convertedValue ?? (row.status === 'invalid' ? '（空）' : `人が確認（${row.reason ?? '確認してください'}）`)
    const key = `${from}\u0000${to}`
    const current = groups.get(key)
    if (current) current.count += 1
    else groups.set(key, { from, to, count: 1 })
  }
  const head = preview.summary.convertible > 0 ? [{ from: 'そのまま移せる値', to: '同じ値', count: preview.summary.convertible }] : []
  return [...head, ...groups.values()]
}

export default function FieldMigrateV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <FieldMigrate />
    </Suspense>
  )
}

function FieldMigrate() {
  const saveErrors = useSaveFormErrors()
  const staffRole = useStaffRole()
  usePageTitle('種類を変える')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'タグ', href: '/tags' }, { label: '友だち情報欄', href: '/tags?tab=fields' }])
  const params = useSearchParams()
  const sourceId = params.get('id') ?? ''
  const { selectedAccountId } = useAccount()
  const [fields, setFields] = useState<FriendField[]>([])
  const [targetMode, setTargetMode] = useState<'new' | 'existing'>('new')
  const [targetName, setTargetName] = useState('')
  const [targetKey, setTargetKey] = useState('')
  const [targetType, setTargetType] = useState<FriendFieldType>('text')
  const [existingTargetId, setExistingTargetId] = useState('')
  /** 新規モードで作成済みの移行先。作ったあとは入力ではなくこの実体を使う。 */
  const [createdTarget, setCreatedTarget] = useState<FriendField | null>(null)
  const [preview, setPreview] = useState<FriendFieldMigrationPreview | null>(null)
  /** 実行は確認と同じ証票で1回だけ。確認が成立した時点で発行する。 */
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const [run, setRun] = useState<FriendFieldMigrationRun | null>(null)
  /*
   * R548: 実行POSTを受け付けたrun。結果がまだ無くても「移行を実行する」
   * には戻さない（同じ実行の再取得・再開で続ける）。
   */
  const [executedRunId, setExecutedRunId] = useState<string | null>(null)
  /** 結果の取得に失敗・停滞したときの説明。再取得・再開の入口と一緒に出す。 */
  const [pollProblem, setPollProblem] = useState('')
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState('')
  /*
    ATTR-11: 一覧の取得失敗は「移行元が見つかりません」とは別の状態。
    読み込みに失敗しただけで項目が消えたわけではないので、
    再試行できる失敗として出す。
  */
  const [loadError, setLoadError] = useState('')
  /** 権限なしの失敗（見ること自体ができない）。通信の失敗とは分ける。 */
  const [loadForbidden, setLoadForbidden] = useState(false)

  /*
    ATTR-10: 確認中に種類・名前・移行先を変えても、古い確認結果が
    新しい条件の下に表示されてはいけない。要求世代で照合し、
    入力が変わった時点で飛んでいる確認を無効にする。
  */
  const gateRef = useRef(createResponseGate())
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    if (!selectedAccountId) {
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setLoadError('')
    setLoadForbidden(false)
    void api.friendFields.list(selectedAccountId, { withUsage: true })
      .then((res) => {
        if (!active) return
        if (!res.success) throw new ApiError(0, res.error, 'load_failed')
        setFields(res.data)
        const source = res.data.find((item) => item.id === sourceId)
        if (source) {
          setTargetName(`${source.name}（新）`)
          setTargetKey(`${source.fieldKey}_new`.slice(0, 32))
          // 絵は「1つ選ぶ」を選んだ状態。同じ種類への移行は意味が無いので、今と違う種類から始める。
          setTargetType(source.type === 'select' ? 'text' : 'select')
        }
      })
      .catch((reason) => {
        // ATTR-11: 失敗は loadError へ。項目未発見（!source）と混ぜない。
        if (!active) return
        if (reason instanceof ApiError && reason.status === 403) {
          setLoadError(permissionDeniedMessage('store'))
          setLoadForbidden(true)
        } else {
          setLoadError('項目を読み込めませんでした')
        }
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selectedAccountId, sourceId, reloadTick])

  /*
    アカウント・移行元が変わったら、確認結果・実行状態・作った項目の
    選択をすべて捨てる。前のアカウントの実行状況が残ると、いまの
    アカウントで起きていない移行が「完了」と見える。
  */
  /*
   * R519: 同じ移行先の作り直しは同じ要求キーで送る。入力を変えたら
   * 新しいキーにする（同じキーに異なる内容はサーバが409で止める）。
   */
  const createKeyRef = useRef<string>(crypto.randomUUID())
  useEffect(() => {
    createKeyRef.current = crypto.randomUUID()
  }, [targetName, targetKey, targetType])

  useEffect(() => {
    gateRef.current.invalidate()
    setPreview(null)
    setIdempotencyKey(null)
    setRun(null)
    setExecutedRunId(null)
    setPollProblem('')
    setCreatedTarget(null)
    createKeyRef.current = crypto.randomUUID()
    /*
      TECH-07: 飛んでいる確認・実行を捨てたら、ボタンの「確認中…
      実行中…」も捨てる。世代を止めてもフラグが残ると、
      いつまでも押せない画面になる。
    */
    setChecking(false)
    setExecuting(false)
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
  }, [selectedAccountId, sourceId])

  const source = useMemo(() => fields.find((item) => item.id === sourceId) ?? null, [fields, sourceId])
  const existingTarget = useMemo(
    () => fields.find((item) => item.id === existingTargetId) ?? null,
    [fields, existingTargetId],
  )
  const target: FriendField | null = targetMode === 'existing' ? existingTarget : createdTarget

  /** 対象の入力を変えたら、確認結果は今の条件のものではなくなる。 */
  const resetConfirmation = () => {
    gateRef.current.invalidate()
    setPreview(null)
    setIdempotencyKey(null)
    setRun(null)
    setExecutedRunId(null)
    setPollProblem('')
  }

  /*
   * R519: 移行先を作るか、作り済みを取り直す。
   *
   * 応答だけ失った再試行は同じ要求キーで送るため、サーバは保存済みを
   * 返す。要求キーが変わった後の差し込み名の重複では、作成済みを
   * 取り直して比べる。同一内容ならその移行先で事前確認を続け、
   * 異なる内容なら衝突として説明する。
   */
  const createTargetOrRecover = async (account: string, token: number): Promise<FriendField | null> => {
    if (!source) return null
    const params = {
      name: targetName.trim() || `${source.name}（新）`,
      fieldKey: targetKey.trim() || `${source.fieldKey}_new`.slice(0, 32),
      type: targetType,
    }
    try {
      const created = await api.friendFields.create(account, params, createKeyRef.current)
      if (!created.success) throw new Error(created.error)
      if (!gateRef.current.current(token) || accountRef.current !== account) return null
      setCreatedTarget(created.data)
      setFields((current) => (current.some((item) => item.id === created.data.id) ? current : [...current, created.data]))
      return created.data
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)
      try {
        const res = await api.friendFields.list(account);

        if (res.success) {
          const existing = res.data.find((item) => item.fieldKey === params.fieldKey) ?? null
          if (existing && existing.name === params.name && existing.type === params.type) {
            if (!gateRef.current.current(token) || accountRef.current !== account) return null
            setCreatedTarget(existing)
            setFields((current) => (current.some((item) => item.id === existing.id) ? current : [...current, existing]))
            return existing
          }
        }
      } catch (saveFailure) {
        saveErrors.capture(saveFailure) /* 取り直せないときは下の説明へ */ }
      if (!gateRef.current.current(token) || accountRef.current !== account)


 return null
      const status = (reason as { status?: number } | null)?.status
      if (status === 409) {
        { if (!fieldFailure)
        setError(`同じ差し込み名「${params.fieldKey}」の別の項目があります。一覧を確認してください`)
      }
      } else {
        { if (!fieldFailure)
        setError(withPermissionFailure(reason, describeSaveFailure(reason), 'store')) }
      }
      return null
    }
  }

  const runPreview = async () => {
    if (!source || !selectedAccountId || checking) return
    setChecking(true); setError(''); setPreview(null); setRun(null)
    // 確認のやり直しは新しい出発にする。実行中の見守りは捨てる。
    setExecutedRunId(null); setPollProblem('')
    const token = gateRef.current.begin()
    const account = selectedAccountId
    try {
      let targetField = target
      // 新規モードでは、実行できる確認（期限付き証票）に項目の実体が要るので先に作る。
      if (!targetField && targetMode === 'new') {
        targetField = await createTargetOrRecover(account, token)
        if (!targetField) return
      }
      if (!targetField) {
        saveErrors.fail('existingTargetId','移行先の項目を選んでください')
        return
      }
      const res = await api.friendFields.migrationPreview(source.id, account, { targetFieldId: targetField.id })
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      if (!res.success) throw new Error(res.error)
      setPreview(res.data)
      setIdempotencyKey(crypto.randomUUID())
    } catch (reason) {
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      const fieldFailure = saveErrors.capture(reason)
      { if (!fieldFailure)

      setError(describeApiFailure(reason, '事前確認')) }
    } finally {
      if (gateRef.current.current(token) && accountRef.current === account) setChecking(false)
    }
  }

  /*
   * R548: 結果の取得失敗は黙殺しない。実行そのものは壊さないが、
   * 失敗をはっきり出し、同じrunの再取得・再開へつなげる。
   * R547: 上限で止まったまま「実行中」にしない。理由と入口を出す。
   */
  const pollRun = (runId: string, account: string, token: number, attempt: number) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    pollTimerRef.current = setTimeout(() => {
      void api.friendFields.migrationRun(runId, account)
        .then((res) => {
          if (!gateRef.current.current(token) || accountRef.current !== account) return
          if (res.success) {
            setRun(res.data)
            if (RUN_RUNNING.has(res.data.status)) {
              if (attempt < 20) {
                pollRun(runId, account, token, attempt + 1)
              } else {
                setPollProblem('まだ実行中です。結果の再取得か、止まっている場合の再開ができます。')
              }
            } else {
              setPollProblem('')
            }
          }
        })
        .catch(() => {
          if (!gateRef.current.current(token) || accountRef.current !== account) return
          setPollProblem('移行の結果を確認できませんでした。通信を確かめて、結果を確認し直してください。')
        })
    }, attempt === 0 ? 0 : 2000)
  }

  const execute = async () => {
    if (!source || !selectedAccountId || !preview?.previewToken || !idempotencyKey || executing) return
    setExecuting(true); setError(''); setPollProblem('')
    const token = gateRef.current.begin()
    const account = selectedAccountId
    try {
      const res = await api.friendFields.migrationExecute(source.id, account, preview.previewToken, idempotencyKey)
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      if (!res.success) throw new Error(res.error)
      setExecutedRunId(res.data.runId)
      pollRun(res.data.runId, account, token, 0)
    } catch (reason) {
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      const fieldFailure = saveErrors.capture(reason)
      { if (!fieldFailure)

      setError(fieldMigrationFailureMessage(reason, 'start')) }
    } finally {
      if (gateRef.current.current(token) && accountRef.current === account) setExecuting(false)
    }
  }

  /** R548: 同じrunの結果を取り直す。完了していれば結果へ戻れる。 */
  const refetchRun = () => {
    if (!selectedAccountId || !executedRunId || executing) return
    setPollProblem('')
    pollRun(executedRunId, selectedAccountId, gateRef.current.begin(), 0)
  }

  /*
   * R547: 止まった実行を続きから再開する。新しい要求キーで送るため、
   * サーバは受け付け済みの実行を再開する（D036）。終わっている実行の
   * 再開は409になるので、そのときは結果を取り直して見せる。
   */
  const resume = async () => {
    if (!source || !selectedAccountId || !preview?.previewToken || !executedRunId || executing) return
    setExecuting(true); setError(''); setPollProblem('')
    const token = gateRef.current.begin()
    const account = selectedAccountId
    try {
      const res = await api.friendFields.migrationExecute(source.id, account, preview.previewToken, crypto.randomUUID())
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      if (!res.success) throw new Error(res.error)
      setExecutedRunId(res.data.runId)
      pollRun(res.data.runId, account, token, 0)
    } catch (reason) {
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      const fieldFailure = saveErrors.capture(reason)
      try {
        const current = await api.friendFields.migrationRun(executedRunId, account);

        if (!gateRef.current.current(token) || accountRef.current !== account) return
        if (current.success) {
          setRun(current.data)
          { if (!fieldFailure)
          setPollProblem('') }
          return
        }
      } catch (saveFailure) {
        saveErrors.capture(saveFailure) /* 下の説明へ */ }
      { if (!fieldFailure)

      setError(fieldMigrationFailureMessage(reason, 'resume')) }
    } finally {
      if (gateRef.current.current(token) && accountRef.current === account) setExecuting(false)
    }
  }

  useEffect(() => () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current) }, [])


  /*
   * 見本の表（絵の「今の値 → 移したあと・人数」）。移行後の種類だけで事前確認を読む。
   * 種類だけの事前確認はサーバーで何も書き込まない（移行先が無いので確認番号も出ない）。
   */
  const sampleType: FriendFieldType | null = targetMode === 'existing' ? (existingTarget?.type ?? null) : (createdTarget?.type ?? targetType)
  const [sample, setSample] = useState<FriendFieldMigrationPreview | null>(null)
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const sampleGateRef = useRef(createResponseGate())
  useEffect(() => {
    if (!source || !selectedAccountId || !sampleType) {
      setSample(null)
      setSampleState('idle')
      return
    }
    const token = sampleGateRef.current.begin()
    const account = selectedAccountId
    setSampleState('loading')
    void api.friendFields.migrationPreview(source.id, account, { targetType: sampleType })
      .then((res) => {
        if (!sampleGateRef.current.current(token) || accountRef.current !== account) return
        if (!res.success) throw new Error(res.error)
        setSample(res.data)
        setSampleState('ready')
      })
      .catch(() => {
        if (!sampleGateRef.current.current(token) || accountRef.current !== account) return
        setSample(null)
        setSampleState('error')
      })
  }, [source, selectedAccountId, sampleType])

  if (loading) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" description="友だち情報欄を読み込んでいます" /></SaveErrorScope>
  if (!sourceId) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="unspecified"
        title="移行する項目が指定されていません"
        description="一覧から移行する項目を選び直してください。"
        backHref="/tags?tab=fields"
        backLabel="友だち情報欄の一覧へ戻る"
      /></SaveErrorScope>
    )
  }
  if (!selectedAccountId) return (
    <SaveErrorScope errors={saveErrors}><Notice tone="warn" action={<Button href="/tags?tab=fields">友だち情報欄の一覧へ戻る</Button>}>
      LINE公式アカウントを選んでください。
    </Notice></SaveErrorScope>
  )
  /* 「読み込めなかった」と「移行元が無い」を分ける（ATTR-11）。 */
  if (loadForbidden) {
    return (
      <SaveErrorScope errors={saveErrors}><ListState
        kind="forbidden"
        title="友だち情報欄を見る権限がありません"
        description={permissionDeniedMessage('store')}
        action={<Button href="/tags?tab=fields">友だち情報欄の一覧へ戻る</Button>}
      /></SaveErrorScope>
    )
  }
  if (loadError) return (
    <SaveErrorScope errors={saveErrors}><TargetMissing
      kind="error"
      title="項目を読み込めませんでした"
      description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
      onRetry={() => setReloadTick((tick) => tick + 1)}
    /></SaveErrorScope>
  )
  if (!source) return (
    <SaveErrorScope errors={saveErrors}><TargetMissing
      kind="not-found"
      title="移行元の項目が見つかりません"
      description="削除されたか、リンクが古くなっています。友だち情報欄の一覧から選び直してください。"
      backHref="/tags?tab=fields"
      backLabel="友だち情報欄の一覧へ戻る"
    /></SaveErrorScope>
  )

  const confirmed = Boolean(preview?.previewToken)
  const running = executing || (run ? RUN_RUNNING.has(run.status) : false)
  /* 取得の失敗・停滞で人の手が必要なときだけ、同じ実行の再取得・再開を出す（R547・R548）。 */
  const needsPollAction = executedRunId !== null && !executing && pollProblem !== ''
    && (!run || RUN_RUNNING.has(run.status))
  const pollAttention = pollProblem !== '' && (!run || RUN_RUNNING.has(run.status))
  const status = pollAttention ? pollProblem : run ? knownValue(RUN_STATUS_LABELS, run.status, '状態を確認できません') : executedRunId ? '実行を受け付けました。結果を確認しています' : confirmed ? `事前確認済み：${preview?.summary.total ?? 0} 人` : undefined
  const usage = typeof source.usageCount === 'number' ? `${formatNumber(source.usageCount)} 人に値が入っている` : '値が入っている人数は未集計'
  const back = <></>
  const rows = sample ? sampleRows(sample) : []

  if (staffRole !== null && !canManageRole(staffRole)) return <SaveErrorScope errors={saveErrors}><ReadOnlyNotice>閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice></SaveErrorScope>

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="GobMd"
      title={`「${source.name}」の種類を変える`}
      help={`今の種類：${knownValue(FIELD_TYPE_WORDS, source.type, '種類を確認できません')}・${usage}`}
      identity={back}
      status={status}
      footerActions={<>
        <Button href="/tags?tab=fields">キャンセル</Button>
        {confirmed && !executedRunId ? (
          <Button type="button" onClick={() => void runPreview()} busyLabel="確認しています…" disabled={checking || running}>確認をやり直す</Button>
        ) : null}
        {confirmed && !executedRunId ? (
          <Button variant="primary" type="button" onClick={() => void execute()} disabled={executing || running} busy={running} busyLabel="実行中…">移行を実行する</Button>
        ) : null}
        {needsPollAction ? (
          <Button type="button" onClick={() => void refetchRun()} disabled={executing}>結果を確認する</Button>
        ) : null}
        {needsPollAction ? (
          <Button variant="primary" type="button" onClick={() => void resume()} disabled={executing} busy={executing} busyLabel="再開中…">続きから再開する</Button>
        ) : null}
        {!confirmed ? (
          <Button variant="primary" type="button" onClick={() => void runPreview()} disabled={checking || (!target && targetMode === 'existing' && !existingTargetId)} busy={checking} busyLabel="確認しています…">
            {targetMode === 'new' && !createdTarget ? '項目を作って事前確認' : '事前確認する'}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : null}
      </>}
    >
      <Notice tone="info">
        種類を変えると、合わない値は空になることがあります。まず新しい種類の項目を作って、値がどう移るかを事前に確かめます。今の項目はそのまま残ります。
      </Notice>
      {error ? <Notice tone="danger" message={error} /> : null}

      <Card variant="form" gap="normal" aria-labelledby="migrate-target">
        <CardHeader title="移行の先" titleId="migrate-target" />
        {targetMode === 'new' && !createdTarget ? (
          <div ><Field label={<span>移行後の種類</span>}>

            <span className={styles.selectBox}>
              <SaveErrorField names={["targetType","type","target_type"]}><Select
                value={targetType}
                onChange={(value) => { setTargetType(value as FriendFieldType); resetConfirmation() }}
                aria-label="移行後の種類"
                size="full"
                options={TYPES.map((type) => ({ value: type, label: FIELD_TYPE_WORDS[type] }))}
              /></SaveErrorField>
            </span>
          </Field></div>
        ) : null}

        <DataTable label="値の移り方の見本">
          <thead><TableHeadRow>
            <Th truncate>今の値</Th>
            <Th truncate>移したあと</Th>
            <Th truncate align="right">人数</Th>
          </TableHeadRow></thead>
          <tbody>
          {sampleState === 'loading' ? <Tr><Td colSpan={3}><TruncatedText value="値の移り方を確かめています…" /></Td></Tr> : null}
          {sampleState === 'error' ? <Tr><Td colSpan={3}><TruncatedText value="値の移り方を確かめられませんでした。「項目を作って事前確認」で確かめられます。" /></Td></Tr> : null}
          {sampleState === 'ready' && rows.length === 0 ? <Tr><Td colSpan={3}><TruncatedText value="値が入っている友だちはいません。" /></Td></Tr> : null}
          {rows.map((row) => (
            <Tr key={`${row.from}:${row.to}`}>
              <Td><TruncatedText value={row.from} /></Td>
              <Td><TruncatedText value={row.to} /></Td>
              <Td align="right"><TruncatedText value={`${formatNumber(row.count)} 人`} /></Td>
            </Tr>
          ))}
          </tbody>
        </DataTable>

        {target ? (
          <div ><Field label={<span>移行先の項目</span>}>

            <p className={styles.cardNote}>{`${target.name}（{{field.${target.fieldKey}}}・${knownValue(FIELD_TYPE_WORDS, target.type, '種類を確認できません')}）`}</p>
            <span>
              <Button type="button" variant="text" onClick={() => { setCreatedTarget(null); setExistingTargetId(''); resetConfirmation() }}>別の項目を選び直す</Button>
            </span>
          </Field></div>
        ) : (
          <>
            <SaveErrorField names={["targetMode"]}><SegmentedControl
              aria-label="移行先の決め方"
              options={[{ value: 'new' as const, label: '新しい項目を作る' }, { value: 'existing' as const, label: '今ある項目へ移す' }]}
              value={targetMode}
              onChange={(value) => { setTargetMode(value); resetConfirmation() }}
            /></SaveErrorField>
            {targetMode === 'new' ? (
              <SettingsFormRow layout="name-folder">
                <Field label="新しい項目の名前"><SaveErrorField names={["targetName","name","target_name"]}><TextField value={targetName} onChange={(event) => { setTargetName(event.target.value); resetConfirmation() }} /></SaveErrorField></Field>
                <Field label="差し込みの名前"><SaveErrorField names={["targetKey","fieldKey","target_key"]}><TextField value={targetKey} onChange={(event) => { setTargetKey(event.target.value); resetConfirmation() }} /></SaveErrorField></Field>
              </SettingsFormRow>
            ) : (
              <div ><Field label={<span>移行先</span>}>

                <span className={styles.selectBox}>
                  <SaveErrorField names={["existingTargetId","targetFieldId","existing_target_id"]}><EntitySelect
                    value={existingTargetId}
                    onChange={(value) => { setExistingTargetId(value); resetConfirmation() }}
                    aria-label="移行先の既存項目"
                    size="full"
                    options={[
                      { value: '', label: '項目を選ぶ' },
                      ...fields.filter((field) => field.id !== source.id).map((field) => ({ ...entityOptionMetadata(field), value: field.id, label: `${field.name}（${knownValue(FIELD_TYPE_WORDS, field.type, '種類を確認できません')}）` })),
                    ]}
                  /></SaveErrorField>
                </span>
              </Field></div>
            )}
          </>
        )}
        {targetMode === 'new' && !createdTarget ? <p className={styles.fieldNote}>{FIELD_TYPE_HINTS[targetType]}</p> : null}
      </Card>

      {preview ? (
        <Card variant="form" gap="normal" aria-labelledby="migrate-preview">
          <CardHeader title="事前確認の結果" titleId="migrate-preview" meta="登録済みの値を読み取り、移せる数だけを確かめました。まだ何も変えていません。" />
          <CreateSummaryCard title="値の移行" rows={[
            { label: '値がある友だち', value: `${formatNumber(preview.summary.total)} 人` },
            { label: 'そのまま移せる', value: `${preview.summary.convertible} 人` },
            { label: '人が確認する', value: `${preview.summary.review} 人` },
            { label: '空欄', value: `${preview.summary.invalid} 人` },
          ]} />
          {preview.usageTargets.length > 0 ? (
            <CreateSummaryCard title="切り替わる使用先" rows={preview.usageTargets.map(item => ({
              key: `${item.kind}:${item.id}`,
              label: <TruncatedText value={item.name} />,
              value: item.switchable ? '移行のときに切り替わる' : '手で確かめる',
            }))} />
          ) : <Notice tone="info" message="切り替えが必要な使用先はありません。" />}
          {preview.runId && preview.previewExpiresAt ? <p className={styles.fieldNote}>{`確認番号：${preview.runId} ／ 有効期限：${formatDateTime(preview.previewExpiresAt)}`}</p> : null}
        </Card>
      ) : null}

      {/* 実行を受け付けたのに結果がまだ無い間は「未確認」と出し、再取得・再開へつなげる（R548）。 */}
      {!run && executedRunId ? (
        <Card variant="form" gap="normal" aria-live="polite">
          <CardHeader title="移行の結果" meta={pollProblem || '実行を受け付けました。結果を確認しています…'} />
        </Card>
      ) : null}
      {run ? (
        <Card variant="form" gap="normal" aria-live="polite">
          <CreateSummaryCard title="移行の結果" description={knownValue(RUN_STATUS_LABELS, run.status, '状態を確認できません')} rows={[
            { label: '移行できた', value: `${formatNumber(run.summary.succeeded)} 人` },
            { label: '移行できなかった', value: `${formatNumber(run.summary.failed)} 人` },
            { label: '確認が必要なまま', value: `${run.summary.review + run.summary.invalid} 人` },
          ]} />
          {run.rows.filter((row) => row.status === 'failed').map((row) => (
            <p key={row.friendId} className={styles.fieldError}>{`${row.sourceValue || '（空欄）'}：${row.reason ?? '失敗しました。通信を確かめて、もう一度お試しください。'}`}</p>
          ))}
          {run.error ? <Notice tone="danger" message={run.error} /> : null}
          {/* 元に戻す操作はまだ無い。戻す必要が出たときの行き先をはっきり書く。 */}
          {run.rollbackDeadline ? <p className={styles.fieldNote}>{`元の項目の値は ${formatDateTime(run.rollbackDeadline)} まで残ります。元に戻す必要がある場合は、この期限前に運用へ相談してください。`}</p> : null}
        </Card>
      ) : null}
    </CreatePage></SaveErrorScope>
  )
}
