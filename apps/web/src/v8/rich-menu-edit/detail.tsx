'use client'

import { useFeatureAccess } from '@/lib/use-feature-access';
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import { useSamePageUrl } from '@/lib/use-same-page-url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, CircleCheck, CircleX, GitBranch, Pencil, RefreshCw, ShieldCheck } from 'lucide-react';
import Link from '@/components/shared/list-navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import { api, ApiError, type RichMenuPublishRun, type RichMenuTargetPreview, type RichMenuDeleteImpact } from '@/lib/api';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { PageFrame, PageHeading } from '@/components/templates/page-frame';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import TargetMissing from '@/components/shared/target-missing'
import ListState from '@/components/shared/list-state'
import { richMenuError, richMenuErrorAll, unpublishWarningText } from '@/v8/rich-menus/public/errors/index'
import { audienceOf, progressStatusText, runAudienceText, runStamp, type ProgressStep, type ReconcileDiff } from './model';
import styles from './detail.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format';
import { permissionDeniedMessage } from '@/components/shared/api-error-message';
import { DetailLoading } from '@/components/templates/detail-page';
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { DetailColumns } from '@/components/templates/detail-columns'
import { ListPageSection } from '@/components/templates/list-page'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { notifySaved } from '@/components/shared/toast'

type Group = {
  id: string
  accountId: string
  name: string
  status: string
  version?: number
  isDefaultForAll: boolean
  targetingEnabled: boolean
  updatedAt?: string
  publicationGeneration?: number
  confirmationRevision?: number
}

