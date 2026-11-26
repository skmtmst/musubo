'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Tabs } from '@/components/shared/tabs'
import Notice, { NoticeStack } from '@/components/shared/notice'
import Button from '@/components/shared/button'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'
import { useStaffRole } from '@/lib/staff-role'

type Channel = 'all' | 'line' | 'instagram' | 'email'
/** Instagram の受信箱の状態。ready＝読める・返せる、permission_required＝DM の権限が無い、disconnected＝つながっていない。 */
type InstagramStatus = 'idle' | 'loading' | 'ready' | 'permission_required' | 'disconnected' | 'error'

const NOT_CONNECTED = 'この受信経路はつながっていません。'
const EMAIL_STATUS_FAILED = 'メールの接続状態を読み込めませんでした。'

/**
 * 受信箱の受信経路のタブ。選んだ経路は URL の ?channel= に残す（戻る・共有で同じタブに戻る）。
 * 未接続の経路は、管理者なら設定へ進み、閲覧のみなら管理者への依頼を出す。URL で開いただけでは移動しない。
 * Instagram は DM の権限が無い時もタブは開き（届いた会話は読める）、権限が無いことと、つなぎ直す先を出す。
 */
export function InboxChannelTabs() {
  const params = useSearchParams()
  const router = useRouter()
  const { selectedAccountId, selectedAccount, loading, error, refreshAccounts } = useAccount()
  const role = useStaffRole()
  const requested = params.get('channel')
  const current: Channel = requested === 'line' || requested === 'email' || requested === 'instagram' ? requested : 'all'
  const [instagram, setInstagram] = useState<InstagramStatus>('idle')
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<Channel | null>(null)
  const [message, setMessage] = useState('')
  const statusRequest = useRef(0)

  useEffect(() => { setInstagram('idle'); setPending(null); setMessage('') }, [selectedAccountId])
  useEffect(() => { setMessage('') }, [current])
  const wantsInstagram = pending === 'instagram' || current === 'instagram'
  useEffect(() => {
    if (!wantsInstagram || !selectedAccountId) return
    const request = ++statusRequest.current
    setInstagram('loading')
    void api.instagram.inboxStatus(selectedAccountId).then(result => {
      if (request !== statusRequest.current) return
      const state = result.success ? result.data?.state : undefined
      setInstagram(state === 'ready' || state === 'permission_required' || state === 'disconnected' ? state : 'error')
    }).catch(() => { if (request === statusRequest.current) setInstagram('error') })
    return () => { statusRequest.current += 1 }
  }, [selectedAccountId, wantsInstagram, attempt])

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
    if (!navigate) { setMessage(NOT_CONNECTED); return }
    router.push('/settings/sns')
  }
  // 押した Instagram は、状態が分かってから行き先を決める（分かるまで未接続と決めつけない）。
  useEffect(() => {
    if (pending !== 'instagram') return
    if (instagram === 'ready' || instagram === 'permission_required') select('instagram')
    else if (instagram === 'disconnected') notConnected()
  // The pending request is resolved against the latest account and role.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, instagram, role])
  useEffect(() => {
    if (current !== 'email' || loading || !selectedAccountId) return
    if (error || !selectedAccount || (selectedAccount.emailInboxEnabled === undefined && selectedAccount.accountEmailInboxEnabled === undefined)) {
      setMessage(EMAIL_STATUS_FAILED)
    } else if (!selectedAccount.emailInboxEnabled && !selectedAccount.accountEmailInboxEnabled) {
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
      if (instagram === 'ready' || instagram === 'permission_required') select('instagram')
      else if (instagram === 'disconnected') notConnected()
      else { setPending(channel); if (instagram === 'error') setAttempt(value => value + 1) }
      return
    }
    if (channel === 'email') {
      if (error) { setMessage(EMAIL_STATUS_FAILED); return }
      if (loading || !selectedAccountId) { setMessage('接続状態を確認しています。'); return }
      if (error || !selectedAccount || (selectedAccount.emailInboxEnabled === undefined && selectedAccount.accountEmailInboxEnabled === undefined)) { setMessage(EMAIL_STATUS_FAILED); return }
      if (!selectedAccount.emailInboxEnabled && !selectedAccount.accountEmailInboxEnabled) { if (role === null) setPending('email'); notConnected(); return }
    }
    select(channel)
  }
  const toSettings = <Button variant="text" size="inline" onClick={() => router.push('/settings/sns')}>設定へ</Button>
  const retryInstagram = <Button variant="text" size="inline" onClick={() => setAttempt(value => value + 1)}>読み直す</Button>
  const onInstagram = current === 'instagram'
  const hasNotice = Boolean(message)
    || (wantsInstagram && (instagram === 'loading' || instagram === 'error'))
    || (onInstagram && (instagram === 'disconnected' || instagram === 'permission_required'))
  return <>
    <Tabs label="受信経路" size="compact" items={([
      ['all', 'すべて'], ['line', 'LINE'], ['instagram', 'Instagram'], ['email', 'メール'],
    ] as const).map(([id, label]) => ({ label, current: current === id, onClick: () => choose(id) }))} />
    {/* 帯はタブの横に並べず、タブの下の1段に出す（一覧が広い幅でもタブの行に入り込まない）。 */}
    {hasNotice ? <NoticeStack>
      {wantsInstagram && instagram === 'loading' ? <Notice tone="info" message="Instagram の接続状態を確認しています。" /> : null}
      {wantsInstagram && instagram === 'error' ? <Notice tone="warn" message="Instagram の接続状態を読み込めませんでした。" action={retryInstagram} /> : null}
      {onInstagram && instagram === 'disconnected' ? (
        <Notice tone="warn" message={role === 'viewer' ? 'Instagram がつながっていません。管理者につないでもらってください。' : 'Instagram がつながっていません。設定でつなぐと、DM がここに届きます。'} action={role === 'viewer' ? undefined : toSettings} />
      ) : null}
      {onInstagram && instagram === 'permission_required' ? (
        <Notice tone="warn" message={role === 'viewer' ? 'DM の権限がありません。管理者に Instagram をつなぎ直してもらってください。' : 'DM の権限がありません。返信するには、設定で Instagram をつなぎ直してください。'} action={role === 'viewer' ? undefined : toSettings} />
      ) : null}
      {message ? <Notice tone="info" message={message} action={message === NOT_CONNECTED ? toSettings : (error || message === EMAIL_STATUS_FAILED) ? <Button variant="text" size="inline" onClick={() => void refreshAccounts()}>読み直す</Button> : undefined} /> : null}
    </NoticeStack> : null}
  </>
}
