'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, Copy, Mail, RefreshCw, Send } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import CopyTextButton from '@/components/shared/copy-text-button'
import { CustomerInfoRows } from '@/components/shared/customer-info-rows'
import Dialog from '@/components/shared/dialog'
import Disclosure from '@/components/shared/disclosure'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { isSaveConflict } from '@/components/shared/save-conflict'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { TextField } from '@/components/shared/text-field'
import { notifyToast } from '@/components/shared/toast'
import { useAccount } from '@/contexts/account-context'
import { api, type AccountEmailConnection, type AccountEmailStatus } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { ACCOUNT_EMAIL_CONNECTION_STATUS, ACCOUNT_EMAIL_RECEIVE_ONLY_NOTE } from '@/lib/status-labels'
import { startVisiblePoll, type VisiblePollHandle } from '@/lib/visible-polling'
import snsStyles from './sns.module.css'
import styles from './email-card.module.css'
import { EmailForwardingGuide } from './email-forwarding-guide'
import {
  emailConnectionFailureMessage,
  emailIssueCopy,
  forwardingConfirmationView,
  isActiveEmailConnection,
  isWaitingEmailConnection,
  mailboxInputError,
} from './email-connection-model'

const CAPABILITIES = ['お店のメールアドレスに届いたメールを受信箱で読めます', '添付ファイルを受信箱から保存できます']
/** 返信の案内。受信箱の店舗の会話の返信欄の吹き出しと同じ言葉。 */
const REPLY_NOTE = ACCOUNT_EMAIL_RECEIVE_ONLY_NOTE
const LIMIT_NOTE = 'お店のドメインや DNS の設定は要りません。添付は最大16件で、メール全体の上限は10 MiBです。'
/** 転送用アドレスなどを見られない人へ出す理由。値が無いのではなく見せないことを伝える。 */
const HIDDEN_REASON = 'オーナーか管理者だけが見られます'
/** 受信を再確認したあと、状態が変わったかを読み直す長さ。 */
const RECHECK_WATCH_MS = 10 * 60 * 1000

type Busy = 'issue' | 'verify' | 'disconnect' | null

/**
 * 設定 › メール・SNS連携の「メール」の枠。お店のメールアドレスに届くメールを、転送用アドレスで受信箱へ取り込む。
 * 「メールをつなぐ」→転送用アドレスのコピー→使っているメールの数行の手順→届いた確認コードのコピー→確認メール→接続済み、
 * までをこの枠だけで終えられるようにする。権限が無い人にも操作は消さず、理由を添えて押せない形で置く。
 */
