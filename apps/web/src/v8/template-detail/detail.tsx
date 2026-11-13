'use client'

import { useInsertTokenNames } from '@/lib/use-insert-token-names'
import { useFeatureAccess } from '@/lib/use-feature-access';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronDown, CircleAlert, Copy, GitCompare, List, Pencil, RotateCcw, Send, Upload } from 'lucide-react';
import Link from '@/components/shared/list-navigation'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { validateFlexContent } from '@line-crm/shared';
import { api, ApiError } from '@/lib/api';
import { useAccount } from '@/contexts/account-context';
import { usePageTitle } from '@/components/shell/page-chrome';
import { CreatePage } from '@/components/templates/create-page';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { TemplateDeleteDialog } from '@/v8/templates/public/delete-dialog/index'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import DialogUsageTable from '@/components/shared/dialog-usage-table'
import LinePreview, { LinePreviewFlex as FlexPreviewComponent, LinePreviewMessage } from '@/components/shared/line-preview';
import { InsertText } from '@/components/shared/insert-text-field';
import { buildTemplatePreview, EMPTY_TEMPLATE_REFERENCES } from '../../components/templates/template-preview-model'
import TargetMissing from '@/components/shared/target-missing'
import { buildUsageRows, insertionNames, isTemplateDetailData, lineChanges, messageTypeText, publishRowState, shortStamp, templateDeleteDescription, type TemplateDetailData, type TemplateVersionItem, type UsageRow } from './model';
import styles from './detail.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format';
import TruncatedText from '@/components/shared/truncated-text'
import Card, { CardHeader } from '@/components/shared/card'
import { RowNameLink } from '@/components/shared/table'
import TextLink from '@/components/shared/text-link'
import { emptyValue } from '@/components/shared/empty-value';
import { DetailLoading } from '@/components/templates/detail-page';
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import { ListEmptyMessage } from '@/components/shared/list-state'

/*
 * ★V8 テンプレートの詳細（一から書いた画面・2026-10-07）。
 * Pencil：詳細（未公開の変更あり）、削除できない窓 、公開の確かめ 、
 * 使っていないときの削除の確認 。
 *
 * 型は「作る」と同じ頭（戻る・名前・種類とフォルダ）＋左右の列。下の帯は無い（詳細なので）。
 * 動き（読み込み・公開・この版に戻す・削除の安全・権限）は今の画面（app/templates/detail）と同じ。
 * 受け付ける指定・呼ぶ API は BEHAVIOR.md。
 */

/** 表にまず見せる行数。残りは「ほか N か所を見る」で開く。 */
const USAGE_VISIBLE = 4
/** 窓にまず見せる行数（公開は4・削除できないは2。絵どおり）。 */
const PUBLISH_VISIBLE = 4
const BLOCKED_VISIBLE = 2

