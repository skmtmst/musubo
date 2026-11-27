'use client'

/*
 * ★V8-B マイペット（Pencil「★V8-B 画面の地図」専用機能の組：
 * 一覧 ・一覧 1152 ・ペットの情報を直す ・ごはんの目安 ）。
 *
 * 外枠（見出し・CSV・タブ・数の帯）は2つのタブで同じ。型は ListPage。
 * データの口（pets・feeding・saveFeeding・updatePet・CSV）は今の画面と同じ。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */
import { useListUrlJsonValue } from '@/components/shared/list-url-state'

import { useCallback, useEffect, useState } from 'react'
import { Download, History, MinusCircle, PlusCircle, Undo2 } from 'lucide-react'
import { ListPage } from '@/components/templates'
import Button from '@/components/shared/button'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { Tabs } from '@/components/shared/tabs'
import { usePageCrumbs } from '@/components/shell/page-chrome'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { nenPetsApi, type NenPetKpis } from '@/lib/nen-pets-api'
import PetsListV8 from './list'
import FeedingV8 from './feeding'
import { EMPTY_QUERY, downloadCsv, petsToCsv, type PetTab, type PetsQuery } from './parts'
import styles from './pets.module.css'
import { csvFileName } from '@/lib/csv-file-name'
import ReadOnlyNotice from '@/components/shared/read-only-notice'

export type { PetTab } from './parts'

const BOARD: Record<PetTab, string> = { pets: 'wTIej', feeding: 'h7A2F' }

export default function PetsV8({
  accountId,
  tab,
  onChangeTab,
}: {
  accountId: string | null
  tab: PetTab
  onChangeTab: (next: PetTab) => void
}) {
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const role = useStaffRole()
  /* 役割が読めるまでは閲覧のみとして扱い、押せないボタンを先に出さない。 */
  const canEdit = role !== null && canManageRole(role)
  const readonly = !canManageRole(role)

  const [kpis, setKpis] = useState<NenPetKpis | null>(null)
  const [kpisFailed, setKpisFailed] = useState(false)
  const [kpiRetry, setKpiRetry] = useState(0)
  const handleKpisFailed = useCallback((failed: boolean) => { setKpisFailed(failed); if (failed) setKpis(null) }, [])
  /** 一覧の絞り込み。CSV も同じ条件で書き出す（今の画面と同じ）。 */
  const [query, setQuery] = useListUrlJsonValue<PetsQuery>('query', EMPTY_QUERY)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(false)

  // 数の帯は一覧の取得に付いてくる。ごはんの目安のタブでは1件だけ取って数を読む。
  useEffect(() => {
    if (!accountId || tab !== 'feeding') return
    let active = true
    setKpisFailed(false)
    void nenPetsApi.pets(accountId, { pageSize: 1 }).then((res) => {
      if (!active) return
      if (res.success) setKpis(res.data.kpis)
      else { setKpis(null); setKpisFailed(true) }
    }).catch(() => { if (active) { setKpis(null); setKpisFailed(true) } })
    return () => { active = false }
  }, [accountId, tab, kpiRetry])

  // アカウントを替えたら、前のアカウントの数を出さない。
  const [kpiAccount, setKpiAccount] = useState(accountId)
  if (kpiAccount !== accountId) {
    setKpiAccount(accountId)
    setKpis(null)
    setKpisFailed(false)
    setQuery(EMPTY_QUERY)
  }

  const exportCsv = async () => {
    if (!accountId || exporting) return
    setExporting(true)
    setExportError(false)
    try {
      const res = await nenPetsApi.pets(accountId, { ...query, pageSize: 'all' })
      if (!res.success) throw new Error(res.error)
      downloadCsv(petsToCsv(res.data.items), csvFileName("ペット"))
    } catch {
      setExportError(true)
    } finally {
      setExporting(false)
    }
  }

  const tabs = (
    <div className={styles.tabs}>
      <Tabs
        label="マイペットの切り替え"
        items={[
          { label: kpis ? `登録ペット ${kpis.total}` : '登録ペット', current: tab === 'pets', onClick: () => onChangeTab('pets') },
          { label: 'ごはんの目安', current: tab === 'feeding', onClick: () => onChangeTab('feeding') },
        ]}
      />
    </div>
  )

  const pending = kpis === null
  const missing = kpisFailed ? '読み込めませんでした' : '読み込んでいます'
  const stats = accountId ? (
    <>
      {readonly ? (
        <div className={styles.viewerBand}><ReadOnlyNotice role="status">閲覧のみで見ています。ペットの情報や主食を変える操作は管理者に頼んでください。</ReadOnlyNotice></div>
      ) : null}
      <KpiBand data-design="KPIs" aria-label="ペットの数の帯">
        <KpiCard presentation="band" title="登録ペット" icon={<History size={16} aria-hidden="true" />} value={pending ? null : kpis.total} unit="匹" loading={pending && !kpisFailed} detail={pending ? missing : `犬 ${kpis.dogs}・猫 ${kpis.cats}・その他 ${Math.max(0, kpis.total - kpis.dogs - kpis.cats)}`} />
        <KpiCard presentation="band" title="今月の新規" icon={<PlusCircle size={16} aria-hidden="true" />} value={pending ? null : kpis.newThisMonth} unit="匹" loading={pending && !kpisFailed} detail="1日から今日まで" />
        <KpiCard presentation="band" title="目安を出せる" icon={<MinusCircle size={16} aria-hidden="true" />} value={pending ? null : kpis.computable} unit="匹" loading={pending && !kpisFailed} detail="犬・猫で体重と主食がそろっている" detailLayout="single" />
        <KpiCard presentation="band" title="体重が古い" icon={<Undo2 size={16} aria-hidden="true" />} value={pending ? null : kpis.staleWeight} unit="匹" loading={pending && !kpisFailed} detail="90日 更新なし" />
      </KpiBand>
      {tab === 'feeding' && kpisFailed ? <Notice tone="danger">ペットの数を読み込めませんでした。 <Button variant="text" size="inline" onClick={() => setKpiRetry(value => value + 1)}>もう一度読み込む</Button></Notice> : null}
    </>
  ) : undefined

  return (
    <ListPage
      skeleton
      boardId={BOARD[tab]}
      headingSize="regular"
      title="マイペット"
      help="お客さまがマイページで登録したペットです。体重と主食から、1日のごはんの目安を出します。"
      explanation="体重が90日更新されていないペットは、マイページで更新をお願いできます（行の「…」→マイページで更新を促す）。"
      actions={accountId ? (
        <Button type="button" onClick={() => void exportCsv()} disabled={exporting} busy={exporting} busyLabel="書き出しています…">
          <Download size={16} aria-hidden="true" />CSVで書き出す
        </Button>
      ) : null}
      tabs={tabs}
      stats={stats}
    >
      {exportError ? (
        <div className={styles.noteRow}>
          <Notice tone="warn" message="CSVを書き出せませんでした。通信の状態を確認して、もう一度お試しください。" />
        </div>
      ) : null}
      {!accountId ? (
        <ListState kind="empty" title="LINEアカウントを選んでください" description="上のバーから、ペットを見るLINEアカウントを選びます。" />
      ) : tab === 'feeding' ? (
        <FeedingV8 accountId={accountId} canEdit={canEdit} />
      ) : (
        <PetsListV8 key={accountId} accountId={accountId} canEdit={canEdit} query={query} onQueryChange={setQuery} onKpis={setKpis} onKpisFailed={handleKpisFailed} />
      )}
    </ListPage>
  )
}
