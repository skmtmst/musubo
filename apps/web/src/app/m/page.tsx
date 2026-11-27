'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ListState from '@/components/shared/list-state'
import MobileScreen from '@/components/mobile/mobile-screen'
import { useMobileShell } from '@/components/mobile/mobile-shell'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'

/** /m を開いたら、見られる最初のタブへ（書き出しなのでサーバーの転送は使わない）。 */
export default function MobileHomePage() {
  return (
    <MobileScreen title="musubo">
      <MobileHomeRedirect />
    </MobileScreen>
  )
}

function MobileHomeRedirect() {
  const router = useRouter()
  const { tabs, ready, stylePending } = useMobileShell()
  const { selectedAccountId } = useAccount()
  const style = useAccountStyle(selectedAccountId)
  const waitingForStyle = stylePending || (Boolean(selectedAccountId) && (style.status === 'idle' || style.status === 'loading'))
  const preferred = style.status === 'ready' && !style.stale && style.data?.style === 'restaurant' ? '/m/today' : '/m/chats'
  const first = waitingForStyle ? null : (tabs.find(tab => tab.href === preferred) ?? tabs[0])?.href ?? null
  useEffect(() => { if (first) router.replace(first) }, [first, router])
  if (ready && !waitingForStyle && !first) return <ListState kind="forbidden" />
  return <ListState kind="loading" title="読み込んでいます" />
}
