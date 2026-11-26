'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  siteDialog_label: requiredText("サイトの名前を入力してください"),
}


import CodeBlock from '@/components/shared/code-block'
import CopyTextButton from '@/components/shared/copy-text-button'
import Link from '@/components/shared/list-navigation'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { CircleHelp, Copy, Mail, Pause, Play, Plus, RefreshCw } from 'lucide-react'
import { ApiError, api, type MeasurementSite } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { formatNumber, formatDate as polishFormatDate } from '@/lib/format'
import { useResponseGate } from '@/lib/use-response-gate'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import HelpTip from '@/components/shared/help-tip'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { INFLOW_TABLE_LAYOUT } from './table-layout'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog from '@/components/shared/dialog'
import { RowMenu } from '@/components/shared/row-actions'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import { TextArea, TextField } from '@/components/shared/text-field'
import { DetailPage } from '@/components/templates'
import { focusField } from './focus-field'
import styles from './site-script.module.css'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'

/*
 * ★V8 サイトスクリプト（Pencil ）。
 *
 * 頭（戻る・題・説明・右下に「貼りかたが分からないときは」）→ 成果を数えるサイトの表（板いっぱい）→
 * 左の列（サイトに貼るコード・計測を許可するドメイン・閲覧の記録への同意）と右の列（いま届いているか・
 * どうやって友だちと結びつくか・つながる先）。
 *
 * 呼ぶ口・権限・失敗の扱いは今のサイトスクリプト（components/inflow-links/site-script-v8.tsx）と同じ
 * （BEHAVIOR.md の「サイトスクリプト」）。違うのは見せ方だけ：
 * - 行の「…」を押すと、そのサイトの「編集・止める・再開する」を共通メニューで開く
 * - 「貼りかたが分からないときは」は窓で開く（今は右の列のいちばん下の段）
 * - 閲覧のみ（owner・admin 以外）には、サイトを追加する・「…」を出さない
 */

type PageRow = { host: string | null; path: string; views: number; visitors: number }
type TrackingSummary = {
  todayEvents: number
  todayPageViews: number
  linkedEvents: number
  unlinkedEvents: number
  pathCount: number
  eventTypeCount: number
  lastEventAt: string | null
}
type SiteDialogState =
  | { mode: 'create'; label: string; domainsText: string; error: string | null }
  | { mode: 'edit'; site: MeasurementSite; label: string; domainsText: string; error: string | null }

/** 「10/1 21:14」の形（日本時間）。読めない値は出さない。 */
function formatShort(value: string | null | undefined): string | null {
  return polishFormatDate(value, { style: 'list', fallback: '' }) || null
}

const parseDomains = (text: string) => text.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean)

