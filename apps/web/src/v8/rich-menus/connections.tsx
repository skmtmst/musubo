'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { ArrowLeftRight, ArrowRight, Pencil, Plus } from 'lucide-react';
import { api, ApiError, type RichMenuAreaResponse } from '@/lib/api';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { DetailPage } from '@/components/templates';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import ListState from '@/components/shared/list-state'
import TargetMissing from '@/components/shared/target-missing'
import { formatNumber } from '@/lib/format';
import { analyzeConnections, type ConnectionAnalysis, type ConnectionPage } from './connection-analysis';
import styles from './connections.module.css'
import Card, { CardHeader } from '@/components/shared/card'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { useFeatureAccess } from '@/lib/use-feature-access'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value';

// 保存済みの切替ボタンを解析し、行けない先や戻れないページを表示する。

const MAX_PAGES = 10

type RichMenuGroup = {
  id: string
  accountId: string
  name: string
  status: 'draft' | 'published'
  defaultPageId: string | null
  isDefaultForAll?: boolean
  targetingEnabled?: boolean
  targetingCondition?: string | null
  audienceCount?: number | null
  monthlyStats?: { taps: number; uniqueAudience?: { value: number | null } }
  pages: Array<ConnectionPage & { areas: RichMenuAreaResponse[] }>
}

/** 取得結果の形を確かめる（`as` 断定の代わり）。 */
function isRichMenuGroupResponse(value: unknown): value is RichMenuGroup {
  if (!value || typeof value !== 'object') return false
  return 'id' in value && typeof value.id === 'string' && 'pages' in value && Array.isArray(value.pages)
}

const tabLetter = (index: number) => String.fromCharCode(65 + index)

/** 入口のメニューと各ページの行き来（「タブB ⇄ タブA」）。行き来の札は入口から見たタブ・戻りのタブ。 */
export function linkLabel(analysis: ConnectionAnalysis, entryId: string, pageId: string): { label: string; both: boolean } {
  const out = analysis.edges.filter((edge) => edge.fromPageId === entryId)
  const back = analysis.edges.filter((edge) => edge.fromPageId === pageId)
  const goIndex = out.findIndex((edge) => edge.targetPageId === pageId)
  const backIndex = back.findIndex((edge) => edge.targetPageId === entryId)
  /*
   * 直接のタブが無くても、別のメニューを通って行ける・戻れることがある（A→B→C→A）。
   * 行けるか・戻れるかは、たどり着けるかの解析（reachable・cannotReturn）で決める。
   */
  const reachable = analysis.reachablePageIds.has(pageId)
  const returnable = reachable && !analysis.cannotReturnPageIds.has(pageId)
  if (goIndex < 0 && backIndex < 0) {
    if (reachable && returnable) return { label: '別のメニュー経由で行き来', both: true }
    if (reachable) return { label: '別のメニュー経由・戻りなし', both: false }
    return { label: 'つながりなし', both: false }
  }
  if (goIndex < 0) return { label: `タブ${tabLetter(backIndex)} → トップ`, both: false }
  if (backIndex < 0) return { label: returnable ? `タブ${tabLetter(goIndex + 1)} → 経由して戻れる` : `タブ${tabLetter(goIndex + 1)} → 戻りなし`, both: returnable }
  return { label: `タブ${tabLetter(goIndex + 1)} ⇄ タブ${tabLetter(backIndex)}`, both: true }
}

export default function RichMenuConnectionsV8() {
  return (
    <Suspense fallback={<ListState kind="loading" title="切替のつながりを読み込んでいます" />}>
      <Connections />
    </Suspense>
  )
}

