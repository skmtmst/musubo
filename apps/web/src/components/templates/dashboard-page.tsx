'use client'
import { Children, createContext, isValidElement, useContext, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode, Ref } from 'react'
import Card from '@/components/shared/card'
import ListState from '@/components/shared/list-state'
import { PageContent, PageFrame, PageHeading, type PageHeadingProps } from './page-frame'
import styles from './page-templates.module.css'

/**
 * 段のまとまりの見せ方。lines は線で区切る（既定）。cards は段の中身・右の列の段を
 * 共通のカード（Card）に1つずつ入れ、間を空けて並べる。色と影はカードの部品が持つ。
 */
type DashboardGrouping = 'lines' | 'cards'
const GroupingContext = createContext<{ grouping: DashboardGrouping; inCard: boolean }>({ grouping: 'lines', inCard: false })

export interface DashboardPageProps extends PageHeadingProps {
  boardId?: string
  standalone?: boolean
  /** 飲食の融合板の見出しと本文の寸法。 */
  layout?: 'restaurant'
  /** 段のまとまりの見せ方。省くと線で区切る。 */
  grouping?: DashboardGrouping
  /** 板の頭のすぐ下に置くタブの段（E-1 hKRRF の店のタブ）。省くと段を作らない。 */
  tabs?: ReactNode
  notice?: ReactNode
  stats?: ReactNode
  /** 初回の案内が本文を後から押さないように待つ。表示済みの本文は同じ対象の読み直しで外さない。 */
  initialContent?: { scope: string; pending: boolean }
  children: ReactNode
  overlays?: ReactNode
}
export function DashboardPage({ boardId, standalone, layout, grouping = 'lines', tabs, notice, stats, initialContent, children, overlays, ...heading }: DashboardPageProps) {
  const scope = initialContent?.scope
  const pending = initialContent?.pending ?? false
  const [readyScope, setReadyScope] = useState<string | null>(null)
  useEffect(() => { if (scope !== undefined && !pending) setReadyScope(scope) }, [scope, pending])
  const waiting = pending && readyScope !== scope
  const content = <>
    {stats ? <div className={styles.stats} data-template-region="stats">{stats}</div> : null}
    <GroupingContext.Provider value={{ grouping, inCard: false }}>{children}</GroupingContext.Provider>
  </>
  return <PageFrame kind="dashboard" layout={layout} boardId={boardId} standalone={standalone}>
    <PageHeading {...heading} />
    {tabs ? <div className={styles.tabs} data-template-region="tabs">{tabs}</div> : null}
    {notice ? <div className={styles.notice} data-template-region="notice">{notice}</div> : null}
    {waiting ? <PageContent><ListState kind="loading" loadingShape="cards" /></PageContent> : null}
    {initialContent ? <div key={scope} className={styles.dashboardContent} data-pending={waiting || undefined} inert={waiting || undefined} aria-hidden={waiting || undefined}>{content}</div> : content}{overlays}
  </PageFrame>
}

/** 案内、期間の操作、数の帯を共通の順序で並べる。 */
export function DashboardTop({ intro, controls, children }: { intro?: ReactNode; controls?: ReactNode; children: ReactNode }) {
  return <>{intro}{controls}{children}</>
}

/** 期間操作に添える見出しの補足。 */
export function DashboardSubtitle({ children }: { children: ReactNode }) {
  return <p className={styles.subtitle}>{children}</p>
}

/** 段の中身。cards のときだけ共通のカードに入れ、中の右の列の段は二重のカードにしない。 */
function GroupCell({ children }: { children: ReactNode }) {
  const { grouping } = useContext(GroupingContext)
  if (grouping !== 'cards') return <div className={styles.dashboardCell}>{children}</div>
  return <Card className={styles.dashboardCell} data-template-region="group">
    <GroupingContext.Provider value={{ grouping, inCard: true }}>{children}</GroupingContext.Provider>
  </Card>
}

/**
 * 段の境界と内側の余白。高さは中身で伸びる。
 * asideSize：右の列の幅。省くと既定（297）。'wide' は 360（E-1 hKRRF）。
 * 'column' は上の数の帯の1マス分（帯と同じ等分の格子に載せ、縦の線を帯の線と一直線にする）。
 * asideColumns：'column' のときの帯のマスの数（省くと --tpl-dash-cols）。
 */
export function DashboardRow({ children, aside, asideRef, variant, asideSize, asideColumns }: { children: ReactNode; aside?: ReactNode; asideRef?: Ref<HTMLElement>; variant?: 'trend' | 'inbox' | 'link' | 'restaurant'; asideSize?: 'wide' | 'column' | 'restaurant'; asideColumns?: number }) {
  const { grouping } = useContext(GroupingContext)
  const gridStyle = asideSize === 'column' && asideColumns ? { '--tpl-dash-cols': asideColumns } as CSSProperties : undefined
  return <div className={styles.dashboardRow} data-template-region="row" data-row={variant} data-grouping={grouping === 'cards' ? grouping : undefined} data-aside-size={aside ? asideSize : undefined} style={gridStyle}>
    <GroupCell>{children}</GroupCell>
    {aside ? <aside ref={asideRef} className={styles.dashboardAside} data-template-region="aside" data-aside-size={asideSize}>{aside}</aside> : null}
  </div>
}
export function DashboardColumns({ children, layout, cardHeight }: { children: ReactNode[]; layout?: 'overview' | 'cards'; cardHeight?: 'natural' | 'equal' }) {
  const { grouping } = useContext(GroupingContext)
  return <div className={`${styles.dashboardRow} ${styles.dashboardColumns}`} data-template-region="row" data-layout={layout} data-grouping={grouping === 'cards' ? grouping : undefined} data-card-height={cardHeight}>{layout === 'cards' ? Children.toArray(children) : children.map((child, index) => <GroupCell key={isValidElement(child) && child.key !== null ? `child:${child.key}` : `index:${index}`}>{child}</GroupCell>)}</div>
}

/** 右の列の段。本文と同じ左右24、上下16、段間12を型が持つ。cards のときは段ごとに共通のカード。 */
export function DashboardAsideSection({ children }: { children: ReactNode }) {
  const { grouping, inCard } = useContext(GroupingContext)
  if (grouping === 'cards' && !inCard) return <Card className={styles.dashboardAsideSection} data-template-region="aside-section">{children}</Card>
  return <div className={styles.dashboardAsideSection} data-template-region="aside-section">{children}</div>
}