export default function SiteScriptV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('サイトスクリプト')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: '流入と計測', href: '/inflow-links' }])
  const role = useStaffRole()
  const readonly = !canManageRole(role)
  const { selectedAccountId } = useAccount()
  const [pages, setPages] = useState<PageRow[]>([])
  const [pagesFailed, setPagesFailed] = useState(false)
  const [pagesLoading, setPagesLoading] = useState(false)
  const [summary, setSummary] = useState<TrackingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [messageCopied, setMessageCopied] = useState(false)
  // アカウント別の計測鍵。取れるまで・取れないときはコードを出さない（固定の鍵を出すと他アカウントの計測が混ざる）。
  const [trackingKey, setTrackingKey] = useState<string | null>(null)
  const [keyLoading, setKeyLoading] = useState(true)
  const [keyAttempt, setKeyAttempt] = useState(0)
  const [sites, setSites] = useState<MeasurementSite[]>([])
  const [sitesFailed, setSitesFailed] = useState(false)
  const canManage = canManageRole(useStaffRole())
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null)
  const [siteDialog, setSiteDialog] = useState<SiteDialogState | null>(null)
  const [siteBusy, setSiteBusy] = useState(false)
  const [stopDialog, setStopDialog] = useState<{ site: MeasurementSite; reason: string; error: string | null } | null>(null)
  const depth = useContext(OverlayDepthContext)
  const siteChanged = siteDialog !== null && (siteDialog.mode === 'create'
    ? siteDialog.label !== '' || siteDialog.domainsText !== ''
    : siteDialog.label !== siteDialog.site.label || siteDialog.domainsText !== siteDialog.site.domains.join('\n'))
  const editingBusy = siteBusy && (siteDialog !== null || stopDialog !== null)
  const guard = useUnsavedGuard({
    dirty: siteChanged || Boolean(stopDialog?.reason) || editingBusy,
    busy: editingBusy,
    onDiscard: () => { setSiteDialog(null); setStopDialog(null) },
  })
  const [resumeTarget, setResumeTarget] = useState<MeasurementSite | null>(null)
  const [siteActionError, setSiteActionError] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? ''
  const snippet = trackingKey ? `<script async src="${apiUrl}/api/site/script.js" data-key="${trackingKey}"></script>` : null
  const manage = canManage && !readonly

  /*
   * WEB040：アカウントを切り替えたら、前のアカウントのサイト・集計・選択・開いた窓を捨て、
   * 前のアカウントの遅い応答・操作の結果を今の画面へ書かない。
   */
  const gate = useResponseGate()
  const loadInFlightRef = useRef(false)
  const pagesSeqRef = useRef(0)
  const pagesInFlightRef = useRef<number | null>(null)
  const accountRef = useRef(selectedAccountId)
  const previousAccountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  useEffect(() => () => {
    loadInFlightRef.current = false
    pagesSeqRef.current += 1
    pagesInFlightRef.current = null
  }, [])
  useEffect(() => {
    if (previousAccountRef.current === selectedAccountId) return
    previousAccountRef.current = selectedAccountId
    loadInFlightRef.current = false
    pagesSeqRef.current += 1
    pagesInFlightRef.current = null
    setPages([])
    setPagesFailed(false)
    setPagesLoading(false)
    setSummary(null)
    setSites([])
    setSitesFailed(false)
    setSelectedSiteId(null)
    setSiteDialog(null)
    setStopDialog(null)
    setResumeTarget(null)
    setSiteActionError('')
    setSiteBusy(false)
  }, [selectedAccountId])

  const load = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && loadInFlightRef.current) return
    loadInFlightRef.current = true
    const token = gate.begin()
    const pagesSeq = ++pagesSeqRef.current
    pagesInFlightRef.current = null
    setLoading(true)
    setFailed(false)
    setPagesFailed(false)
    setPagesLoading(false)
    try {
      const [pagesResult, summaryResult, sitesResult] = await Promise.allSettled([
        api.siteTracking.pages({ accountId: selectedAccountId ?? undefined }),
        api.siteTracking.summary(selectedAccountId ?? undefined),
        api.measurementSites.list(selectedAccountId ?? undefined),
      ])
      if (!gate.current(token)) return
      if (pagesSeq === pagesSeqRef.current) {
        if (pagesResult.status === 'fulfilled' && pagesResult.value.success && Array.isArray(pagesResult.value.data)) {
          setPages(pagesResult.value.data)
          setPagesFailed(false)
        } else {
          setPagesFailed(true)
        }
      }
      if (summaryResult.status === 'fulfilled' && summaryResult.value.success) setSummary(summaryResult.value.data)
      else setFailed(true)
      if (sitesResult.status === 'fulfilled' && sitesResult.value.success && Array.isArray(sitesResult.value.data)) {
        setSites(sitesResult.value.data)
        setSitesFailed(false)
      } else {
        setSitesFailed(true)
      }
    } finally {
      if (gate.current(token)) {
        loadInFlightRef.current = false
        setLoading(false)
      }
    }
  }, [selectedAccountId, gate])

  const reloadPages = useCallback(async () => {
    if (pagesInFlightRef.current !== null || loadInFlightRef.current) return
    const seq = ++pagesSeqRef.current
    const accountAtStart = selectedAccountId
    pagesInFlightRef.current = seq
    setPagesLoading(true)
    try {
      const res = await api.siteTracking.pages({ accountId: accountAtStart ?? undefined })
      if (seq !== pagesSeqRef.current || accountRef.current !== accountAtStart) return
      if (res.success && Array.isArray(res.data)) {
        setPages(res.data)
        setPagesFailed(false)
      } else {
        setPagesFailed(true)
      }
    } catch {
      if (seq === pagesSeqRef.current && accountRef.current === accountAtStart) {
        setPagesFailed(true)
      }
    } finally {
      if (pagesInFlightRef.current === seq) pagesInFlightRef.current = null
      if (seq === pagesSeqRef.current && accountRef.current === accountAtStart) setPagesLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    void load({ force: true })
  }, [load])

  useEffect(() => {
    let cancelled = false
    setKeyLoading(true)
    void api.siteTracking
      .trackingKey(selectedAccountId ?? undefined)
      .then((res) => {
        if (!cancelled) setTrackingKey(res.success && res.data.trackingKey ? res.data.trackingKey : null)
      })
      .catch(() => {
        if (!cancelled) setTrackingKey(null)
      })
      .finally(() => {
        if (!cancelled) setKeyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedAccountId, keyAttempt])

  const [siteFieldErrors, setSiteFieldErrors] = useState<Record<string, string>>({})
  const [stopReasonError, setStopReasonError] = useState('')

  const saveSite = async () => {
    if (!siteDialog) return
    const errors: Record<string, string> = {}
    if ((FIELD_REQUIREMENTS.siteDialog_label.check(siteDialog.label) !== null)) errors['site-name'] = 'サイトの名前を入力してください'
    if (!parseDomains(siteDialog.domainsText).length) errors['site-domains'] = '計測を許可するドメインを入力してください'
    setSiteFieldErrors(errors)
    setSiteDialog({ ...siteDialog, error: null })
    if (Object.keys(errors).length) { focusField(Object.keys(errors)[0]); return }
    const accountAtStart = selectedAccountId
    const moved = () => accountRef.current !== accountAtStart
    setSiteBusy(true)
    try {
      const domains = parseDomains(siteDialog.domainsText)
      if (siteDialog.mode === 'create') {
        const res = await api.measurementSites.create({ accountId: selectedAccountId ?? undefined, label: siteDialog.label, domains })
        if (!res.success) throw new Error(res.error || '作成できませんでした。時間をおいて、もう一度お試しください。')
      } else {
        const res = await api.measurementSites.update(siteDialog.site.id, { label: siteDialog.label, domains })
        if (!res.success) throw new Error(res.error || '更新できませんでした。時間をおいて、もう一度お試しください。')
      }
      if (moved()) return
      setSiteDialog(null)
      await load()
    } catch (err) {
      if (moved()) return
      saveErrors.capture(err);

      const message = describeApiFailure(err, '保存')
      const field = err instanceof ApiError && err.status === 400
        ? message.includes('ドメイン') ? 'site-domains' : message.includes('サイトの名前') ? 'site-name' : null
        : null
      if (field) {
        setSiteFieldErrors({ [field]: message })
        setSiteDialog({ ...siteDialog, error: null })
        focusField(field)
      } else {
        setSiteDialog({ ...siteDialog, error: message })
      }
    } finally {
      setSiteBusy(false)
    }
  }

  const stopSite = async () => {
    if (!stopDialog) return
    const accountAtStart = selectedAccountId
    const moved = () => accountRef.current !== accountAtStart
    const reason = stopDialog.reason.trim()
    if (!reason) {
      setStopDialog({ ...stopDialog, error: null })
      setStopReasonError('止める理由を入れてください')
      focusField('site-stop-reason')
      return
    }
    setSiteBusy(true)
    try {
      const res = await api.measurementSites.stop(stopDialog.site.id, reason)
      if (!res.success) throw new Error(res.error || '停止できませんでした。時間をおいて、もう一度お試しください。')
      if (moved()) return
      setStopDialog(null)
      setSiteActionError('')
      await load()
    } catch (err) {
      if (moved()) return
      saveErrors.capture(err)
      setStopDialog({ ...stopDialog, error: describeApiFailure(err, '保存') })
    } finally {
      setSiteBusy(false)
    }
  }

  const resumeSite = async () => {
    if (!resumeTarget) return
    const accountAtStart = selectedAccountId
    const moved = () => accountRef.current !== accountAtStart
    setSiteBusy(true)
    try {
      const res = await api.measurementSites.resume(resumeTarget.id)
      if (!res.success) throw new Error(res.error || '再開できませんでした。時間をおいて、もう一度お試しください。')
      if (moved()) return
      setResumeTarget(null)
      setSiteActionError('')
      await load()
      return true
    } catch (err) {
      if (moved()) return
      const fieldFailure = saveErrors.capture(err)
      { if (!fieldFailure)
      setSiteActionError(describeApiFailure(err, '保存')) }
      return false
    } finally {
      setSiteBusy(false)
    }
  }

  /** 制作会社へ送る文（コードつき）をコピーする。 */


  const receiving = summary?.lastEventAt != null
  const lastSeen = formatShort(summary?.lastEventAt)
  const allowedDomains = [...new Set(sites.filter((site) => site.stoppedAt == null).flatMap((site) => site.domains))]

  const sitesBody = sitesFailed ? (
    <p className={styles.note} role="status">
      計測サイトを読み込めませんでした。
      <button type="button" onClick={() => void load()} disabled={loading} className={styles.textLink}>もう一度読み込む</button>
    </p>
  ) : sites.length === 0 ? (
    <p className={styles.note}>まだサイトがありません。追加するとサイトごとの計測コードが出ます。</p>
  ) : (
    <>
      {siteActionError ? <Notice tone="danger" className={styles.noteNoticePlacement} >{siteActionError}</Notice> : null}
      <DataTable aria-label="成果を数えるサイト" columnLayout={INFLOW_TABLE_LAYOUT}><thead>
      <TableHeadRow data-table-layout="columns">
        <Th grow>サイト</Th>
        <Th className={styles.colDomain}>ドメイン</Th>
        <Th className={styles.colState}>状態</Th>
        <Th className={styles.colLast}>最後に届いた</Th>
        <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
      </TableHeadRow></thead><tbody>
      {sites.map((site) => {
        const stopped = site.stoppedAt != null
        const last = formatShort(site.lastReceivedAt)
        return (
          <Tr key={site.id} data-selected={selectedSiteId === site.id || undefined} data-table-layout="columns">
            <Td grow><span className={styles.siteName} title={site.label}>{site.label}</span></Td>
            <Td className={styles.colDomain}><span className={styles.cellText} title={site.domains.join('\n')}>{site.domains.join('、') || emptyValue('unknown')}</span></Td>
            <Td className={styles.colState}>
              {stopped ? (
                <StatusBadge tone="neutral" size="compact" title={site.stoppedReason ? `理由: ${site.stoppedReason}` : undefined}>停止中</StatusBadge>
              ) : (
                <StatusBadge tone="success" size="compact">{site.lastReceivedAt ? '届いている' : '受信待ち'}</StatusBadge>
              )}
            </Td>
            <Td className={styles.colLast}><span className={styles.cellText} title={`最後に受け取った時刻: ${site.lastReceivedAt ? polishFormatDate(site.lastReceivedAt, { style: 'detail', fallback: 'まだ受け取っていません' }) : 'まだ受け取っていません'}`}>{last ?? emptyValue('unknown')}</span></Td>
            <Td className={styles.colMenu}>
              {manage ? (
                <RowMenu
                  label={`「${site.label}」の操作`}
                  open={selectedSiteId === site.id}
                  onOpenChange={(open) => setSelectedSiteId(open ? site.id : null)}
                  items={[
                    { id: 'edit', label: '編集', onSelect: () => { setSiteFieldErrors({}); setSiteDialog({ mode: 'edit', site, label: site.label, domainsText: site.domains.join('\n'), error: null }) } },
                    ...(stopped
                      ? [{ id: 'resume', label: '再開する', icon: <Play size={16} aria-hidden />, onSelect: () => { setSiteActionError(''); setResumeTarget(site) } }]
                      : [{ id: 'stop', label: '止める', icon: <Pause size={16} aria-hidden />, onSelect: () => { setStopReasonError(''); setStopDialog({ site, reason: '', error: null }) } }]),
                  ]}
                />
              ) : null}
            </Td>
          </Tr>
        )
      })}
      </tbody></DataTable>
    </>
  )

  return (
    <SaveErrorScope errors={saveErrors}><DetailPage boardId="XjOte" title="サイトスクリプト" help="ホームページに1行貼ると、サイトを見た人と LINE の友だちを結びつけ、成果も数えられます。"
      contentPadding="var(--tpl-detail-head-pad-bottom) var(--tpl-head-pad-side)"
      actions={<Button onClick={() => setHelpOpen(true)}><CircleHelp size={16} aria-hidden="true" />貼りかたが分からないときは</Button>}>
      <div className={styles.body}>
        {readonly ? (
          <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
        ) : null}

        {loading && summary == null && !failed ? (
          <ListState kind="loading" title="サイトの計測状況を読み込んでいます" />
        ) : failed ? (
          <ListState
            kind="error"
            title="サイトの計測を読み込めませんでした"
            description={`${lastSeen ? `最後に受け取ったのは ${lastSeen} です。` : ''}タグが外れていないか、サイトの公開先が変わっていないかを確かめてください。`}
            onRetry={() => void load()}
          />
        ) : <>
          <Card variant="panel" contentPadding="var(--polish-space-card)" gap="var(--polish-space-field)" aria-labelledby="ss-sites">
            <h2 className={styles.cardTitle} id="ss-sites">{`成果を数えるサイト ${sites.length > 0 ? formatNumber(sites.length) : ''}`.trim()}</h2>
            <div className={styles.sitesLead}>
              <p className={styles.lead}>サイトごとにコードを分けます。止めたサイトの成果は数えません。</p>
              {manage ? (
                <Button onClick={() => { setSiteFieldErrors({}); setSiteDialog({ mode: 'create', label: '', domainsText: '', error: null }) }}>
                  <Plus size={16} aria-hidden="true" />サイトを追加する
                </Button>
              ) : null}
            </div>
            {sitesBody}
          </Card>

          <div className={styles.split}>
            <div className={styles.column}>
              <Card variant="aside" contentPadding="var(--polish-space-card)" gap="var(--polish-space-row)" aria-labelledby="ss-code">
                <h2 className={styles.cardTitle} id="ss-code">サイトに貼るコード</h2>
                <p className={styles.small}>ホームページの &lt;/head&gt; の直前に、この1行をそのまま貼ってください。ページごとに書き換える必要はありません。</p>
                {keyLoading ? (
                  <p className={styles.small}>あなたのアカウントのコードを取得しています…</p>
                ) : snippet ? (
                  <>
                    <CodeBlock wrap>{snippet}</CodeBlock>
                    {copyFailed ? <Notice tone="danger" className={styles.smallNoticePlacement} >コピーできませんでした。上のコードを選んでコピーしてください。</Notice> : null}
                    <div className={styles.buttons}>
                      <CopyTextButton variant="primary" icon={<Copy size={16} aria-hidden />} value={snippet ?? ""} label="コードをコピー" aria-label="コードをコピー" />
                      <CopyTextButton variant="secondary" icon={<Mail size={16} aria-hidden />} value={`ホームページの</head>の直前に、この1行をそのまま貼ってください。ページごとに書き換える必要はありません。\n${snippet}`} label="制作会社へ送る文をコピー" aria-label="制作会社へ送る文をコピー" />
                    </div>
                  </>
                ) : (
                  <>
                    <p className={styles.small}>計測コードを読み込めませんでした。アカウントごとの鍵が無いと他の計測と混ざるため、以前の共通の鍵は表示しません。通信状態を確かめて、もう一度お試しください。</p>
                    <div className={styles.buttons}>
                      <Button onClick={() => setKeyAttempt((n) => n + 1)}>コードをもう一度取得する</Button>
                    </div>
                  </>
                )}
              </Card>

              <Card variant="aside" contentPadding="var(--polish-space-card)" gap="var(--polish-space-row)" aria-labelledby="ss-domains">
                <h2 className={styles.cardTitle} id="ss-domains">計測を許可するドメイン</h2>
                <div className={styles.domainBox}>
                  {allowedDomains.length > 0
                    ? allowedDomains.map((domain) => <span key={domain} className={styles.domain}>{domain}</span>)
                    : <span className={styles.domainEmpty}>まだ許可したドメインがありません。</span>}
                </div>
                <p className={styles.faint}>このサイトから届いた成果だけを数えます。1行に1つ。www の有無は同じサイトとして扱います。</p>
              </Card>

              <Card variant="aside" contentPadding="var(--polish-space-card)" gap="var(--polish-space-row)" aria-labelledby="ss-consent">
                <h2 className={styles.cardTitle} id="ss-consent">閲覧の記録への同意（サイトの下に出る案内の見本）</h2>
                <div className={styles.consent} aria-label="お客さまのサイトに出る案内の見本">
                  <span className={styles.consentText}>広告の効果を知るため、この端末での閲覧を記録してよいですか？</span>
                  <span className={styles.mockButton}>記録しない</span>
                  <span className={`${styles.mockButton} ${styles.mockPrimary}`}>記録してよい</span>
                </div>
                <p className={styles.faint}>同意がなかった人は記録しません（「数えなかった」に入ります）。個人が特定できる情報は送りません。</p>
              </Card>
            </div>

            <div className={styles.rail}>
              <Card variant="aside" contentPadding="var(--polish-space-card)" gap="var(--polish-space-row)" aria-labelledby="ss-status">
                <h2 className={styles.cardTitle} id="ss-status" title={receiving ? `今日は ${formatNumber(summary?.todayEvents)}件、${formatNumber(summary?.pathCount)}種類のページから届いています。` : 'まだ受け取っていないため数字は出しません'}>いま届いているか</h2>
                <div className={styles.statusBlock}>
                  {receiving ? (
                    <>
                      <span><StatusBadge tone="success" size="compact">届いている</StatusBadge></span>
                      <p className={styles.faint}>{`最後に届いたのは ${lastSeen ?? emptyValue('unknown')}`}</p>
                    </>
                  ) : (
                    <>
                      <span><StatusBadge tone="neutral" size="compact">まだ届いていません</StatusBadge></span>
                      <p className={styles.faint}>コードを貼ったあと、サイトを開くと数分で表示されます。</p>
                    </>
                  )}
                  <span><Button onClick={() => void load()} disabled={loading} busy={loading} busyLabel="処理中…"><RefreshCw size={16} aria-hidden="true" />いま届いているか確かめる</Button></span>
                </div>
                {pagesFailed ? (
                  <Notice
                    tone="warn"
                    message="ページごとの表示を読み込めませんでした。上の確認は続けられます。"
                    action={
                      <Button
                        variant="text"
                        size="inline"
                        onClick={() => void reloadPages()}
                        disabled={pagesLoading || loading}
                        busy={pagesLoading}
                        busyLabel="読み込んでいます"
                      >
                        ページ表示を読み直す
                      </Button>
                    }
                  />
                ) : (
                  <DataTable aria-label="ページごとの表示" columnLayout={INFLOW_TABLE_LAYOUT}><thead>
                    <TableHeadRow data-table-layout="columns">
                      <Th grow>ページ</Th>
                      <Th className={styles.numCol} align="right">この30日のページ表示</Th>
                      <Th className={styles.numColNarrow} align="right">訪問者数<HelpTip label="訪問者数の説明">この30日にページを訪れた人数です。同じ訪問者は1人として数えます。LINEの友だち追加数は含みません。</HelpTip></Th>
                    </TableHeadRow></thead><tbody>
                    {pages.slice(0, 4).map((page) => (
                      <Tr key={`${page.host ?? ''}:${page.path}`} data-table-layout="columns">
                        <Td grow><span className={styles.cellSmall} title={page.host ? `${page.host}${page.path}` : page.path}>{page.path}</span></Td>
                        <Td className={styles.numCol} align="right">{formatNumber(page.views)}</Td>
                        <Td className={styles.numColNarrow} align="right">{formatNumber(page.visitors)}</Td>
                      </Tr>
                    ))}
                    {pages.length === 0 ? (
                      <Tr data-table-layout="columns">
                        <Td grow>同意なし</Td>
                        <Td className={styles.numCol} align="right">{emptyValue('unknown')}</Td>
                        <Td className={styles.numColNarrow} align="right">{emptyValue('unknown')}</Td>
                      </Tr>
                    ) : null}
                  </tbody></DataTable>
                )}
              </Card>

              <Card variant="aside" contentPadding="var(--polish-space-card)" gap="var(--polish-space-row)" aria-labelledby="ss-how">
                <h2 className={styles.cardTitle} id="ss-how">どうやって友だちと結びつくか</h2>
                <p className={styles.small}>1. LINE から開いた場合：その場で経路を記録します。</p>
                <p className={styles.small}>2. あとから LINE を追加した場合：同じブラウザの記録と結びつけます。</p>
                <p className={styles.small}>3. 結びつかない場合：個人を推測せず経路不明として数えます。</p>
              </Card>

              <Card variant="aside" contentPadding="var(--polish-space-card)" gap="var(--polish-space-row)" aria-labelledby="ss-links">
                <h2 className={styles.cardTitle} id="ss-links">つながる先</h2>
                <nav className={styles.links} aria-label="つながる先">
                  <Link href="/conversions" className={styles.goLink}>→ コンバージョン</Link>
                  <Link href="/analytics" className={styles.goLink}>→ 分析</Link>
                  <Link href="/friends" className={styles.goLink}>→ 友だち</Link>
                  <Link href="/inflow-links" className={styles.goLink}>→ 流入と計測</Link>
                </nav>
              </Card>
            </div>
          </div>
        </>}
      </div>

      <Dialog open={helpOpen} title="貼りかたが分からないときは" onCancel={() => setHelpOpen(false)} cancelLabel="閉じる">
        <dl className={styles.helpList}>
          <div><dt>WordPress をお使いなら</dt><dd>テーマの header.php か、コードを貼るプラグインに入れます</dd></div>
          <div><dt>Shopify をお使いなら</dt><dd>テーマの theme.liquid の &lt;/head&gt; の前に入れます</dd></div>
          <div><dt>制作会社にお願いするなら</dt><dd>このコードをそのまま送れば伝わります。書き換えは不要です（「制作会社へ送る文をコピー」が使えます）</dd></div>
        </dl>
      </Dialog>

      <Dialog
        open={siteDialog !== null}
        initialFocusId={Object.entries(siteFieldErrors).find(([, error]) => Boolean(error))?.[0]}
        title={siteDialog?.mode === 'edit' ? '計測サイトを直す' : '計測サイトを追加'}
        description="このサイトから届いた成果だけを数えます。ドメインは1行に1つずつ書きます（例：shop.example.com）。www の有無は同じサイトとして扱います。"
        busy={siteBusy}
        error={siteDialog?.error ?? undefined}
        confirmLabel={siteDialog?.mode === 'edit' ? '保存する' : '追加する'}
        onConfirm={() => saveSite()}
        onCancel={() => setSiteDialog(null)}
      >
        {siteDialog ? (
          <div className={styles.dialogFields}>
            <Field label="サイトの名前" requirement={FIELD_REQUIREMENTS.siteDialog_label}><SaveErrorField names={["label","siteDialog.label","site_dialog.label","site_dialog"]}><TextField id="site-name" aria-invalid={Boolean(siteFieldErrors['site-name'])} aria-describedby={siteFieldErrors['site-name'] ? 'site-name-error' : undefined} value={siteDialog.label} maxLength={100} placeholder="例：公式ショップ" onChange={(e) => { setSiteDialog({ ...siteDialog, label: e.target.value }); setSiteFieldErrors((old) => ({ ...old, 'site-name': '' })) }} /></SaveErrorField>
{siteFieldErrors['site-name'] ? <span id="site-name-error" className={styles.fieldError} role="alert">{siteFieldErrors['site-name']}</span> : null}</Field>
            <Field label="計測を許可するドメイン"><SaveErrorField names={["domainsText","siteDialog.domainsText","domains_text","site_dialog.domains_text","site_dialog"]}><TextArea id="site-domains" aria-invalid={Boolean(siteFieldErrors['site-domains'])} aria-describedby={siteFieldErrors['site-domains'] ? 'site-domains-error' : undefined} rows={4} value={siteDialog.domainsText} placeholder={'example.com\nshop.example.com'} onChange={(e) => { setSiteDialog({ ...siteDialog, domainsText: e.target.value }); setSiteFieldErrors((old) => ({ ...old, 'site-domains': '' })) }} /></SaveErrorField>
{siteFieldErrors['site-domains'] ? <span id="site-domains-error" className={styles.fieldError} role="alert">{siteFieldErrors['site-domains']}</span> : null}</Field>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={stopDialog !== null}
        title="このサイトの計測を止める"
        description="止めるとこのサイトから届く分は成果に数えません。いままで数えた記録は残り、あとから再開できます。止めた理由は履歴に残ります。"
        busy={siteBusy}
        error={stopDialog?.error ?? undefined}
        confirmLabel="計測を止める"
        onConfirm={() => stopSite()}
        onCancel={() => { if (!siteBusy) setStopDialog(null) }}
      >
        {stopDialog ? (
          <div className={styles.dialogFields}>
            <p className={styles.small}>{`対象: ${stopDialog.site.label}`}</p>
            <Field label="止める理由" required><SaveErrorField names={["reason","stopDialog.reason","stop_dialog.reason","stop_dialog"]}><TextField id="site-stop-reason" aria-invalid={Boolean(stopReasonError)} aria-describedby={stopReasonError ? 'site-stop-reason-error' : undefined} value={stopDialog.reason} maxLength={200} placeholder="例：サイトを閉じたため" onChange={(e) => { setStopDialog({ ...stopDialog, reason: e.target.value }); setStopReasonError('') }} /></SaveErrorField>
{stopReasonError ? <span id="site-stop-reason-error" className={styles.fieldError} role="alert">{stopReasonError}</span> : null}</Field>
          </div>
        ) : null}
      </Dialog>

      <OverlayDepthContext.Provider value={depth + 2}>
        <UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={editingBusy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
      </OverlayDepthContext.Provider>

      <ConfirmDialog
        open={resumeTarget !== null}
        title="このサイトの計測を再開する"
        description={resumeTarget ? `「${resumeTarget.label}」から届く分をまた数え始めます。止めていた間の分は数えていません。` : ''}
        confirmLabel="再開する"
        busy={siteBusy}
        error={siteActionError || undefined} onSuccess={() => setResumeTarget(null)} onConfirm={() => resumeSite()}
        onCancel={() => { if (!siteBusy) setResumeTarget(null) }}
      />
    </DetailPage></SaveErrorScope>
  )
}