export default function TemplateDetailV8() {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  const { selectedAccountId, accounts } = useAccount()
  const scope = useRef({ id, accountId: selectedAccountId, generation: 0 })
  if (scope.current.id !== id || scope.current.accountId !== selectedAccountId) scope.current = { id, accountId: selectedAccountId, generation: scope.current.generation + 1 }
  const renderedScope = scope.current
  const loadedScope = useRef<typeof renderedScope | null>(null)
  const loadSequence = useRef(0)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const [template, setTemplate] = useState<TemplateDetailData | null>(null)
  const currentTemplate = useRef(template)
  currentTemplate.current = template
  const [versions, setVersions] = useState<TemplateVersionItem[] | null>(null)
  const [versionsError, setVersionsError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState(false)
  const [folderName, setFolderName] = useState<string | null>(null)
  const [monthlySends, setMonthlySends] = useState<number | null | undefined>(undefined)

  const [showAllUsages, setShowAllUsages] = useState(false)
  /** 「比べる」で開く差分。'draft' はいまの版と下書き、数字はその版といまの版。 */
  const [compareTarget, setCompareTarget] = useState<'draft' | number | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishScope, setPublishScope] = useState<typeof renderedScope | null>(null)
  const [publishVersion, setPublishVersion] = useState<{ ticket: object; publishedVersion: number; draftRevision: number } | null>(null)
  const publishTicket = useRef<object | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [revertTarget, setRevertTarget] = useState<number | null>(null)
  const [reverting, setReverting] = useState(false)
  const [revertError, setRevertError] = useState('')
  const [requestedDeleteOpen, setDeleteOpen] = useState(false)
  const [deleteScope, setDeleteScope] = useState<{ scope: typeof renderedScope; ticket: object } | null>(null)
  const deleteOpen = requestedDeleteOpen && deleteScope?.scope === scope.current
  const deleteTicket = useRef<object | null>(null)
  const deleteLock = useRef<object | null>(null)
  const [blockedOpen, setBlockedOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  useEffect(() => {
    deleteTicket.current = null; deleteLock.current = null
    setDeleteOpen(false); setDeleting(false); setDeleteError('')
    setPublishOpen(false); setPublishing(false); setPublishError(''); setPublishScope(null)
  }, [renderedScope])
  const [duplicating, setDuplicating] = useState(false)
  const [duplicateError, setDuplicateError] = useState('')
  const usageRef = useRef<HTMLDivElement>(null)

  /* N-144：編集・公開・削除の口は owner/admin だけ。閲覧のみには押せない操作を置かない（隠す）。 */
  const canMutate = useFeatureAccess('templates')
  const canMutateRef = useRef(canMutate); canMutateRef.current = canMutate
  usePageTitle(template?.name ?? null)

  const loadVersions = useCallback(async () => {
    if (!id || !mounted.current || renderedScope !== scope.current) return
    setVersionsError('')
    try {
      const res = await api.templates.versions(id)
      if (!mounted.current || renderedScope !== scope.current) return
      if (res.success) setVersions(res.data)
      else setVersionsError('版の履歴を読み込めませんでした。もう一度お試しください。')
    } catch (saveFailure) {
      if (!mounted.current || renderedScope !== scope.current) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setVersionsError('版の履歴を読み込めませんでした。もう一度お試しください。')
    }
  }
  }, [id, saveErrors, renderedScope]);


  const reload = useCallback(async () => {
    if (!mounted.current || renderedScope !== scope.current) return
    const sequence = ++loadSequence.current
    const current = () => mounted.current && renderedScope === scope.current && sequence === loadSequence.current
    setMissing(false)
    setError('')
    setTemplate(null)
    setVersions(null)
    setCompareTarget(null)
    setShowAllUsages(false)
    setLoading(true)
    try {
      const detail = await api.templates.get(id)
      if (!current()) return
      if (detail.success && isTemplateDetailData(detail.data)) { loadedScope.current = renderedScope; setTemplate(detail.data) }
      else if (!detail.success) setError('テンプレートを読み込めませんでした。もう一度お試しください。')
      else setMissing(true)
    } catch (caught) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 404) setMissing(true)
      else { if (!fieldFailure)
 setError('テンプレートを読み込めませんでした。もう一度お試しください。') }
    } finally {
      if (current()) setLoading(false)
    }
    if (current()) void loadVersions()
  }, [id, loadVersions, saveErrors, renderedScope])

  useEffect(() => {
    if (!id) {
      setLoading(false)
      return
    }
    void reload()
  }, [id, reload])

  /* フォルダ名と今月送った数は詳細口に無いので、持っている口で拾う。 */
  useEffect(() => {
    if (!selectedAccountId) return
    let cancelled = false
    api.folders.list('template', selectedAccountId).then((res) => {
      if (cancelled || !res.success) return
      setFolderName(res.data.find((folder) => folder.id === template?.folderId)?.name ?? null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selectedAccountId, template?.folderId])

  useEffect(() => {
    if (!selectedAccountId || !template) return
    let cancelled = false
    api.templates.list(undefined, selectedAccountId).then((res) => {
      if (cancelled || !res.success) return
      setMonthlySends(res.data.find((item) => item.id === template.id)?.monthlySendCount ?? null)
    }).catch(() => setMonthlySends(null))
    return () => { cancelled = true }
  }, [selectedAccountId, template])

  const usageRows = useMemo(() => buildUsageRows(template?.usedBy ?? null), [template])
  const usageCount = usageRows.length
  const latestCount = usageRows.filter((row) => !row.fixed).length
  const fixedCount = usageCount - latestCount
  const fixedBroadcasts = (template?.usedBy?.broadcasts ?? []).filter(
    (b) => (b.referenceMode === 'fixed' || b.templateVersionNumber !== null) && (b.status === 'scheduled' || b.status === 'sending'),
  ).length
  const inUseVersion = (versions ?? []).find((v) => v.status === 'in_use') ?? null
  const draftContent = template?.messageContent ?? ''
  const senderAccountId = template?.accountId ?? selectedAccountId
  const tokenNames = useInsertTokenNames(senderAccountId)
  const senderName = accounts.find((account) => account.id === senderAccountId)?.name ?? '公式アカウント'
  const nextVersionNumber = (template?.publishedVersion ?? 0) + 1

  const doPublish = useCallback(async () => {
    if (publishing || !template || !publishVersion || publishVersion.ticket !== publishTicket.current || !mounted.current || !canMutateRef.current || publishScope !== scope.current || loadedScope.current !== publishScope || template.id !== id || currentTemplate.current?.id !== id || (currentTemplate.current.publishedVersion ?? 0) !== publishVersion.publishedVersion || (currentTemplate.current.draftRevision ?? 0) !== publishVersion.draftRevision) return
    const current = () => mounted.current && publishScope === scope.current
    setPublishing(true)
    setPublishError('')
    try {
      const res = await api.templates.publish(id, {
        expectedVersion: publishVersion.publishedVersion,
        expectedDraftRevision: publishVersion.draftRevision,
      })
      if (!current()) return
      if (!res.success) throw new Error(res.error)
      publishTicket.current = null
      setPublishOpen(false)
      await reload()
    } catch (caught) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) {
        { if (!fieldFailure)
        setPublishError('ほかの人が先に公開・編集しました。最新の状態を読み直したので、内容を確かめてからもう一度お試しください。') }
        void reload()
      } else {
        { if (!fieldFailure)
        setPublishError('公開できませんでした。状態を読み直してから、もう一度お試しください。') }
      }
    } finally {
      if (current()) setPublishing(false)
    }
  }, [id, publishing, template, reload, saveErrors, publishScope, publishVersion])

  const doRevert = useCallback(async () => {
    if (reverting || revertTarget === null || !template) return
    setReverting(true)
    setRevertError('')
    try {
      const res = await api.templates.revert(id, { versionNumber: revertTarget, expectedVersion: template.publishedVersion })
      if (!res.success) throw new Error(res.error)
      setRevertTarget(null)
      setCompareTarget(null)
      await reload()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setRevertError(caught instanceof ApiError && caught.status === 409
        ? 'ほかの人が先に公開しました。開き直して確認してください。'
        : 'この版に戻せませんでした。状態を読み直してから、もう一度お試しください。')
    }
    } finally {
      setReverting(false)
    }
  }, [id, reverting, revertTarget, template, reload, saveErrors])

  const remove = useCallback(async () => {
    if (deleting || usageCount > 0 || !template) return
    if (deleteLock.current || !deleteScope || !mounted.current || !canMutateRef.current || deleteScope.scope !== scope.current || deleteScope.ticket !== deleteTicket.current || loadedScope.current !== deleteScope.scope || template.id !== id) return
    const current = () => mounted.current && canMutateRef.current && deleteScope.scope === scope.current && deleteScope.ticket === deleteTicket.current
    const lock = {}; deleteLock.current = lock; setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.templates.delete(id)
      if (!current()) return
      if (!res.success) throw new Error(res.error)
      deleteTicket.current = null
      setDeleteOpen(false)
      router.push('/templates')
    } catch (saveFailure) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteError('このテンプレートを削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (deleteLock.current === lock) deleteLock.current = null
      if (mounted.current && deleteScope.scope === scope.current) setDeleting(false)
    }
  }, [deleting, usageCount, template, id, router, saveErrors, deleteScope])

  /*
   * 複製：公開済みの版（いま使っている版）の中身で新しいテンプレートを作る。
   * 直しかけの下書きは写さない（公開前の中身が別の名前で出回らないように）。
   * 公開済みの版が無いときは押せる口を出さない。
   */
  const duplicate = useCallback(async () => {
    if (duplicating || !template || !inUseVersion || !selectedAccountId) return
    setDuplicating(true)
    setDuplicateError('')
    try {
      const res = await api.templates.create({
        accountId: selectedAccountId,
        name: `${template.name}のコピー`,
        category: template.category,
        messageType: inUseVersion.messageType ?? template.messageType,
        messageContent: inUseVersion.messageContent,
        folderId: template.folderId ?? null,
        ...(inUseVersion.carouselActions !== undefined ? { carouselActions: inUseVersion.carouselActions } : {}),
        ...(inUseVersion.carouselTapLimitMode === 'none' || inUseVersion.carouselTapLimitMode === 'once' ? { carouselTapLimitMode: inUseVersion.carouselTapLimitMode } : {}),
        ...(inUseVersion.carouselTapLimitText !== undefined ? { carouselTapLimitText: inUseVersion.carouselTapLimitText } : {}),
      })
      if (!res.success) throw new Error(res.error)
      router.push(`/templates/detail?id=${encodeURIComponent(res.data.id)}`)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDuplicateError('複製できませんでした。もう一度お試しください。') }
    } finally {
      setDuplicating(false)
    }
  }, [duplicating, template, inUseVersion, selectedAccountId, router, saveErrors])

  const openDelete = useCallback(() => {
    if (!mounted.current || !canMutateRef.current || renderedScope !== scope.current || loadedScope.current !== renderedScope || !template || template.id !== id || loading) return
    setDeleteError('')
    if (usageCount > 0) setBlockedOpen(true)
    else { const ticket = {}; deleteTicket.current = ticket; setDeleteScope({ scope: renderedScope, ticket }); setDeleteOpen(true) }
  }, [usageCount, renderedScope, template, id, loading])

  const showAllAndScroll = useCallback(() => {
    setBlockedOpen(false)
    setShowAllUsages(true)
    window.requestAnimationFrame(() => usageRef.current?.scrollIntoView({ block: 'start' }))
  }, [])

  if (!id) {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="unspecified" title="見るテンプレートが指定されていません" description="一覧から、見たいテンプレートを選び直してください。" backHref="/templates" backLabel="テンプレートの一覧へ戻る" /></SaveErrorScope>
  }
  if (missing || (!error && !loading && !template)) {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="このテンプレートは見つかりません" description="削除されたか、別の LINE アカウントのものです。一覧から選び直してください。" backHref="/templates" backLabel="テンプレートの一覧へ戻る" /></SaveErrorScope>
  }
  if (error || (!loading && !template)) {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="error" title="テンプレートを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => void reload()} /></SaveErrorScope>
  }

  const backLink = <></>
  if (loading || !template) {
    return (
      <SaveErrorScope errors={saveErrors}><div className={styles.page} data-design-node="UTbi1">
        <div className={styles.loadingHead}>{backLink}</div>
        <DetailLoading />
      </div></SaveErrorScope>
    )
  }

  const editHref = template.question
    ? `/templates/questions/new?id=${encodeURIComponent(id)}`
    : `/templates/edit?id=${encodeURIComponent(id)}${template.messageType === 'imagemap' && /"video"\s*:/.test(draftContent) ? '&kind=rich_video' : ''}`
  const folderLabel = folderName ?? (template.folderId ? template.category : '未分類')
  const insertions = insertionNames(draftContent)
  const visibleUsages = showAllUsages ? usageRows : usageRows.slice(0, USAGE_VISIBLE)
  const compareBefore = compareTarget === 'draft' ? inUseVersion?.messageContent ?? null : (versions ?? []).find((v) => v.versionNumber === compareTarget)?.messageContent ?? null
  const compareAfter = compareTarget === 'draft' ? draftContent : inUseVersion?.messageContent ?? null
  const publishDraftText = template.publishedVersion > 0
    ? `公開すると、使っている ${usageCount} か所のうち「いまの版」を使う ${latestCount} か所に新しい内容が使われます。`
      + (fixedBroadcasts > 0
        ? `版を決めて予約した一斉配信 ${fixedBroadcasts} 件は、決めた版のまま送ります。`
        : fixedCount > 0 ? `版を決めた ${fixedCount} か所は、決めた版のまま送ります。` : '')
    : '公開すると配信で選べるようになります。公開するまで使っている所は変わりません。'
  const menuItems: ActionMenuItem[] = [
    ...(usageCount > USAGE_VISIBLE ? [{ id: 'all-usages', label: '使っている所をすべて見る', onSelect: showAllAndScroll }] : []),
    { id: 'delete', label: '削除する', tone: 'danger' as const, dividerBefore: usageCount > USAGE_VISIBLE, onSelect: openDelete },
  ]
  const flexError = template.messageType === 'flex' ? validateFlexContent('flex', draftContent) : null

  const usageRow = (row: UsageRow) => (
    <div key={row.key} className={styles.usageRow}>
      <span className={styles.usageKind}>{row.kind}</span>
      {row.href
        ? <RowNameLink href={row.href} className={styles.usageName}><TruncatedText value={String(row.name ?? '')} /></RowNameLink>
        : <span className={styles.usageNameQuiet} title="旧形式・開ける画面がありません"><TruncatedText value={String(row.name ?? '')} /></span>}
      <span className={row.fixed ? styles.usageVersionFixed : styles.usageVersion} title={row.version}>{row.version}</span>
      <span className={styles.usageState}>{row.status ?? emptyValue('unknown')}</span>
      {row.href
        ? <TextLink external href={row.href}>使用画面へ</TextLink>
        : <span className={styles.ghostSpacer} aria-hidden="true" />}
    </div>
  )

  const compareBox = compareTarget !== null && compareBefore !== null && compareAfter !== null ? (
    <ChangeBox
      title={compareTarget === 'draft'
        ? `変わるところ（版${inUseVersion?.versionNumber ?? emptyValue('unknown')} → 下書き）`
        : `比べる（版${compareTarget} → いま使っている版${inUseVersion?.versionNumber ?? ''}）`}
      before={compareBefore}
      after={compareAfter}
    />
  ) : null

  const side = (
    <div className={styles.side}>
      {canMutate ? (
        <div className={styles.sideActions}>
          <Button href={`/broadcasts/new?templatePicker=1&templateId=${encodeURIComponent(id)}`} variant="secondary">
            <Send size={16} aria-hidden="true" />
            一斉配信で使う
          </Button>
          {inUseVersion ? (
            <Button variant="secondary" onClick={() => void duplicate()} busy={duplicating} busyLabel="複製しています…">
              <Copy size={16} aria-hidden="true" />
              複製する
            </Button>
          ) : null}
          <RowMenu appearance="box" label="そのほかの操作" menuLabel={`テンプレート「${template.name}」の操作`} items={menuItems} />
        </div>
      ) : null}
      {duplicateError ? <Notice tone="danger" >{duplicateError}</Notice> : null}
      <Card variant="aside" aria-label="このテンプレートについて">
        <CardHeader size="content" title="このテンプレートについて" />
        <dl className={styles.aboutList}>
          <div className={styles.aboutRow}><dt>種類</dt><dd>{messageTypeText(template.messageType)}</dd></div>
          <div className={styles.aboutRow}><dt>フォルダ</dt><dd>{folderLabel}</dd></div>
          <div className={styles.aboutRow}><dt>今月送った数</dt><dd>{monthlySends === undefined ? '読み込み中…' : monthlySends === null ? '—' : `${polishFormatNumber(monthlySends)} 通`}</dd></div>
          <div className={styles.aboutRow}><dt>差し込み</dt><dd title={insertions.join('・')}>{insertions.length > 0 ? insertions.join('・') : 'なし'}</dd></div>
        </dl>
      </Card>
      {flexError ? (
        <Notice tone="danger" heading={<> {flexError} </>} >このままでは公開できません。
            {canMutate ? <Link href={editHref} className={styles.inlineLink}>再編集で直してください。</Link> : 'オーナー・管理者に再編集を依頼してください。'}</Notice>
      ) : (
        <LinePreview title="届き方" accountName={senderName} note="受け取る人のLINEでの見え方です。{ } の差し込みは、送るときに受け取る人ごとの値に変わります。">
          {template.messageType === 'flex' ? <FlexPreviewComponent content={draftContent} /> : (
            <LinePreviewMessage accountName={senderName} avatar={senderName.slice(0, 1)} time="18:00">
              {buildTemplatePreview(draftContent, EMPTY_TEMPLATE_REFERENCES).content}
            </LinePreviewMessage>
          )}
        </LinePreview>
      )}
    </div>
  )

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.page} data-design-node="UTbi1">
      <DetailFrame
        title={template.name}
        identity={backLink}
        description={[messageTypeText(template.messageType), folderLabel, `更新 ${shortStamp(template.updatedAt)}`].join('・')}
        preview={side}
      >
        {canMutate ? null : <div className={styles.roBand}><ReadOnlyNotice role="note">閲覧のみで見ています。編集・公開・削除はオーナーか管理者に頼んでください。</ReadOnlyNotice></div>}
        {template.hasDraft ? (
          <Notice tone="warn" role="status" heading={template.publishedVersion > 0 ? '未公開の変更があります' : 'まだ公開していません'} icon={<CircleAlert size={16} aria-hidden="true" />} action={canMutate ? <>
            {inUseVersion ? <Button variant="secondary" onClick={() => setCompareTarget((current) => current === 'draft' ? null : 'draft')} aria-pressed={compareTarget === 'draft'} icon={<GitCompare aria-hidden="true" />}>比べる</Button> : null}
            <Button variant="primary" onClick={() => { if (loadedScope.current !== scope.current || template.id !== id) return; const ticket = {}; publishTicket.current = ticket; setPublishVersion({ ticket, publishedVersion: template.publishedVersion ?? 0, draftRevision: template.draftRevision ?? 0 }); setPublishScope(scope.current); setPublishError(''); setPublishOpen(true) }} icon={<Upload aria-hidden="true" />}>公開する</Button>
          </> : undefined}>{publishDraftText}</Notice>
        ) : null}
        {compareTarget === 'draft' ? compareBox : null}

        <Card variant="form" aria-label="本文">
          <CardHeader size="content" title={template.hasDraft ? '本文（下書き）' : '本文'} meta="緑の印は差し込み。受け取る人ごとに変わります。" action={canMutate ? <Button href={editHref} variant="secondary" icon={<Pencil aria-hidden="true" />}>編集する</Button> : undefined} />
          <div className={styles.bodyBox}>{template.messageType === 'text' ? <InsertText tokenNames={tokenNames} value={draftContent} /> : draftContent}</div>
        </Card>

        <div ref={usageRef}><Card variant="form" aria-label="使っている所">
          <CardHeader size="content" title="使っている所" meta={usageCount > 0
            ? `${usageCount} か所。「いまの版」を使う ${latestCount} か所に反映されます${fixedCount > 0 ? `（版を決めた ${fixedCount} か所は変わりません）` : ''}。`
            : 'どこからも呼ばれていません。使われると、ここに並びます。'} />
          {usageCount > 0 ? (
            <>
              {visibleUsages.map(usageRow)}
              {usageCount > USAGE_VISIBLE && !showAllUsages ? (
                <div className={styles.moreRow}>
                  <Button variant="text" onClick={() => setShowAllUsages(true)} icon={<ChevronDown aria-hidden="true" />}>ほか {usageCount - USAGE_VISIBLE} か所を見る</Button>
                </div>
              ) : null}
            </>
          ) : <ListEmptyMessage>まだ使われていません</ListEmptyMessage>}
        </Card></div>

        <Card variant="form" aria-label="版の履歴">
          <CardHeader size="content" title="版の履歴" meta="戻すと、その版を下書きとして作り直します。公開するまで使っている所は変わりません。" />
          {versions === null && !versionsError ? <DetailLoading /> : versionsError ? (
            <div className={styles.versionError}>
              <p className={styles.errorText}>{versionsError}</p>
              <Button variant="secondary" onClick={() => loadVersions()} busyLabel="処理中…">もう一度読み込む</Button>
            </div>
          ) : (
            <>
              {template.hasDraft ? (
                <div className={styles.versionDraft}>
                  <span className={styles.versionNum}>版{nextVersionNumber}</span>
                  <div className={styles.versionText}>
                    <p className={styles.versionLabel}>下書き（まだ公開していない）</p>
                    <p className={styles.versionMeta}>{shortStamp(template.updatedAt)}</p>
                  </div>
                  {inUseVersion ? (
                    <div className={styles.versionActions}>
                      <Button variant="secondary" onClick={() => setCompareTarget((current) => (current === 'draft' ? null : 'draft'))} icon={<GitCompare aria-hidden="true" />}>いまの版と比べる</Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {(versions ?? []).map((version) => (
                <div key={version.versionNumber} className={version.status === 'in_use' ? styles.versionInUse : styles.versionPast}>
                  <span className={styles.versionNum}>版{version.versionNumber}</span>
                  <div className={styles.versionText}>
                    <p className={styles.versionLabel}>
                      {version.status === 'in_use' ? 'いま使っている版'
                        : version.status === 'reserved' ? `予約した版（${version.effectiveFrom ? `${shortStamp(version.effectiveFrom)}から使う` : '予約中'}）` : '前の版'}
                    </p>
                    <p className={styles.versionMeta}>{`${version.creatorName ?? '作成者不明'}・${shortStamp(version.createdAt)}`}</p>
                  </div>
                  {version.status !== 'in_use' ? (
                    <div className={styles.versionActions}>
                      {inUseVersion ? (
                        <Button variant="secondary" onClick={() => setCompareTarget((current) => (current === version.versionNumber ? null : version.versionNumber))} icon={<GitCompare aria-hidden="true" />}>比べる</Button>
                      ) : null}
                      {canMutate ? (
                        <Button variant="secondary" onClick={() => { setRevertError(''); setRevertTarget(version.versionNumber) }}><RotateCcw size={16} aria-hidden="true" />この版に戻す</Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
              {versions?.length === 0 ? <ListEmptyMessage>版はまだありません。</ListEmptyMessage> : null}
              {typeof compareTarget === 'number' ? compareBox : null}
            </>
          )}
        </Card>
      </DetailFrame>

      {/* 公開の確かめ（cuR8I）：反映される所と変わるところを見せてから公開する。 */}
      <Dialog
        open={publishOpen && publishScope === scope.current}
        designNode="cuR8I"
        designWidth={640}
        designTop={226}
        title={`「${template.name}」を公開する`}
        description={`公開すると、下のうち「いまの版」を使う所で新しい内容（版${nextVersionNumber}）が使われます。版を決めた予約と、すでに送ったメッセージは変わりません。`}
        busy={publishing}
        error={publishError}
        onCancel={() => {
          if (publishing) return
          publishTicket.current = null
          setPublishOpen(false)
          setPublishError('')
        }}
        footer={(<DialogActions>
            <Button variant="secondary" onClick={() => { publishTicket.current = null; setPublishOpen(false); setPublishError('') }} disabled={publishing}>キャンセル</Button>
            <Button variant="primary" onClick={() => void doPublish()} busy={publishing} busyLabel="公開しています…" disabled={!publishVersion || (template.publishedVersion ?? 0) !== publishVersion.publishedVersion || (template.draftRevision ?? 0) !== publishVersion.draftRevision} disabledReason="内容が変わりました。閉じて確認し直してください。">
              <Upload size={16} aria-hidden="true" />
              {latestCount > 0 ? `公開する（${latestCount} か所に反映）` : '公開する'}
            </Button>
          </DialogActions>)}
      >
        <OperationTargetSummary accounts={[{ id: template.accountId ?? '', name: accounts.find(account => account.id === template.accountId)?.name }]} />
        <div className={styles.dialogBody}>
          {usageCount > 0 ? (
            <div className={styles.dialogList}>
              {usageRows.slice(0, PUBLISH_VISIBLE).map((row) => (
                <div key={row.key} className={styles.dialogRow}>
                  <span className={styles.usageKind}>{row.kind}</span>
                  <span className={styles.dialogName} ><TruncatedText value={String(row.name ?? '')} /></span>
                  <span className={styles.dialogState}>{publishRowState(row)}</span>
                </div>
              ))}
              {usageCount > PUBLISH_VISIBLE ? <p className={styles.dialogMore}>ほか {usageCount - PUBLISH_VISIBLE} か所</p> : null}
            </div>
          ) : null}
          {inUseVersion ? (
            <ChangeBox title={`変わるところ（版${inUseVersion.versionNumber} → 版${nextVersionNumber}）`} before={inUseVersion.messageContent} after={draftContent} />
          ) : null}
        </div>
      </Dialog>

      {/* 削除できない（Z0g3si）：使っている所があるうちは消さない。開いて差し替える口と、全部を見る口。 */}
      <Dialog
        open={blockedOpen}
        designNode="Z0g3si"
        designWidth={640}
        designTop={226}
        title={`「${template.name}」はまだ消せません`}
        description={`${usageCount} か所で使われています。消すと、その配信や自動応答が送れなくなるためです。先に別のテンプレートへ差し替えてください。`}
        onCancel={() => setBlockedOpen(false)}
        footer={(<DialogActions>
            <Button variant="secondary" onClick={() => setBlockedOpen(false)}>閉じる</Button>
            <Button variant="secondary" onClick={showAllAndScroll}><List size={16} aria-hidden="true" />使っている所をすべて見る</Button>
          </DialogActions>)}
      >
        <div className={styles.dialogList}>
          <DialogUsageTable rows={usageRows.slice(0, BLOCKED_VISIBLE)} />
          {usageCount > BLOCKED_VISIBLE ? <p className={styles.dialogMore}>ほか {usageCount - BLOCKED_VISIBLE} か所</p> : null}
        </div>
      </Dialog>

      {/* 使っていないときの削除の確認（V6JFnd）。 */}
      <TemplateDeleteDialog
        targetAccounts={[{ id: template.accountId ?? '', name: accounts.find(account => account.id === template.accountId)?.name }]}
        open={deleteOpen && usageCount === 0}
        title={`テンプレート「${template.name}」を削除しますか？`}
        description={templateDeleteDescription(usageCount)}
        busy={deleting}
        confirmLockedReason={canMutate ? undefined : 'テンプレートを変更する権限がありません。'}
        error={deleteError}
        onConfirm={() => remove()}
        onCancel={() => {
          if (deleting || !deleteScope || deleteScope.ticket !== deleteTicket.current) return
          deleteTicket.current = null
          setDeleteOpen(false)
          setDeleteError('')
        }}
      />

      <ConfirmDialog
        open={revertTarget !== null}
        title={`版${revertTarget}の内容で下書きを作り直しますか？`}
        description="過去の版は変わりません。その中身で新しい下書きを作ります。予約中・送信中の配信は、いま使っている版のままです。"
        confirmLabel="この版に戻す"
        busy={reverting}
        error={revertError}
        onConfirm={() => doRevert()}
        onCancel={() => {
          if (reverting) return
          setRevertTarget(null)
          setRevertError('')
        }}
      />
    </div></SaveErrorScope>
  )
}

/** 版の差（－ 消えた行・＋ 増えた行）。同じなら「違いはありません」。 */
export function ChangeBox({ title, before, after }: { title: string; before: string; after: string }) {
  const changes = lineChanges(before, after)
  return (
    <div className={styles.changeBox}>
      <p className={styles.changeTitle}>{title}</p>
      {changes.length === 0 ? <p className={styles.changeSame}>違いはありません</p> : changes.map((change, index) => (
        <p key={`${change.kind}-${index}`} className={change.kind === 'removed' ? styles.changeRemoved : styles.changeAdded}>
          {change.kind === 'removed' ? '－ ' : '＋ '}{change.text}
        </p>
      ))}
    </div>
  )
}

/** 本文と、同じ内容を窓でも読める右欄を型へ渡す。 */
export function DetailFrame({ title, identity, description, preview, children }: {
  title: string; identity: ReactNode; description: string; preview: ReactNode; children: ReactNode
}) {
  return (
    <CreatePage title={title} identity={identity} help={description} preview={preview} previewLabel="テンプレートの情報と届き方を見る" previewTitle="テンプレートの情報と届き方" footerActions={null}>
      {children}
    </CreatePage>
  )
}
