'use client'

import { createContext, useContext, type ReactNode } from 'react'
import ListState from '@/components/shared/list-state'
import { PageContent, PageFrame, PageHeading } from './page-frame'

type PendingVariant = 'detail' | 'dashboard'
const PendingLayout = createContext<{ variant: PendingVariant; title?: string }>({ variant: 'detail' })

/** 外枠が待機の型を渡す。認証や役割を待つ段階でも本文の位置をそろえる。 */
export function PagePendingLayout({ variant, title, children }: { variant: PendingVariant; title?: string; children: ReactNode }) {
  return <PendingLayout.Provider value={{ variant, title }}>{children}</PendingLayout.Provider>
}

export function usePagePendingVariant() { return useContext(PendingLayout).variant }
export function usePagePendingTitle() { return useContext(PendingLayout).title }

/** 画面をまだ出せない間の共通の骨組み。ホームは最初から本文と同じ見出しを置く。 */
export default function PagePending({ failed = false, onRetry, stage = 'identity', variant, title, error, errorTitle, description, retrying, loadingTitle }: { failed?: boolean; onRetry?: () => void; stage?: 'auth' | 'identity' | 'route' | 'root' | 'store' | 'handover' | 'style'; variant?: PendingVariant; title?: string; error?: unknown; errorTitle?: string; description?: string; retrying?: boolean; loadingTitle?: string }) {
  const inherited = useContext(PendingLayout)
  const dashboard = (variant ?? inherited.variant) === 'dashboard'
  const heading = title ?? inherited.title ?? (dashboard ? 'ダッシュボード' : undefined)
  return <PageFrame kind={dashboard ? 'dashboard' : 'detail'}>
    {heading ? <PageHeading title={heading} /> : null}
    <PageContent layout={dashboard ? 'stats' : undefined} data-page-pending={stage}>
      <ListState kind={failed ? 'error' : 'loading'} loadingShape={dashboard ? 'cards' : undefined} title={failed ? errorTitle : loadingTitle} error={error} description={description} onRetry={onRetry} retrying={retrying} />
    </PageContent>
  </PageFrame>
}
