'use client'

import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useListNavigationRouter } from '@/components/shared/list-navigation'
import { canManageRole } from '@/lib/staff-role'
import type { StyleState } from './model'

const StyleSetupWizard = dynamic(() => import('./wizard'))

/** 登録や開店準備とは独立した、設定からのスタイル変更だけを開く。 */
export function useSetupWizard(accountId: string | null, state: StyleState | null | undefined, role: string | null, onChanged: () => void) {
  const router = useListNavigationRouter()
  const params = useSearchParams()
  const setupParam = params.get('setup')
  const fromAccountSettings = params.get('setupReturn') === 'accounts'
  const qrRequested = params.has('qr')
  const [closed, setClosed] = useState<string | null>(null)
  const requestKey = accountId && fromAccountSettings && setupParam === '0' ? accountId : null
  const blockedByGuide = params.has('guide')

  useEffect(() => { if (!requestKey) setClosed(null) }, [requestKey])
  useEffect(() => {
    if (!accountId || !state || setupParam === null || requestKey || blockedByGuide) return
    const next = new URLSearchParams(params.toString())
    next.delete('setup')
    next.delete('setupReturn')
    if (setupParam === '1' && state.styleSelected && state.style === 'restaurant') next.set('guide', 'richMenu')
    router.replace(next.size ? `/?${next.toString()}` : '/')
  }, [accountId, state, setupParam, requestKey, blockedByGuide, params, router])

  const close = (changed: boolean) => {
    setClosed(requestKey)
    router.replace('/accounts')
    if (changed) onChanged()
  }

  return {
    qrRequested,
    dialog: requestKey && closed !== requestKey && !blockedByGuide && !qrRequested && state && canManageRole(role)
      ? <StyleSetupWizard key={requestKey} accountId={requestKey} state={state} initialStep={0} styleOnly onClose={close} />
      : null,
  }
}
