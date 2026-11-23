'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Tabs } from '@/components/shared/tabs'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'
import { useStaffRole } from '@/lib/staff-role'

type Channel = 'all' | 'line' | 'instagram' | 'email'
type Connection = 'idle' | 'loading' | 'connected' | 'disconnected' | 'error'

export function InboxChannelTabs() {
  const params = useSearchParams()
  const router = useRouter()
  const { selectedAccountId, selectedAccount, loading, error, refreshAccounts } = useAccount()
  const role = useStaffRole()
  const requested = params.get('channel')
  const current: Channel = requested === 'line' || requested === 'instagram' || requested === 'email' ? requested : 'all'
  const [connection, setConnection] = useState<Connection>('idle')
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<Channel | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => { setConnection('idle'); setPending(null); setMessage('') }, [selectedAccountId])
  useEffect(() => { setMessage('') }, [current])
  useEffect(() => {
    if (pending !== 'instagram' && current !== 'instagram') return
    if (!selectedAccountId) return
    let active = true
    setConnection('loading')
    void api.instagram.connections(selectedAccountId).then(result => {
      if (!active) return
      if (!result.success || !result.data || !Array.isArray(result.data.connections)) { setConnection('error'); return }
      setConnection(result.data.connections.some(item => item.state === 'connected') ? 'connected' : 'disconnected')
    }).catch(() => { if (active) setConnection('error') })
    return () => { active = false }
  }, [selectedAccountId, pending === 'instagram' || current === 'instagram', attempt])

  const select = (channel: Channel) => {
    const query = new URLSearchParams(params.toString())
    if (channel === 'all') query.delete('channel'); else query.set('channel', channel)
    const queryString = query.toString()
    setPending(null); setMessage('')
    router.push(`${window.location.pathname}${queryString ? `?${queryString}` : ''}`)
  }
  const notConnected = (navigate = true) => {
    if (role === null) { setMessage('権限を確認しています。'); return }
    setPending(null)
    if (role === 'viewer') { setMessage('管理者につないでもらってください。'); return }
    if (!navigate) { setMessage('この受信経路はつながっていません。'); return }
    router.push('/settings/sns')
  }
  useEffect(() => {
    if (pending !== 'instagram' && current !== 'instagram') return
    if (pending === 'instagram' && connection === 'connected') select('instagram')
    if (connection === 'disconnected') notConnected(pending === 'instagram')
  // The pending request is resolved against the latest account and role.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, current, connection, role])
  useEffect(() => {
    if (current !== 'email' || loading || !selectedAccountId) return
    if (error || !selectedAccount || selectedAccount.emailInboxEnabled === undefined) {
      setMessage('メールの接続状態を読み込めませんでした。')
    } else if (!selectedAccount.emailInboxEnabled) {
      notConnected(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, loading, selectedAccountId, selectedAccount, error, role])
  useEffect(() => {
    if (pending === 'email' && role !== null) notConnected()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, role])
  const choose = (channel: Channel) => {
    setMessage('')
    if (channel === 'instagram') {
      if (loading || !selectedAccountId) { setMessage(loading ? '接続状態を確認しています。' : 'LINE アカウントを選んでください。'); return }
      if (connection === 'connected') select(channel)
      else if (connection === 'disconnected') notConnected()
      else { setPending(channel); if (connection === 'error') setAttempt(value => value + 1) }
      return
    }
    if (channel === 'email') {
      if (error) { setMessage('メールの接続状態を読み込めませんでした。'); return }
      if (loading || !selectedAccountId) { setMessage('接続状態を確認しています。'); return }
      if (error || !selectedAccount || selectedAccount.emailInboxEnabled === undefined) { setMessage('メールの接続状態を読み込めませんでした。'); return }
      if (!selectedAccount.emailInboxEnabled) { if (role === null) setPending('email'); notConnected(); return }
    }
    select(channel)
  }
  return <>
    <Tabs label="受信経路" size="compact" items={([
      ['all', 'すべて'], ['line', 'LINE'], ['instagram', 'Instagram'], ['email', 'メール'],
    ] as const).map(([id, label]) => ({ label, current: current === id, onClick: () => choose(id) }))} />
    {(pending === 'instagram' || current === 'instagram') && connection === 'loading' ? <Notice tone="info" message="Instagram の接続状態を確認しています。" /> : null}
    {(pending === 'instagram' || current === 'instagram') && connection === 'error' ? <Notice tone="warn" message="Instagram の接続状態を読み込めませんでした。" action={<Button variant="text" size="inline" onClick={() => setAttempt(value => value + 1)}>読み直す</Button>} /> : null}
    {message ? <Notice tone="info" message={message} action={message === 'この受信経路はつながっていません。' ? <Button variant="text" size="inline" onClick={() => router.push('/settings/sns')}>設定へ</Button> : (error || message === 'メールの接続状態を読み込めませんでした。') ? <Button variant="text" size="inline" onClick={() => void refreshAccounts()}>読み直す</Button> : undefined} /> : null}
  </>
}
