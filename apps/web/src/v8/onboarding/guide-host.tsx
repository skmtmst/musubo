'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useOptionalAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { useStaffRole } from '@/lib/staff-role'
import { useFirstSteps } from '@/v8/dashboard/public/first-steps-model/index'
import { GUIDE_ENGINE_EVENT, readGuideEngineState } from './guide-engine'
import { GuideOverlay } from './guide-overlay'
import { guideProcedure } from './guide-script'
import { GuideSharedProvider, type SharedGuide } from './guide-shared'
import { useGuideSignal } from './guide-signal'

/*
  開店準備ガイドの入れ物。全画面で1つ。画面側は置かない。
  案内はどの画面でも同じ形で出すため、画面ごとに別の入れ物を作らない。

  案内する手順の対象（卓を作る・メニューを保存する…）は、はじめにやることの画面ではなく
  それぞれの設定画面にあるので、重ね表示はダッシュボードではなくアプリ全体に1つ置く。

  案内中・一時停止中でない時は、はじめにやることの実測を読まない
  （関係ない画面に読み込みを増やさない）。
*/

export function GuideHost({ children }: { children: ReactNode }) {
  const account = useOptionalAccount()
  const accountId = account?.selectedAccountId ?? null
  /**
   * 案内が動いているか。控え（localStorage）を見て決め、
   * 控えが変わった合図でも見直す（ダッシュボードで「開始」を押した直後もここで気づく）。
   */
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    const read = () => {
      const phase = readGuideEngineState(accountId).phase
      setArmed(phase === 'active' || phase === 'paused')
    }
    read()
    if (typeof window === 'undefined') return
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId?: string }>).detail
      if (!detail?.accountId || detail.accountId === accountId) read()
    }
    window.addEventListener(GUIDE_ENGINE_EVENT, changed)
    return () => window.removeEventListener(GUIDE_ENGINE_EVENT, changed)
  }, [accountId])

  if (!accountId || !armed) return <>{children}</>
  return <GuideHostActive accountId={accountId}>{children}</GuideHostActive>
}

function GuideHostActive({ accountId, children }: { accountId: string; children: ReactNode }) {
  const role = useStaffRole()
  const style = useAccountStyle(accountId)
  const first = useFirstSteps(accountId, role, { style: style.data?.style ?? null })
  const { guide, summary } = first
  const shared = useMemo<SharedGuide>(() => ({ guide, summary }), [guide, summary])

  const index = summary?.steps.findIndex(step => step.key === guide.stepKey) ?? -1
  const step = index >= 0 ? summary?.steps[index] ?? null : null
  /** 9項目の済みは実データ計測の値のまま渡す（ガイドで済みにしない）。 */
  const segments = useMemo(() => summary?.steps.map(item => item.done) ?? [], [summary])

  const procedure = guideProcedure(guide.stepKey, guide.procedureIndex)
  const advance = useCallback(() => { guide.advanceProcedure() }, [guide])
  const pause = useCallback(() => { guide.pause() }, [guide])

  /*
    段や手順が変わったら、その手順の対象がある画面へ実際に移る。
    移らないと重ね表示の対象がその画面に無く、案内が消えて先へ進めない。
    始めた直後も同じ。「続きから」は最初の未完了の段の手順1なので、
    ダッシュボードで始めたらその手順の画面まで連れていく。
    連れていかないと、ダッシュボードには対象が無いので案内が1.5秒で自動停止してしまう。
    台本が画面を指定している手順（例: ⑤営業時間の1/2＝設定 › SNS連携）も同じ扱い。
  */
  const router = useRouter()
  const pathname = usePathname()
  const previousPlace = useRef<string | null>(null)
  const stepHref = step?.href ?? null
  const procedureHref = procedure?.href ?? null
  /** この手順の対象がある画面。手順の指定が無ければ段の行き先。 */
  const targetHref = procedureHref ?? stepHref
  const onTargetScreen = !targetHref || pathname === targetHref.split('?')[0]
  useEffect(() => {
    /* 行き先がまだ分からない間（実測の読み込み中）は前の居場所を覚えたままにして、判定を先送りする。 */
    if (guide.phase !== 'active' || !guide.stepKey || !targetHref) return
    const place = `${guide.stepKey}:${guide.procedureIndex}`
    const previous = previousPlace.current
    previousPlace.current = place
    if (onTargetScreen) return
    /* 同じ居場所で一度連れていった後は繰り返さない（押し戻し合いを防ぐ）。 */
    if (!procedureHref && previous === place) return
    router.push(targetHref)
  }, [guide.phase, guide.stepKey, guide.procedureIndex, targetHref, procedureHref, onTargetScreen, router])

  /* 保存できた時・入力がそろった時に進む手順は、画面側の合図で進める。 */
  useGuideSignal(
    procedure?.trigger === 'event' || procedure?.trigger === 'valid' ? procedure.anchor : null,
    guide.phase === 'active',
    advance,
  )

  return (
    <GuideSharedProvider value={shared}>
      {children}
      <GuideOverlay
        active={guide.phase === 'active'}
        stepKey={guide.stepKey}
        stepLabel={step?.label ?? null}
        stepOrder={index >= 0 ? index + 1 : null}
        procedureIndex={guide.procedureIndex}
        onTargetScreen={onTargetScreen}
        segments={segments}
        onAdvanceProcedure={advance}
        onPause={pause}
      />
    </GuideSharedProvider>
  )
}