export default function RichMenuDetailV8({ groupId }: { groupId: string }) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'リッチメニュー', href: '/rich-menus' }])
  const [group, setGroup] = useState<Group | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'forbidden' | 'error'>('loading')
  usePageTitle(group?.name ?? 'リッチメニュー')

  const role = useStaffRole()
  const canOperate = useFeatureAccess('richMenus')
  const canInspectOperations = canManageRole(role)
  const scope = useRef({ id: groupId, generation: 0 })
  if (scope.current.id !== groupId) scope.current = { id: groupId, generation: scope.current.generation + 1 }
  const operationPermission = useRef(canOperate && canInspectOperations)
  operationPermission.current = canOperate && canInspectOperations
  const confirmationContext = useRef({ groupId, permitted: operationPermission.current })
  if (confirmationContext.current.groupId !== groupId || confirmationContext.current.permitted !== operationPermission.current) confirmationContext.current = { groupId, permitted: operationPermission.current }
  const retryTicket = useRef<{ context: typeof confirmationContext.current } | null>(null)
  const unpublishTicket = useRef<{ context: typeof confirmationContext.current } | null>(null)
  const renderedRetryTicket = retryTicket.current
  const renderedUnpublishTicket = unpublishTicket.current
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; retryTicket.current = null; unpublishTicket.current = null } }, [])
  const groupGeneration = useRef(-1)
  const runsGeneration = useRef(-1)
  const diffsGeneration = useRef(-1)
  const [retryScope, setRetryScope] = useState<{ groupId: string; accountId: string; generation: number } | null>(null)
  const aggregateOnly = role === 'staff' || role === 'viewer'

  const [progress, setProgress] = useState<{ steps: ProgressStep[]; message: string | null; failed: boolean; completed: boolean } | null>(null)
  const [progressError, setProgressError] = useState(false)
  const [runs, setRuns] = useState<RichMenuPublishRun[] | null>(null)
  const [publishedRun, setPublishedRun] = useState<RichMenuPublishRun | null | undefined>(undefined)
  const [draftDiffers, setDraftDiffers] = useState<boolean | null>(null)
  const [runsError, setRunsError] = useState('')
  const [diffs, setDiffs] = useState<ReconcileDiff[] | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [checking, setChecking] = useState(false)
  const [asideExpanded, setAsideExpanded] = useState(false)
  const [checkError, setCheckError] = useState('')
  const [fixOpen, setFixOpen] = useState(false)
  const [fixScope, setFixScope] = useState<{ groupId: string; accountId: string; generation: number } | null>(null)
  const [fixing, setFixing] = useState(false)
  const [preview, setPreview] = useState<Pick<RichMenuTargetPreview, 'effective'> | null>(null)
  const [taps, setTaps] = useState<number | null | undefined>(undefined)

  const [retryTarget, setRetryTarget] = useState<RichMenuPublishRun | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [republishing, setRepublishing] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [unpublishOpen, setUnpublishOpen] = useState(false)
  const unpublishRequest = useRef(0)
  const [unpublishScope, setUnpublishScope] = useState<{ groupId: string; accountId: string; generation: number } | null>(null)
  const [unpublishing, setUnpublishing] = useState(false)
  const [unpublishImpact, setUnpublishImpact] = useState<RichMenuDeleteImpact | null>(null)
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [dialogError, setDialogError] = useState('')

  const loadGroup = useCallback(async () => {
    const generation = scope.current.generation
    setLoadState('loading')
    try {
      const res = await api.richMenuGroups.get(groupId)
      if (generation !== scope.current.generation) return
      if (!res.success || !res.data) {
        setLoadState('missing')
        return
      }
      const data = res.data as unknown as Group
      // 下書きは見せる物が無い。直す画面（ウィザードの手順①）へ。
      if (data.status !== 'published') {
        samePageUrl.replace(`/rich-menus/edit?id=${encodeURIComponent(groupId)}&step=shape`)
        return
      }
      groupGeneration.current = generation
      setGroup(data)
      setLoadState('ready')
    } catch (caught) {
      if (generation !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setLoadState(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : caught instanceof ApiError && caught.status === 404 ? 'missing' : 'error')
    }
  }
  }, [groupId, samePageUrl, saveErrors]);

  const loadProgress = useCallback(async () => {
    try {
      const res = await api.richMenuGroups.publishProgress(groupId)
      if (!res.success || !res.data || !Array.isArray(res.data.steps)) throw new Error('progress')
      setProgress({ steps: res.data.steps, message: res.data.message, failed: res.data.run?.status === 'failed', completed: res.data.run?.status === 'succeeded' || res.data.run?.status === 'done' })
      setProgressError(false)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (!(caught instanceof ApiError && caught.status === 403)) { if (!fieldFailure) setProgressError(true)
    }
  }
  }, [groupId, saveErrors]);

  const loadRuns = useCallback(async () => {
    const generation = scope.current.generation
    try {
      const res = await api.richMenuGroups.publishRuns(groupId)
      if (generation !== scope.current.generation) return
      if (!res.success || !res.data || !Array.isArray(res.data.runs)) throw new Error('runs')
      runsGeneration.current = generation
      setRuns(res.data.runs)
      setPublishedRun(res.data.published)
      setDraftDiffers(res.data.draftDiffersFromPublished ?? null)
      setRunsError('')
    } catch (caught) {
      if (generation !== scope.current.generation) return
      runsGeneration.current = -1
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setRunsError(caught instanceof ApiError && caught.status === 403 ? permissionDeniedMessage('store') : '公開の履歴を読み込めませんでした。')
    }
  }
  }, [groupId, saveErrors])

  /* 照合：読むだけ（dryRun）。ずれを並べ、直すかは運用者が決める（K-2）。 */
  const check = useCallback(async () => {
    const generation = scope.current.generation
    setChecking(true)
    setCheckError('')
    try {
      const res = await api.richMenuGroups.reconcile(groupId, true)
      if (!alive.current || generation !== scope.current.generation) return
      if (!res.success || !res.data || !Array.isArray(res.data.diffs)) throw new Error('reconcile')
      diffsGeneration.current = generation
      setDiffs(res.data.diffs)
      setCheckedAt(new Date())
    } catch (saveFailure) {
      if (!alive.current || generation !== scope.current.generation) return
      diffsGeneration.current = -1
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setCheckError('LINEとの照合ができませんでした。時間をおいてもう一度お試しください。') }
    } finally {
      if (alive.current && generation === scope.current.generation) setChecking(false)
    }
  }, [groupId, saveErrors])

  useEffect(() => { setRetryTarget(null); setRetryScope(null); setRetrying(false); setFixOpen(false); setFixScope(null); setFixing(false); setUnpublishOpen(false); setUnpublishScope(null); setUnpublishing(false); void loadGroup() }, [loadGroup])
  useEffect(() => {
    if (loadState !== 'ready' || !canInspectOperations) return
    void loadProgress()
    void loadRuns()
    void check()
  }, [loadState, canInspectOperations, loadProgress, loadRuns, check])
  useEffect(() => {
    if (!group || role === null) return
    let cancelled = false
    setPreview(null)
    const request = aggregateOnly ? api.richMenuGroups.audienceSummary(group.id) : api.richMenuGroups.previewTargets(group.id)
    void request.then((res) => { if (!cancelled && res.success) setPreview(res.data) }).catch(() => {})
    void api.richMenuGroups.tapStats(group.accountId).then((res) => {
      if (cancelled) return
      setTaps(res.success ? res.data.byGroup.find((row) => row.groupId === group.id)?.taps ?? 0 : null)
    }).catch(() => { if (!cancelled) setTaps(null) })
    return () => { cancelled = true }
  }, [group, role, aggregateOnly])

  const latestRun = useMemo(() => (runs ?? []).find((run) => run.status !== 'running') ?? null, [runs])
  const latestSucceeded = useMemo(() => (runs ?? []).find((run) => run.status === 'succeeded') ?? null, [runs])
  const currentPublished = publishedRun === undefined ? latestSucceeded : publishedRun
  const publishedInfo = currentPublished
    ? `いま対象に出ている版: 「${currentPublished.version.name ?? '（名前なし）'}」${currentPublished.version.pageCount !== null ? `・${currentPublished.version.pageCount}ページ` : ''}・${runAudienceText(currentPublished)}・${runStamp(currentPublished.updatedAt)} に公開${draftDiffers === false ? '。編集中の下書きは公開中の版と同じです。' : ''}`
    : 'いま対象に出ている版はありません（まだ公開に成功していません）。'

  const reloadAll = useCallback(async () => {
    await Promise.all([loadGroup(), loadProgress(), loadRuns()])
  }, [loadGroup, loadProgress, loadRuns])

  /* 公開が途中で止まったときの「もう一度公開する」。保存済みの下書きのまま公開し直す。 */
  const republish = async () => {
    if (republishing) return
    setRepublishing(true)
    setActionError('')
    try {
      const res = await api.richMenuGroups.publish(groupId, crypto.randomUUID())
      if (!res.success) throw new Error(res.error)
      setNotice('もう一度公開しました。公開の進みを確かめてください。')
      await reloadAll()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setActionError(caught instanceof ApiError && caught.status === 409
        ? 'ほかの人が先に公開・編集しました。読み直してから、もう一度お試しください。'
        : '公開できませんでした。時間をおいてもう一度お試しください。') }
    } finally {
      setRepublishing(false)
    }
  }

  /* 失敗した公開だけのやり直し（保存された版のまま。新しい版は作らない）。 */
  const retry = async () => {
    if (!alive.current || !retryTarget || !retryScope || retryScope.generation !== scope.current.generation || !operationPermission.current || retrying) return
    const generation = retryScope.generation
    setRetrying(true)
    setDialogError('')
    try {
      const res = await api.richMenuGroups.retryPublishRun(retryScope.groupId, retryTarget.id)
      if (!alive.current || generation !== scope.current.generation) return
      if (!res.success) throw new Error(res.error)
      retryTicket.current = null; setRetryTarget(null)
      setNotice('失敗した公開をやり直しました。最新の状態を確かめてください。')
      await reloadAll()
    } catch (caught) {
      if (generation !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setDialogError(caught instanceof ApiError && caught.status === 409
        ? 'すでにやり直されたか、新しい公開があります。読み直して確かめてください。'
        : 'やり直せませんでした。時間をおいてもう一度お試しください。') }
    } finally {
      if (generation === scope.current.generation) setRetrying(false)
    }
  }

  /* 照合で見つかったずれを直す（確かめてから）。 */
  const fix = async () => {
    if (!alive.current || !fixScope || fixScope.generation !== scope.current.generation || !operationPermission.current || fixing) return
    const generation = fixScope.generation
    setFixing(true)
    setDialogError('')
    try {
      const res = await api.richMenuGroups.reconcile(fixScope.groupId, false)
      if (!alive.current || generation !== scope.current.generation) return
      if (!res.success) throw new Error(res.error)
      setFixOpen(false)
      const unapplied = res.data.unapplied ?? []
      setNotice(`ずれを ${res.data.applied ?? 0} 件修復しました。${unapplied.length > 0 ? `取り込みが必要なずれが ${polishFormatNumber(unapplied.length)} 件あります。「LINEにだけあるメニュー」は「外部メニューの取り込み」画面で取り込んでください。` : ''}`)
      await check()
      await loadRuns()
    } catch (saveFailure) {
      if (!alive.current || generation !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDialogError('ずれを直せませんでした。時間をおいてもう一度お試しください。') }
    } finally {
      if (alive.current && generation === scope.current.generation) setFixing(false)
    }
  }

  const unpublish = async () => {
    if (!alive.current || !unpublishScope || unpublishScope.generation !== scope.current.generation || !operationPermission.current || unpublishing || !unpublishImpact || unpublishImpact.group.id !== unpublishScope.groupId || unpublishImpact.group.accountId !== unpublishScope.accountId || unpublishImpact.group.status !== 'published' || !Number.isSafeInteger(unpublishImpact.group.version) || !Number.isSafeInteger(unpublishImpact.group.publishingGeneration) || typeof unpublishImpact.lineResources.isDefaultForAll !== 'boolean' || !Array.isArray(unpublishImpact.lineResources.pages)) return
    const generation = unpublishScope.generation
    setUnpublishing(true)
    setDialogError('')
    try {
      const res = await api.richMenuGroups.unpublish(unpublishScope.groupId, {expectedVersion:unpublishImpact.group.version!,expectedPublishGeneration:unpublishImpact.group.publishingGeneration!,expectedIsDefaultForAll:unpublishImpact.lineResources.isDefaultForAll,expectedPages:unpublishImpact.lineResources.pages!})
      if (!alive.current || generation !== scope.current.generation) return
      if (!res.success) throw new Error(res.error)
      const warningTexts = [...new Set((res.data?.warnings ?? []).map(unpublishWarningText))]
      if (warningTexts.length > 0) {
        setDialogError(`LINE上のメニュー登録を取り下げました。ただし、${warningTexts.join(' / ')}。最新の状態を確認して、もう一度お試しください。`)
        return
      }
      unpublishTicket.current = null; setUnpublishOpen(false)
      router.push('/rich-menus')
    } catch (caught) {
      if (!alive.current || generation !== scope.current.generation) return
      if (caught instanceof ApiError && caught.status === 409) { unpublishTicket.current = null; setUnpublishOpen(false); setUnpublishImpact(null); setNotice('公開内容が変わりました。最新の状態を確認してください。'); await loadGroup(); return }
      const fieldFailure = saveErrors.capture(caught)
      if (!fieldFailure) setDialogError(richMenuError(caught, 'unpublish'))
    } finally {
      if (alive.current && generation === scope.current.generation) setUnpublishing(false)
    }
  }

  const duplicate = async () => {
    if (duplicating) return
    setDuplicating(true)
    setDialogError('')
    try {
      const res = await api.richMenuGroups.duplicate(groupId, crypto.randomUUID())
      if (!res.success) throw new Error(res.error)
      setDuplicateOpen(false)
      notifySaved('下書きを複製しました')
      router.push(`/rich-menus/edit?id=${encodeURIComponent(res.data.id)}&step=shape`)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setDialogError(richMenuErrorAll(caught, 'duplicate')) }
    } finally {
      setDuplicating(false)
    }
  }

  if (loadState === 'forbidden') {
    return <SaveErrorScope errors={saveErrors}><ListState kind="forbidden"
      permissionScope="store"
      action={<Button href="/rich-menus">リッチメニュー一覧へ戻る</Button>} /></SaveErrorScope>
  }
  if (loadState === 'missing') {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="このリッチメニューは見つかりません" description="削除されたか、別の LINE アカウントのものです。一覧から選び直してください。" backHref="/rich-menus" backLabel="リッチメニュー一覧へ戻る" /></SaveErrorScope>
  }
  if (loadState === 'error') {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="error" title="リッチメニューを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => void loadGroup()} /></SaveErrorScope>
  }
  const backLink = <></>
  if (!group) return <SaveErrorScope errors={saveErrors}><div className={styles.loadingHead}>{backLink}<DetailLoading /></div></SaveErrorScope>

  const audience = audienceOf(group)
  const head = currentPublished ? `公開しました・${runStamp(currentPublished.updatedAt)}` : '公開中'
  const failed = progress?.failed === true
  const menuItems: ActionMenuItem[] = [
    { id: 'duplicate', label: '複製する', onSelect: () => { setDialogError(''); setDuplicateOpen(true) } },
    { id: 'unpublish', label: 'LINEから取り下げる', onSelect: () => { if (!group.accountId || group.id !== groupId || groupGeneration.current !== scope.current.generation || !operationPermission.current) return; setDialogError(''); unpublishTicket.current = { context: confirmationContext.current }; setUnpublishImpact(null); const generation = scope.current.generation; const request = ++unpublishRequest.current; setUnpublishScope({ groupId, accountId: group.accountId, generation }); setUnpublishOpen(true); void api.richMenuGroups.deleteImpact(groupId).then(result => { if (!alive.current || generation !== scope.current.generation || request !== unpublishRequest.current) return; if (result.success && result.data.group.version !== group.version) { unpublishTicket.current = null; setUnpublishOpen(false); setNotice('公開内容が変わりました。最新の状態を確認してください。'); void loadGroup(); return }; if (result.success && result.data.group.id === groupId && result.data.group.accountId === group.accountId && result.data.group.status === 'published' && result.data.group.version === group.version && Number.isSafeInteger(result.data.group.version) && Number.isSafeInteger(result.data.group.publishingGeneration) && typeof result.data.lineResources.isDefaultForAll === 'boolean' && Array.isArray(result.data.lineResources.pages)) setUnpublishImpact(result.data); else setDialogError('公開内容を確認できません。閉じてもう一度お試しください。') }).catch(() => { if (alive.current && generation === scope.current.generation && request === unpublishRequest.current) setDialogError('公開内容を確認できません。閉じてもう一度お試しください。') }) } },
    { id: 'delete', label: '削除する', tone: 'danger', dividerBefore: true, disabled: true, disabledReason: '公開中は消せません。先にLINEから取り下げてください', onSelect: () => {} },
  ]

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.page} data-design-node="hKr8f">
      <PageFrame kind="detail" heightMode="content">
        <PageHeading title={group.name} identity={backLink} help={head} />
        <ListPageSection><DetailColumns presentation="notification" asideLabel="いまの状態と操作" expanded={asideExpanded} onExpandedChange={setAsideExpanded} aside={<>

            {canOperate ? (
              <div className={styles.sideActions}>
                <Button href={`/rich-menus/edit?id=${encodeURIComponent(group.id)}&step=shape`} variant="secondary"><Pencil size={16} aria-hidden="true" />編集する</Button>
                <Button href={`/rich-menus/connections?id=${encodeURIComponent(group.id)}`} variant="secondary"><GitBranch size={16} aria-hidden="true" />切替のつながり</Button>
                <RowMenu label="そのほかの操作" menuLabel={`リッチメニュー「${group.name}」の操作`} items={menuItems} />
              </div>
            ) : (
              <div className={styles.sideActions}>
                <Button href={`/rich-menus/connections?id=${encodeURIComponent(group.id)}`} variant="secondary"><GitBranch size={16} aria-hidden="true" />切替のつながり</Button>
              </div>
            )}
            {canOperate || role === null ? null : <div className={styles.roBand}><ReadOnlyNotice role="note">閲覧のみで見ています。編集・取り下げは管理者の操作です。</ReadOnlyNotice></div>}
            <section className={styles.aboutBox} aria-label="いまの状態">
              <h2 className={styles.aboutTitle}>いまの状態</h2>
              <dl className={styles.aboutList}>
                <div className={styles.aboutRow}><dt>状態</dt><dd><StatusBadge tone="success">公開中</StatusBadge></dd></div>
                <div className={styles.aboutRow}><dt>出す相手</dt><dd>{audience === 'all' ? 'すべての友だち（既定）' : audience === 'targeted' ? '条件に当てはまる友だち' : '登録だけ（出す相手なし）'}</dd></div>
                <div className={styles.aboutRow}><dt>出る人</dt><dd>{preview?.effective.value == null ? '—' : `${polishFormatNumber(preview.effective.value)} 人`}</dd></div>
                <div className={styles.aboutRow}><dt>今月押された</dt><dd>{taps === undefined ? '読み込み中…' : taps === null ? '—' : `${polishFormatNumber(taps)} 回`}</dd></div>
              </dl>
            </section>

</>}>
<div className={styles.content}>
            {failed ? (
              <Notice tone="danger" heading={<> 公開が途中で止まりました </>} action={<> {canOperate ? <Button variant="primary" onClick={() => void republish()} busy={republishing} busyLabel="公開しています…"><RefreshCw size={16} aria-hidden="true" />もう一度公開する</Button> : null} </>} >{progress?.message ?? 'それまでの段を元に戻し、前のメニューのままにしました。もう一度公開できます。'}</Notice>
            ) : progress?.completed ? (
                <Notice tone="success" role="status" icon={<CircleCheck size={20} aria-hidden="true" />} heading={<>{audience === 'all' ? 'LINEへの登録が終わり、すべての友だちの既定のメニューになりました' : audience === 'targeted' ? 'LINEへの登録が終わり、条件に当てはまる友だちに順に出ます' : 'LINEへの登録が終わりました'}</>}>
                  <p className={styles.bandNote}>
                    {audience === 'all'
                      ? '条件で出し分けている人には、いままでどおり上の順番のメニューが出ます。'
                      : audience === 'targeted'
                        ? 'その人に関係する出来事（友だち追加・タグ付けなど）が起きたときに切り替わります。すぐ全員に出るわけではありません。'
                        : '友だちの画面に出すには、一覧の「表示先」で出す相手を決めてください。'}
                  </p>
                </Notice>
            ) : null}
            {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
            {actionError ? <Notice tone="danger" >{actionError}</Notice> : null}

            {canInspectOperations ? <Card layout="vertical" contentPadding="var(--tpl-eds-card-pad)" gap="var(--tpl-eds-card-gap)" aria-label="公開の進み">
              <h2 className={styles.cardTitle}>公開の進み</h2>
              {progress && !progress.completed && !progress.failed && progress.message ? <p className={styles.cardNote}>{progress.message}</p> : null}
              {progressError ? <p className={styles.cardNote}>公開の進みを読み込めませんでした。</p> : progress === null ? <DetailLoading /> : progress.steps.length === 0 ? <p className={styles.cardNote}>まだ公開の記録はありません。</p> : progress.steps.map((step) => (
                <div key={step.key} className={styles.stepRow}>
                  {step.status === 'done' ? <CircleCheck size={20} aria-hidden="true" className={styles.stepOk} />
                    : step.status === 'failed' ? <CircleX size={20} aria-hidden="true" className={styles.stepNg} />
                      : <Circle size={20} aria-hidden="true" className={styles.stepQuiet} />}
                  <span className={styles.stepLabel}>{step.label}</span>
                  <span className={step.status === 'done' ? styles.stateOk : step.status === 'failed' ? styles.stateNg : styles.stateQuiet}>{progressStatusText(step.status)}</span>
                </div>
              ))}
            </Card> : null}

            {canInspectOperations ? <Card layout="vertical" contentPadding="var(--tpl-eds-card-pad)" gap="var(--tpl-eds-card-gap)" aria-label="公開の履歴とLINEとの照合">
              <div className={styles.cardTitles}>
                <h2 className={styles.cardTitle}>公開の履歴とLINEとの照合</h2>
                <p className={styles.cardNote} title={publishedInfo}>管理画面の記録と、LINE上の状態がずれていないかを見ます</p>
              </div>
              {!runsError && draftDiffers === true ? <Notice tone="warn" message="編集中の下書きは公開中の版と違います。公開すると、この下書きで上書きされます。" /> : null}
              <div className={styles.checkBox}>
                {!checkError && diffs !== null && diffs.length === 0 ? <ShieldCheck size={16} aria-hidden="true" className={styles.checkIcon} /> : null}
                <div className={styles.checkText}>
                  {checkError ? <span className={styles.errorText}>{checkError}</span>
                    : diffs === null ? <span>LINEと照らし合わせています…</span>
                      : diffs.length === 0 ? <span>{`管理画面の記録とLINE上の状態にずれはありませんでした${checkedAt ? `（${runStamp(checkedAt.toISOString(), true)}）` : ''}`}</span>
                        : (
                          <>
                            <span className={styles.diffTitle}>{`${polishFormatNumber(diffs.length)} 件のずれがあります`}</span>
                            <ul className={styles.diffList}>
                              {diffs.map((diff, index) => <li key={`${diff.kind}-${index}`}>{diff.detail}{diff.fix ? `（${diff.fix.label}）` : ''}</li>)}
                            </ul>
                          </>
                        )}
                </div>
                {diffs && diffs.length > 0 && canOperate ? (
                  <Button variant="secondary" onClick={() => { if (!group.accountId || group.id !== groupId || groupGeneration.current !== scope.current.generation || diffsGeneration.current !== scope.current.generation || !operationPermission.current) return; setDialogError(''); setFixScope({ groupId, accountId: group.accountId, generation: scope.current.generation }); setFixOpen(true) }}>ずれを直す</Button>
                ) : null}
                <Button variant="text" size="compact" onClick={() => void check()} disabled={checking} busy={checking} busyLabel="照らし合わせています…">
                  <RefreshCw size={16} aria-hidden="true" />もう一度照らし合わせる
                </Button>
              </div>
              {runsError ? <p className={styles.cardNote}>{runsError}</p> : runs === null ? null : runs.length === 0 ? <p className={styles.cardNote}>まだ公開の履歴はありません。</p> : (
                <div className={styles.runList}>
                  {runs.map((run) => (
                    <div key={run.id} className={styles.runRow}>
                      <span className={styles.runText} title={`${run.version.name ? `「${run.version.name}」・` : ''}${run.version.pageCount !== null ? `${run.version.pageCount}ページ・` : ''}LINE ID ${run.pages?.length ?? 0}件${run.status === 'failed' && run.lastErrorCode ? `・失敗理由: ${run.lastErrorCode.slice(0, 80)}` : ''}`}>{`${runStamp(run.createdAt)} ${runAudienceText(run)}`}</span>
                      <span className={styles.runSpacer} />
                      {run.status === 'failed' && canOperate && run.id === latestRun?.id ? (
                        <button type="button" className={styles.linkButton} onClick={() => { if (!group || group.id !== groupId || !group.accountId || groupGeneration.current !== scope.current.generation || runsGeneration.current !== scope.current.generation || !operationPermission.current) return; setDialogError(''); retryTicket.current = { context: confirmationContext.current }; setRetryScope({ groupId, accountId: group.accountId, generation: scope.current.generation }); setRetryTarget(run) }}>失敗だけやり直す</button>
                      ) : null}
                      <span className={run.status === 'succeeded' ? styles.stateOk : run.status === 'failed' ? styles.stateNg : styles.stateQuiet}>
                        {run.status === 'succeeded' ? '成功' : run.status === 'failed' ? '失敗' : '実行中'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card> : null}
          </div>
</DetailColumns></ListPageSection>
      </PageFrame>

      <ConfirmDialog
        open={retryTarget !== null && retryScope?.generation === scope.current.generation}
        title="失敗した公開をやり直しますか？"
        description={retryTarget ? `${runStamp(retryTarget.createdAt)} に失敗した公開を、保存された版のままやり直します。対象: ${runAudienceText(retryTarget)}。途中まで作成済みのものは続きから再開し、別の版や別の対象には適用しません。下書きが保存時から変わっている場合は、上書きを避けるため再試行せず止めます。` : ''}
        confirmLabel="やり直す"
        busy={retrying}
        error={dialogError || undefined}
        onConfirm={() => renderedRetryTicket && retryTicket.current === renderedRetryTicket && renderedRetryTicket.context === confirmationContext.current ? retry() : undefined}
        onCancel={() => { if (!retrying) { retryTicket.current = null; setRetryTarget(null) } }}
      >
        {retryScope ? <OperationTargetSummary accounts={[{ id: retryScope.accountId }]} /> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={fixOpen && fixScope?.generation === scope.current.generation}
        title="LINEとのずれを直しますか？"
        description="管理画面の記録に合わせて、LINE上のメニューを直します。直したあと、もう一度照らし合わせます。"
        confirmLabel="ずれを直す"
        busy={fixing}
        error={dialogError || undefined}
        onConfirm={() => fix()}
        onCancel={() => { if (!fixing) setFixOpen(false) }}
      >
        {fixScope ? <OperationTargetSummary accounts={[{ id: fixScope.accountId }]} /> : null}
        <ul className={styles.diffList}>{(diffs ?? []).map((diff, index) => <li key={`${diff.kind}-${index}`}>{diff.detail}{diff.fix ? `（${diff.fix.label}）` : ''}</li>)}</ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={unpublishOpen && unpublishScope?.generation === scope.current.generation}
        title={`「${group.name}」をLINEから取り下げますか？`}
        description={audience === 'all' ? 'すべての友だちの既定のメニューから外れます。ほかの既定のメニューが無ければ、メニューが出なくなる友だちがいます。下書きとして残ります。' : 'LINEから外し、下書きとして残します。'}
        confirmLabel="LINEから取り下げる"
        destructive
        busy={unpublishing}
        confirmDisabled={!unpublishImpact}
        confirmDisabledReason="公開内容を確認してください。"
        error={dialogError || undefined}
        onConfirm={() => renderedUnpublishTicket && unpublishTicket.current === renderedUnpublishTicket && renderedUnpublishTicket.context === confirmationContext.current ? unpublish() : undefined}
        onCancel={() => { if (!unpublishing) { unpublishTicket.current = null; unpublishRequest.current++; setUnpublishOpen(false) } }}
      >
        {unpublishScope ? <OperationTargetSummary accounts={[{ id: unpublishScope.accountId }]} /> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={duplicateOpen}
        title={`「${group.name}」を複製しますか？`}
        description="同じ形・画像・ボタンの動きの下書きを作ります。公開中のメニューは変わりません。"
        confirmLabel="複製する"
        busy={duplicating}
        error={dialogError || undefined}
        onConfirm={() => duplicate()}
        onCancel={() => { if (!duplicating) setDuplicateOpen(false) }}
      />
    </div></SaveErrorScope>
  )
}