function Connections() {
  const router = useRouter()
  const groupId = useSearchParams().get('id') ?? ''
  const canEdit = useFeatureAccess('richMenus')
  const editReason = usePermissionLockReason(canEdit)
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const activeAccountIdRef = useRef(selectedAccountId)
  const requestGenerationRef = useRef(0)
  const [group, setGroup] = useState<RichMenuGroup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 404・空で見つからないとき。取得の失敗（error）とは分ける。 */
  const [missing, setMissing] = useState(false)

  usePageTitle('切替のつながり')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'リッチメニュー', href: '/rich-menus' }])
  activeAccountIdRef.current = selectedAccountId

  const load = useCallback(async () => {
    if (!groupId || !selectedAccountId) {
      setLoading(false)
      return
    }
    const accountId = selectedAccountId
    const generation = ++requestGenerationRef.current
    const stale = () => activeAccountIdRef.current !== accountId || requestGenerationRef.current !== generation
    setLoading(true)
    setGroup(null)
    setError('')
    setMissing(false)
    try {
      const response = await api.richMenuGroups.get(groupId)
      if (stale()) return
      if (!response.success) throw new Error(response.error)
      if (!isRichMenuGroupResponse(response.data)) throw new Error('取得失敗')
      setGroup(response.data)
    } catch (caught) {
      if (stale()) return
      setGroup(null)
      if (caught instanceof ApiError && caught.status === 404) {
        setMissing(true)
        return
      }
      setError('切替のつながりを表示できませんでした。通信を確認して、もう一度お試しください。')
    } finally {
      if (!stale()) setLoading(false)
    }
  }, [groupId, selectedAccountId])

  useEffect(() => {
    if (accountLoading) return
    void load()
  }, [accountLoading, load])

  const analysis = useMemo(() => group ? analyzeConnections(group.pages, group.defaultPageId) : null, [group])

  if (accountLoading || loading) return <ListState kind="loading" title="切替のつながりを読み込んでいます" />
  if (!selectedAccountId) return <ListState kind="empty" title="LINE公式アカウントを選んでください" description="表示するアカウントを上の切替から選んでください。" />
  if (!groupId) {
    return <TargetMissing kind="unspecified" title="つながりを見るメニューが指定されていません" description="メニューの一覧から、つながりを見るメニューを選び直してください。" backHref="/rich-menus" backLabel="メニュー一覧へ戻る" />
  }
  if (missing || (!error && (!group || !analysis))) {
    return <TargetMissing kind="not-found" title="このメニューは見つかりません" description="削除されたか、別の記録です。一覧から選び直してください。" backHref="/rich-menus" backLabel="メニュー一覧へ戻る" />
  }
  if (error || !group || !analysis) {
    return <TargetMissing kind="error" title="切替のつながりを表示できませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => void load()} />
  }
  if (group.accountId !== selectedAccountId) {
    return <ListState kind="forbidden" title="選択中のアカウントでは表示できません" description="このメニューが所属するLINE公式アカウントへ切り替えてください。" />
  }

  const pages = [...group.pages].sort((a, b) => a.orderIndex - b.orderIndex)
  const entryId = analysis.entryPageId ?? pages[0]?.id ?? ''
  const entry = pages.find((page) => page.id === entryId) ?? null
  const others = pages.filter((page) => page.id !== entryId)
  const editHref = `/rich-menus/edit?id=${encodeURIComponent(group.id)}`
  const buttonsHref = `/rich-menus/edit?id=${encodeURIComponent(group.id)}&step=buttons`
  // 直接のタブが無くても、別のメニューを通ってトップへ戻れるなら「帰れない」と言わない。
  const noReturn = others.filter((page) => analysis.cannotReturnPageIds.has(page.id))
  const draftTargets = group.status === 'published' ? others.filter((page) => !page.lineRichmenuId) : []
  const audienceText = group.isDefaultForAll || !group.targetingEnabled || !group.targetingCondition ? 'すべての友だち（既定）' : '条件で出し分け'
  const reach = group.monthlyStats?.uniqueAudience?.value ?? group.audienceCount ?? null
  const taps = group.monthlyStats?.taps ?? null

  const menuItems: ActionMenuItem[] = [
    ...(pages.length >= MAX_PAGES ? [{ id: 'buttons', label: 'ボタンの動きを直す', ...(canEdit ? { href: buttonsHref, onSelect: () => router.push(buttonsHref) } : { lockedReason: editReason, disabled: !editReason }) }] : []),
    { id: 'list', label: 'メニュー一覧へ', onSelect: () => router.push('/rich-menus') },
  ]

  const aside = (
    <div className={styles.aside}>
      <div className={styles.asideActions}>
        <Button href={editHref} className={styles.asideButton}><Pencil size={16} aria-hidden="true" />{canEdit ? '編集する' : '詳しく見る'}</Button>
        <span className={styles.menuAnchor}>
          <RowMenu label="そのほかの操作" items={menuItems} />
        </span>
      </div>
      <CreateSummaryCard title="いまの状態" rows={[
        { label: '状態', value: <StatusBadge tone={group.status === 'published' ? 'success' : 'neutral'}>{group.status === 'published' ? '公開中' : '下書き'}</StatusBadge> },
        { label: '出す相手', value: <TruncatedText value={audienceText} /> },
        { label: '出る人', value: reach === null ? emptyValue('unknown') : `${formatNumber(reach)}人` },
        { label: '今月押された', value: taps === null ? emptyValue('unknown') : `${formatNumber(taps)}回` },
      ]} />
    </div>
  )

  return (
    <DetailPage
      boardId="wxIQ7"
      layout="record-detail"
      heightMode="content"
      title={`切替のつながり：${group.name}`}
      help="タブで行き来できるメニューの関係"

      summary={aside}
      summaryLabel="いまの状態と操作"
      summaryPreview={{ label: '状態と操作を見る', title: 'いまの状態と操作' }}
      readOnly={!canEdit}
    >
      <Card layout="vertical" padding="roomy" gap="normal" aria-labelledby="rm-map">
        <CardHeader size="content" titleId="rm-map" title="つながりの図" meta={others.length > 0 ? '緑のタブが「別のメニューへ移る」ボタンです' : '切替先を足すと、ここに「どのメニューからどこへ移れるか」が出ます'} />
        <div className={styles.map}>
          {entry ? (
            <Card layout="vertical" padding="compact" gap="tight" surface="muted" className={styles.menu} data-entry="">
              <span className={styles.menuImage} aria-hidden="true" />
              <CardHeader size="content" title={<TruncatedText value={String(entry.name ?? '')} />} meta="このメニュー・タブA" />
            </Card>
          ) : null}
          {others.map((page, index) => {
            const link = linkLabel(analysis, entryId, page.id)
            const returns = !noReturn.some((item) => item.id === page.id)
            return (
              <div key={page.id} className={styles.mapPair}>
                <span className={styles.link}>
                  <TruncatedText value={link.label} />
                  {link.both ? <ArrowLeftRight className={styles.linkIcon} aria-hidden="true" /> : <ArrowRight className={styles.linkIcon} aria-hidden="true" />}
                </span>
                <Card layout="vertical" padding="compact" gap="tight" surface={returns ? 'standard' : 'danger'} className={styles.menu} data-broken={returns ? undefined : ''}>
                  <span className={styles.menuImage} aria-hidden="true" />
                  <CardHeader size="content" title={<TruncatedText value={String(page.name ?? '')} />} meta={`タブ${tabLetter(index + 1)}・${returns ? '戻るタブあり' : '戻るタブなし'}`} />
                </Card>
              </div>
            )
          })}
        </div>
        <div className={styles.addRow}>
          {pages.length < MAX_PAGES ? (
            <PermissionGatedButton allowed={canEdit} variant="text" href={buttonsHref}><Plus size={16} aria-hidden="true" />{`切替先のメニューを足す（最大${MAX_PAGES} 枚）`}</PermissionGatedButton>
          ) : pages.length >= MAX_PAGES ? <span className={styles.cardNote}>{`切替先は最大${MAX_PAGES} 枚です`}</span> : null}
          <span className={styles.count}>{`${pages.length} 枚`}</span>
        </div>
      </Card>
      <CreateSummaryCard title="よくある事故の見張り" beforeRows={noReturn.map(page => (
        <Notice key={page.id} tone="warn" message={`「${page.name}」に${entry ? `${entry.name}へ` : ''}戻るタブがありません。押した人が元のメニューに帰れません。`}
          action={<PermissionGatedButton allowed={canEdit} href={buttonsHref}>{`${page.name}を開いて直す`}</PermissionGatedButton>} />
      ))} rows={[
        ...(analysis.missingTargetEdges.length > 0 ? [{ label: '切替先が見つからないタブ', value: <StatusBadge tone="danger">{`${formatNumber(analysis.missingTargetEdges.length)} 件`}</StatusBadge> }] : []),
        ...(analysis.unreachablePageIds.size > 0 ? [{ label: 'どこからも来られないメニュー', value: <StatusBadge tone="danger">{`${analysis.unreachablePageIds.size} 件`}</StatusBadge> }] : []),
        { label: '切替先が下書きのまま', value: draftTargets.length ? <StatusBadge tone="warning">{`${formatNumber(draftTargets.length)}件`}</StatusBadge> : emptyValue('none') },
        // 対象条件は束ごとに保存するため、切替先だけ別の条件にはならない。
        { label: '切替先だけ「誰に出すか」が違う', value: 'なし' },
      ]} />
    </DetailPage>
  )
}
