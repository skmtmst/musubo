'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Tabs } from '@/components/shared/tabs'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'

export type InboxTabChannel = 'all' | 'line' | 'instagram' | 'email'
export type UnconfiguredInboxChannel = 'instagram' | 'email' | null
type Connection = 'idle' | 'loading' | 'connected' | 'disconnected' | 'error'

export function useInboxChannelTabs() {
  const params = useSearchParams()
  const router = useRouter()
  const { selectedAccountId, selectedAccount, loading, error, refreshAccounts } = useAccount()
  const requested = params.get('channel')
  const requestedInstagram = requested === 'instagram'
  const requestedEmail = requested === 'email'
  const preparing = usePreparingDialog()
  const directNoticeShown = useRef(false)
  const [connection, setConnection] = useState<Connection>('idle')
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<'instagram' | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => { setConnection('idle'); setPending(null); setMessage('') }, [selectedAccountId])
  useEffect(() => { setMessage('') }, [requested])
  useEffect(() => { directNoticeShown.current = false }, [requested, selectedAccountId])

  useEffect(() => {
    if (pending !== 'instagram' && !requestedInstagram) return
    if (!selectedAccountId) return
    let active = true
    setConnection('loading')
    void api.instagram.connections(selectedAccountId).then(result => {
      if (!active) return
      if (!result.success || !result.data || !Array.isArray(result.data.connections)) { setConnection('error'); return }
      setConnection(result.data.connections.some(item => item.state === 'connected') ? 'connected' : 'disconnected')
    }).catch(() => { if (active) setConnection('error') })
    return () => { active = false }
  }, [selectedAccountId, pending === 'instagram' || requestedInstagram, attempt])

  const select = (channel: InboxTabChannel) => {
    const query = new URLSearchParams(params.toString())
    if (channel === 'all') query.delete('channel'); else query.set('channel', channel)
    const queryString = query.toString()
    setPending(null); setMessage('')
    router.push(`${window.location.pathname}${queryString ? `?${queryString}` : ''}`)
  }

  useEffect(() => {
    if (pending !== 'instagram' && !requestedInstagram) return
    if (connection === 'connected' && (pending === 'instagram' || !directNoticeShown.current)) {
      directNoticeShown.current = true
      setPending(null)
      preparing.open('Instagram の会話')
    }
    if (connection === 'disconnected' && pending === 'instagram') {
      select('instagram')
    }
  // 最新の接続状態に対して保留中のタブ選択を反映する。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, requestedInstagram, connection])

  const emailError = requestedEmail && !loading && Boolean(selectedAccountId)
    && (Boolean(error) || !selectedAccount || selectedAccount.emailInboxEnabled === undefined)
  const emailDisconnected = requestedEmail && !loading && Boolean(selectedAccountId)
    && !error && Boolean(selectedAccount) && selectedAccount?.emailInboxEnabled === false

  useEffect(() => {
    if (emailError) setMessage('メールの接続状態を読み込めませんでした。')
  }, [emailError])

  const unconfiguredChannel: UnconfiguredInboxChannel =
    requestedInstagram && connection === 'disconnected'
      ? 'instagram'
      : emailDisconnected
        ? 'email'
        : null

  const current: InboxTabChannel =
    requested === 'line'
      ? 'line'
      : requestedEmail
        ? 'email'
        : unconfiguredChannel === 'instagram'
          ? 'instagram'
          : 'all'

  const choose = (channel: InboxTabChannel) => {
    setMessage('')
    if (channel === 'instagram') {
      if (loading || !selectedAccountId) { setMessage(loading ? '接続状態を確認しています。' : 'LINE アカウントを選んでください。'); return }
      if (connection === 'connected') preparing.open('Instagram の会話')
      else if (connection === 'disconnected') select('instagram')
      else { setPending('instagram'); if (connection === 'error') setAttempt(value => value + 1) }
      return
    }
    if (channel === 'email') {
      if (error) { setMessage('メールの接続状態を読み込めませんでした。'); return }
      if (loading || !selectedAccountId) { setMessage('接続状態を確認しています。'); return }
      if (!selectedAccount || selectedAccount.emailInboxEnabled === undefined) { setMessage('メールの接続状態を読み込めませんでした。'); return }
      select('email')
      return
    }
    select(channel)
  }

  return {
    current,
    unconfiguredChannel,
    choose,
    pending,
    requestedInstagram,
    connection,
    retryInstagram: () => setAttempt(value => value + 1),
    message,
    error,
    refreshAccounts,
    preparingDialog: preparing.dialog,
  }
}

export type InboxChannelTabsState = ReturnType<typeof useInboxChannelTabs>

function InboxChannelTabsView({ state }: { state: InboxChannelTabsState }) {
  return <>
    <Tabs label="受信経路" size="compact" items={([
      ['all', 'すべて'], ['line', 'LINE'], ['instagram', 'Instagram'], ['email', 'メール'],
    ] as const).map(([id, label]) => ({ label, current: state.current === id, onClick: () => state.choose(id) }))} />
    {(state.pending === 'instagram' || state.requestedInstagram) && state.connection === 'loading' ? <Notice tone="info" message="Instagram の接続状態を確認しています。" /> : null}
    {(state.pending === 'instagram' || state.requestedInstagram) && state.connection === 'error' ? <Notice tone="warn" message="Instagram の接続状態を読み込めませんでした。" action={<Button variant="text" size="inline" onClick={state.retryInstagram}>読み直す</Button>} /> : null}
    {state.message ? <Notice tone="info" message={state.message} action={(state.error || state.message === 'メールの接続状態を読み込めませんでした。') ? <Button variant="text" size="inline" onClick={() => void state.refreshAccounts()}>読み直す</Button> : undefined} /> : null}
    {state.preparingDialog}
  </>
}

function StandaloneInboxChannelTabs() {
  const state = useInboxChannelTabs()
  return <InboxChannelTabsView state={state} />
}

export function InboxChannelTabs({ state }: { state?: InboxChannelTabsState } = {}) {
  return state ? <InboxChannelTabsView state={state} /> : <StandaloneInboxChannelTabs />
}