export function EmailConnectionCard({ accountId, canManage, lockedReason }: { accountId: string | null; canManage: boolean; lockedReason: string }) {
  const { accounts, refreshAccounts } = useAccount()
  const [connection, setConnection] = useState<AccountEmailConnection | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [actionError, setActionError] = useState('')
  const [issueOpen, setIssueOpen] = useState(false)
  const [mailboxDraft, setMailboxDraft] = useState('')
  const [mailboxError, setMailboxError] = useState('')
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [pollStalled, setPollStalled] = useState(false)
  const accountRef = useRef(accountId)
  accountRef.current = accountId
  const versionRef = useRef(0)
  const visible = loadedFor === accountId ? connection : null
  const statusRef = useRef<AccountEmailStatus | null>(null)
  statusRef.current = visible?.status ?? null
  const watchUntilRef = useRef(0)
  /** 解除の確かめの窓で見ている接続。窓を開いた時の接続の id だけを解除する。 */
  const disconnectTicket = useRef<{ accountId: string; connectionId: string | null } | null>(null)
  const pollRef = useRef<VisiblePollHandle | null>(null)
  const inboxReceiving = accounts.find((account) => account.id === accountId)?.accountEmailInboxEnabled === true
  /*
   * 入力は「メールをつなぐ」窓のお店のメールアドレスだけ。窓の閉じる操作は共通 Dialog の破棄確認が守り、
   * 窓を開いたままの戻る・再読込・アカウントの切り替えなどは、ここで離れる前に確かめる。
   */
  const mailboxDirty = issueOpen && mailboxDraft.trim() !== (visible?.mailbox ?? '')
  const leaveGuard = useUnsavedGuard({
    dirty: mailboxDirty || busy === 'issue',
    busy: busy === 'issue',
    subject: '入力したお店のメールアドレス',
    onDiscard: () => {
      setIssueOpen(false)
      setMailboxDraft('')
      setMailboxError('')
      setActionError('')
    },
  })

  /** 読み直し。静かな読み直し（定期）の失敗は、いま出ている状態を消さない。 */
  const load = useCallback(async (quiet = false): Promise<boolean> => {
    const target = accountId
    if (!target) return true
    const version = ++versionRef.current
    const stale = () => version !== versionRef.current || accountRef.current !== target
    try {
      const res = await api.accountEmail.connection(target)
      if (stale()) return true
      if (!res.success || !res.data?.status) throw new Error('メールの接続の状態を読み取れませんでした。')
      setConnection(res.data)
      setLoadError(null)
      setLoadedFor(target)
      return true
    } catch (error) {
      if (stale()) return true
      if (!quiet) {
        setConnection(null)
        setLoadError(error)
        setLoadedFor(target)
      }
      return false
    }
  }, [accountId])

  /* 確かめの途中（設定中・受信確認待ち）と、受信を再確認した直後だけ読み直し続ける。
     Gmail・Yahoo!メールの確認コードも、この読み直しで届いたらすぐ出る。 */
  useEffect(() => {
    setBusy(null)
    setActionError('')
    setIssueOpen(false)
    setDisconnectOpen(false)
    setMailboxDraft('')
    setMailboxError('')
    setPollStalled(false)
    watchUntilRef.current = 0
    disconnectTicket.current = null
    if (!accountId) return
    let first = true
    const poll = startVisiblePoll({
      immediate: true,
      shouldPoll: () => isWaitingEmailConnection(statusRef.current) || watchUntilRef.current > Date.now(),
      work: async () => {
        const loud = first
        first = false
        if (!(await load(!loud))) throw new Error('メールの接続の状態を読み取れませんでした。')
      },
      onGiveUp: () => setPollStalled(true),
      onRecovered: () => setPollStalled(false),
    })
    pollRef.current = poll
    return () => {
      if (pollRef.current === poll) pollRef.current = null
      poll.stop()
    }
  }, [accountId, load])

  /* 接続済みになった・接続済みでなくなったら、受信箱の「メール」が見えるかの旗を読み直す。 */
  const previousStatus = useRef<AccountEmailStatus | null>(null)
  const visibleStatus = visible?.status ?? null
  useEffect(() => {
    const before = previousStatus.current
    previousStatus.current = visibleStatus
    if (before === null || visibleStatus === null || before === visibleStatus) return
    if ((before === 'connected') !== (visibleStatus === 'connected') || visibleStatus === 'revoked') void refreshAccounts()
  }, [visibleStatus, refreshAccounts])

  const retry = () => {
    setPollStalled(false)
    void load().then(() => pollRef.current?.wake())
  }

  /** 操作の返事をそのまま採る。走っている読み直しの古い返事は捨てる。 */
  const apply = (target: string, next: AccountEmailConnection) => {
    versionRef.current += 1
    setConnection(next)
    setLoadError(null)
    setLoadedFor(target)
  }

  const openIssue = () => {
    if (!canManage || busy) return
    setMailboxDraft(visible?.mailbox ?? '')
    setMailboxError('')
    setActionError('')
    setIssueOpen(true)
  }

  const issue = async () => {
    const target = accountId
    if (!target || !canManage || busy) return
    const invalid = mailboxInputError(mailboxDraft)
    if (invalid) { setMailboxError(invalid); return }
    setBusy('issue')
    setActionError('')
    try {
      const res = await api.accountEmail.issue(target, mailboxDraft.trim())
      if (accountRef.current !== target) return
      if (!res.success) throw new Error(res.error)
      apply(target, res.data)
      setIssueOpen(false)
      setMailboxDraft('')
      notifyToast('転送用アドレスを発行しました。続けて、お店のメールで転送を設定してください。', { tone: 'success' })
      pollRef.current?.wake()
    } catch (error) {
      if (accountRef.current !== target) return
      setActionError(emailConnectionFailureMessage(error, 'issue'))
      if (isSaveConflict(error)) void load(true)
    } finally {
      if (accountRef.current === target) setBusy(null)
    }
  }

  const verify = async () => {
    const target = accountId
    if (!target || !canManage || busy) return
    const wasConnected = visible?.status === 'connected'
    setBusy('verify')
    setActionError('')
    try {
      const res = await api.accountEmail.verify(target)
      if (accountRef.current !== target) return
      if (!res.success) throw new Error(res.error)
      apply(target, res.data)
      watchUntilRef.current = Date.now() + RECHECK_WATCH_MS
      notifyToast(wasConnected
        ? 'お店のメールアドレスに確認メールを送りました。確認が済むまで、届いたメールはこれまでどおり受信箱に入ります。'
        : 'お店のメールアドレスに確認メールを送りました。転送されて届くと「接続済み」に変わります。', { tone: 'success' })
      pollRef.current?.wake()
    } catch (error) {
      if (accountRef.current === target) setActionError(emailConnectionFailureMessage(error, 'verify'))
    } finally {
      if (accountRef.current === target) setBusy(null)
    }
  }

  const openDisconnect = () => {
    if (!accountId || !canManage || busy) return
    disconnectTicket.current = { accountId, connectionId: visible?.connectionId ?? null }
    setActionError('')
    setDisconnectOpen(true)
  }

  const closeDisconnect = () => {
    if (busy === 'disconnect') return
    disconnectTicket.current = null
    setDisconnectOpen(false)
    setActionError('')
  }

  const disconnect = async () => {
    const target = accountId
    const ticket = disconnectTicket.current
    if (!target || !canManage || busy || !ticket || ticket.accountId !== target) return
    /* 見ている接続の id が分からないときは解除しない。読み直して、もう一度確かめてもらう。 */
    if (!ticket.connectionId) {
      setActionError('解除する接続を確かめられませんでした。読み直したので、もう一度お試しください。')
      disconnectTicket.current = null
      setDisconnectOpen(false)
      void load(true)
      return
    }
    setBusy('disconnect')
    setActionError('')
    try {
      const res = await api.accountEmail.disconnect(target, ticket.connectionId)
      if (accountRef.current !== target) return
      if (!res.success) throw new Error(res.error)
      apply(target, res.data)
      disconnectTicket.current = null
      setDisconnectOpen(false)
      watchUntilRef.current = 0
      notifyToast('メールの接続を解除しました。お店のメールの転送の設定も止めてください。', { tone: 'success' })
    } catch (error) {
      if (accountRef.current !== target) return
      /* 競合時は最新の接続を読み直して再確認を促す。 */
      if (isSaveConflict(error)) {
        disconnectTicket.current = null
        setDisconnectOpen(false)
        setActionError('メールの接続が更新されました。最新の状態を確かめて、もう一度操作してください。')
        void load(true)
        return
      }
      setActionError(emailConnectionFailureMessage(error, 'disconnect'))
    } finally {
      if (accountRef.current === target) setBusy(null)
    }
  }

  const status = visible?.status ?? null
  const badge = status ? ACCOUNT_EMAIL_CONNECTION_STATUS[status] : null
  const locked = canManage ? undefined : lockedReason
  const confirmation = forwardingConfirmationView(visible?.forwardingConfirmation)
  const issueCopy = emailIssueCopy(visible?.issue, { wasConnected: status === 'connected' || Boolean(visible?.checkedAt) })
  /* 窓が開いている間の失敗は窓の中、閉じているときは枠の中に出す。 */
  const cardError = actionError && !issueOpen && !disconnectOpen ? actionError : ''

  const capabilities = (connected: boolean) => (
    <>
      <p className={snsStyles.listTitle}>{connected ? 'できること' : 'つなぐとできること'}</p>
      <ul className={snsStyles.checks}>
        {CAPABILITIES.map((text) => <li key={text}><Check size={16} aria-hidden className={snsStyles.checkMark} />{text}</li>)}
      </ul>
    </>
  )

  /*
   * 転送用アドレスは打ち込む欄ではないので、読み取り専用の文字と［コピーする］で出す（1行で省略し、全文は吹き出し）。
   * 見られない人には値の代わりに理由を出し、［コピーする］は理由つきの押せない形にする。
   */
  const addressRow = {
    label: '転送用アドレス',
    value: (
      <span className={styles.copyText}>
        <TruncatedText value={visible?.address ?? HIDDEN_REASON} />
        {visible?.address
          ? <CopyTextButton variant="text" size="inline" icon={<Copy size={16} aria-hidden />} label="コピーする" value={visible.address} aria-label="転送用アドレスをコピーする" />
          : <Button variant="text" size="inline" lockedReason={HIDDEN_REASON}><Copy size={16} aria-hidden />コピーする</Button>}
      </span>
    ),
  }
  const addressField = <CustomerInfoRows rows={[addressRow]} />

  const confirmationField = confirmation ? (
    <>
      {/* 確認コード・確認用の URL も読み取り専用の値なので、転送用アドレスと同じく文字と［コピーする］で出す。 */}
      <CustomerInfoRows
        rows={[{
          label: confirmation.kind === 'url' ? '届いた確認用の URL' : '届いた確認コード',
          value: (
            <span className={styles.copyText}>
              <TruncatedText value={confirmation.text} url={confirmation.kind === 'url'} />
              <CopyTextButton
                variant="text"
                size="inline"
                icon={<Copy size={16} aria-hidden />}
                label="コピーする"
                value={confirmation.text}
                aria-label={confirmation.kind === 'url' ? '確認用の URL をコピーする' : '確認コードをコピーする'}
              />
            </span>
          ),
        }]}
      />
      <p className={snsStyles.note}>
        {confirmation.kind === 'url'
          ? 'この URL をコピーし、ブラウザのアドレス欄に貼り付けて開くと、転送先の確認が終わります。'
          : 'このコードをコピーし、お使いのメールの確認コードの欄に貼り付けてください。'}
      </p>
    </>
  ) : canManage ? (
    <p className={snsStyles.note}>Gmail・Yahoo!メールの確認コードはここに表示されます。届かないときは、登録した転送先を確認してメールサービス側で送り直してください。</p>
  ) : null

  const disconnectAction = (
    <div className={snsStyles.actions}>
      <Button
        variant="text"
        textTone="danger"
        onClick={openDisconnect}
        disabled={Boolean(busy)}
        lockedReason={locked}
      >
        接続を解除する
      </Button>
    </div>
  )

  const stalledNotice = pollStalled ? (
    <Notice
      tone="warn"
      compact
      message="接続の状態を読み直せていません。通信を確かめてから読み直してください。"
      action={<Button variant="text" size="inline" onClick={retry}>読み直す</Button>}
    />
  ) : null

  let body: ReactNode
  if (!accountId) {
    body = <ListState kind="empty" title="LINEアカウントを選んでください" description="画面右上で接続先のLINEアカウントを選んでください。" />
  } else if (loadError && !visible) {
    body = <ListState kind="error" error={loadError} onRetry={retry} />
  } else if (!visible) {
    body = <ListState kind="loading" />
  } else if (!isActiveEmailConnection(visible.status)) {
    body = (
      <>
        <p className={snsStyles.cardSub}>
          {visible.status === 'revoked'
            ? '前の転送用アドレスは解除してあり、届いたメールは取り込みません。もう一度つなぐときは、新しい転送用アドレスでお店のメールの転送を設定し直してください。'
            : 'お店のメールアドレスに届くメールを、転送で受信箱に取り込みます。お店のメールで転送を設定するだけで、この画面の中で最後までつなげます。'}
        </p>
        {capabilities(false)}
        <p className={snsStyles.note}>{REPLY_NOTE}</p>
        <div className={snsStyles.actions}>
          <Button variant="primary" onClick={openIssue} disabled={Boolean(busy)} lockedReason={locked}>
            <Mail size={16} aria-hidden />
            メールをつなぐ
          </Button>
        </div>
        <p className={snsStyles.foot}>{LIMIT_NOTE}</p>
      </>
    )
  } else if (visible.status === 'connected') {
    body = (
      <>
        {issueCopy ? <Notice tone="warn" compact heading={issueCopy.title}>{issueCopy.fix}</Notice> : null}
        {stalledNotice}
        <p className={snsStyles.cardSub}>お店のメールアドレスに届いたメールが、受信箱に入ります。</p>
        <CustomerInfoRows
          rows={[
            addressRow,
            { label: 'お店のメールアドレス', value: visible.mailbox ?? HIDDEN_REASON },
            { label: '最後に受信を確かめた日時', value: visible.checkedAt ? formatDate(visible.checkedAt, { style: 'detail' }) : '—' },
          ]}
        />
        <div className={snsStyles.btnRow}>
          <Link className={snsStyles.link} href="/chats?channel=email">受信箱で見る<ArrowRight size={16} aria-hidden /></Link>
        </div>
        {capabilities(true)}
        <p className={snsStyles.note}>{REPLY_NOTE}</p>
        <Disclosure appearance="inset" size="compact" title="転送の設定のしかた">
          <EmailForwardingGuide />
        </Disclosure>
        <div className={snsStyles.actions}>
          <Button variant="secondary" onClick={() => void verify()} disabled={Boolean(busy)} busy={busy === 'verify'} busyLabel="送信中…" lockedReason={locked}>
            <RefreshCw size={16} aria-hidden />
            受信を再確認する
          </Button>
        </div>
        <p className={snsStyles.foot}>受信を再確認すると、お店のメールアドレスに確認メールを送ります。確認が済むまで、届いたメールはこれまでどおり受信箱に入ります。</p>
        {disconnectAction}
      </>
    )
  } else {
    /* 設定中・受信確認待ち：1〜3 の順に、この枠の中だけで最後まで進める。 */
    const pending = visible.status === 'pending'
    body = (
      <>
        {issueCopy ? <Notice tone="warn" compact heading={issueCopy.title}>{issueCopy.fix}</Notice> : null}
        {stalledNotice}
        {pending && inboxReceiving ? <p className={snsStyles.note}>確認が済むまで、届いたメールはこれまでどおり受信箱に入ります。</p> : null}
        <ol className={styles.flow}>
          <li className={styles.flowStep}>
            <h3 className={styles.flowTitle}>1. 転送用アドレスをコピーする</h3>
            {addressField}
            <p className={snsStyles.note}>{`お店のメールアドレス：${visible.mailbox ?? HIDDEN_REASON}`}</p>
          </li>
          <li className={styles.flowStep}>
            <h3 className={styles.flowTitle}>2. お使いのメールで転送を設定する</h3>
            <EmailForwardingGuide />
            {confirmationField}
          </li>
          <li className={styles.flowStep}>
            <h3 className={styles.flowTitle}>3. 確認メールを送る</h3>
            <p className={snsStyles.note}>
              {pending
                ? 'お店のメールアドレスに確認メールを送りました。転送されて届くと「接続済み」に変わります。数分かかることがあります。'
                : '転送を設定したら、お店のメールアドレスに確認メールを送ります。転送されて届くと「接続済み」に変わります。'}
            </p>
            <div className={snsStyles.actions}>
              <Button
                variant={pending ? 'secondary' : 'primary'}
                onClick={() => void verify()}
                disabled={Boolean(busy)}
                busy={busy === 'verify'}
                busyLabel="送信中…"
                lockedReason={locked}
              >
                <Send size={16} aria-hidden />
                {pending ? '確認メールを送り直す' : '確認メールを送る'}
              </Button>
            </div>
          </li>
        </ol>
        <p className={snsStyles.foot}>{LIMIT_NOTE}</p>
        {disconnectAction}
      </>
    )
  }

  return (
    <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-labelledby="sns-email-title">
      <div className={snsStyles.cardHead}>
        <span className={snsStyles.mark}><Mail size={20} aria-hidden /></span>
        <h2 id="sns-email-title" className={snsStyles.cardTitle}>メール</h2>
        {badge ? <StatusBadge tone={badge.tone} size="compact" dot={false}>{badge.label}</StatusBadge> : null}
        <span className={snsStyles.rowSpacer} />
      </div>
      {body}
      {cardError ? <Notice tone="danger" compact message={cardError} /> : null}

      <Dialog
        open={issueOpen}
        title="メールをつなぐ"
        designWidth={560}
        busy={busy === 'issue'}
        busyLabel="発行中…"
        dirty={mailboxDirty}
        error={issueOpen && actionError ? actionError : undefined}
        confirmLabel="転送用アドレスを発行する"
        confirmLockedReason={locked}
        onConfirm={() => void issue()}
        onCancel={() => {
          if (busy === 'issue') return
          setIssueOpen(false)
          setActionError('')
          setMailboxError('')
        }}
      >
        <Field
          label="お店のメールアドレス"
          htmlFor="sns-email-mailbox"
          required
          error={mailboxError || undefined}
          note="お客さまからのメールが届いているアドレスです。転送の確認メールもここに送ります。"
        >
          <TextField
            id="sns-email-mailbox"
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={254}
            placeholder="shop@example.com"
            value={mailboxDraft}
            onChange={(event) => { setMailboxDraft(event.target.value); setMailboxError('') }}
          />
        </Field>
        <p className={snsStyles.note}>このアドレス専用の転送用アドレスを発行します。お店のメールで、そのアドレスへの転送を設定します。お店のドメインや DNS の設定は要りません。</p>
        {/* 窓の中に置き、確かめは窓より上に重ねる。 */}
        <UnsavedLeaveDialog
          open={leaveGuard.leaveTarget !== null}
          subject="入力したお店のメールアドレス"
          busy={busy === 'issue'}
          onConfirm={leaveGuard.confirmLeave}
          onCancel={leaveGuard.cancelLeave}
        />
      </Dialog>

      <ConfirmDialog
        open={disconnectOpen}
        title="メールの接続を解除しますか？"
        description="転送用アドレスは使えなくなり、届いたメールは受信箱に取り込まれなくなります。お店のメールの転送の設定も止めてください。Yahoo!メールで転送している場合は、自動転送を止めたうえで、連絡用メールアドレスに入れた転送用アドレスも見直してください。もう一度つなぐときは、新しい転送用アドレスを発行します。"
        confirmLabel="解除する"
        destructive
        busy={busy === 'disconnect'}
        busyLabel="解除中…"
        error={disconnectOpen && actionError ? actionError : undefined}
        confirmLockedReason={locked}
        onConfirm={() => void disconnect()}
        onCancel={closeDisconnect}
      />
    </Card>
  )
}
