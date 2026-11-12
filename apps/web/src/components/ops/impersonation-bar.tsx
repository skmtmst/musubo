'use client'

import { Eye, PencilLine } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, type OpsImpersonation } from '@/lib/api'
import { opsCall } from '@/components/ops/ops-ui'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import NoteBar from '@/components/shared/note-bar'
import { TextArea } from '@/components/shared/text-field'
import { RequiredBadge } from '@/components/shared/form-controls'
import { deferImpersonationSnapshot, forgetSessionSnapshot, readPermissionSessionSnapshot, readSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { forgetAuthCheck } from '@/lib/auth-check-marker'
import { formatListTimestamp } from '@/lib/format'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'

/** 帯の「10/1 15:20」（日本時間）。 */
function startedLabel(iso: string): string {
  return formatListTimestamp(iso, { fallback: '' })
}

/**
 * 代理ログイン帯（★管理画面 37 共通 `WXp5T`）。代理ログイン中は全画面の上に常時出す。
 *
 * - 閲覧中（赤 `status-danger`）: 「◯◯ として閲覧中（書き込みはできません）」
 * - 書き込み中（濃い赤 `danger`）: 「◯◯ として書き込み中」
 * - 時間制限は無い。終わるのは「代理ログインを終える」を押したときだけ
 * - 書き込みへの切り替え（37-5-A）と個人情報の表示（37-5-B）は理由が必須
 */
export default function ImpersonationBar({
  initial,
  onChange,
}: {
  initial: OpsImpersonation
  onChange?: (next: OpsImpersonation | null) => void
}) {
  const router = useRouter()
  const [state, setState] = useState<OpsImpersonation>(initial)
  const [dialog, setDialog] = useState<{ kind: 'write' | 'pii'; target: OpsImpersonation } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const update = async (next: OpsImpersonation) => {
    // 再読込時に切替前の控えを復元させず、今の画面には確定したモードをすぐ配る。
    forgetAuthCheck()
    const known = readSessionSnapshot()
    if (known) {
      rememberSessionSnapshot({ ...known, impersonation: next })
    } else {
      const pending = deferImpersonationSnapshot(next)
      setState({ ...next, mode: 'read' })
      try {
        const body = await api.auth.session()
        const data = body?.success ? body.data : null
        if (!data || data.impersonation?.id !== next.id || data.impersonation.tenantId !== next.tenantId || data.impersonation.mode !== next.mode) throw new Error('session not confirmed')
        // 別の認証確認が先に終わっていたら、この古い読込で上書きしない。
        if (readPermissionSessionSnapshot() !== pending) return
        rememberSessionSnapshot({
          impersonation: { ...data.impersonation, tenantName: next.tenantName },
          unfamiliarAt: typeof data.unfamiliarAt === 'string' ? data.unfamiliarAt : null,
          stepUpMethod: data.stepUpMethod === 'totp' || data.stepUpMethod === 'password' ? data.stepUpMethod : 'none',
        })
      } catch {
        setError('切り替え後のログインを確認できませんでした。書き込みを止めています。画面を読み直してください。')
        return
      }
    }
    setState(next)
    onChange?.(next)
  }

  const toRead = async () => {
    setBusy(true)
    const res = await opsCall(api.ops.impersonation.read())
    if (res.success) { setError(''); await update({ ...state, mode: 'read' }) }
    setBusy(false)
  }

  const end = async () => {
    setBusy(true)
    const res = await opsCall(api.ops.impersonation.end())
    setBusy(false)
    if (res.success) {
      forgetSessionSnapshot()
      onChange?.(null)
      router.push('/ops/tenants')
      router.refresh()
    }
  }

  const submitReason = async (reason: string) => {
    if (!dialog) return
    if (dialog.target.id !== state.id || dialog.target.id !== initial.id || dialog.target.tenantId !== state.tenantId || dialog.target.tenantId !== initial.tenantId) {
      setError('代理ログインが変わりました。読み直してから、もう一度選んでください。')
      return
    }
    setBusy(true)
    setError('')
    const res = dialog.kind === 'write'
      ? await opsCall(api.ops.impersonation.write(reason, dialog.target.id))
      : await opsCall(api.ops.impersonation.revealPii(reason, dialog.target.id))
    if (!res.success) { setBusy(false); setError(res.error || '切り替えできませんでした。時間をおいて、もう一度お試しください。'); return }
    await update({ ...dialog.target, ...res.data, tenantName: dialog.target.tenantName })
    setBusy(false)
    setDialog(null)
    router.refresh()
  }

  const writing = state.mode === 'write'
  const name = state.tenantName ?? '契約先'
  const started = startedLabel(state.startedAt)

  return (
    <>
      <Notice tone={writing ? 'danger' : 'warn'} role="status"
        data-design-node={writing ? 'WXp5T' : 'VtJQ6'}
        icon={writing ? <PencilLine aria-hidden="true" /> : <Eye aria-hidden="true" />}
        heading={writing
          ? <>{name} として書き込み中{state.piiRevealed ? '・個人情報を表示中' : ''}</>
          : `代理ログイン中：${name}（閲覧のみ）${state.piiRevealed ? '・個人情報を表示中' : ''}`}
        action={<>
          {!state.piiRevealed ? <Button type="button" onClick={() => setDialog({ kind: 'pii', target: state })} disabled={busy}>個人情報を表示する</Button> : null}
          {writing
            ? <Button type="button" onClick={() => void toRead()} disabled={busy}>閲覧のみに戻す</Button>
            : <Button type="button" onClick={() => setDialog({ kind: 'write', target: state })} disabled={busy}>書き込みに切り替える</Button>}
          <Button type="button" variant="primary" onClick={() => void end()} disabled={busy}>代理ログインを終える</Button>
        </>}
      >{!dialog && error ? error : !writing && started ? `${started}〜` : null}</Notice>
      {dialog ? (
        <ReasonDialog
          kind={dialog.kind}
          target={dialog.target}
          busy={busy}
          error={error}
          onClose={() => { setDialog(null); setError('') }}
          onSubmit={submitReason}
        />
      ) : null}
    </>
  )
}

/** 理由の入力（37-5-A `Ve2FS` / 37-5-B `oVhwg`）。共通の確認ダイアログに入力欄を載せる。 */
function ReasonDialog({
  kind,
  target,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  kind: 'write' | 'pii'
  target: OpsImpersonation
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const write = kind === 'write'
  const ready = reason.trim().length >= 4
  return (
    <ConfirmDialog
      open
      designNode={write ? 'Ve2FS' : 'oVhwg'}
      title={write ? '書き込みに切り替えますか？' : '個人情報を表示しますか？'}
      description={write
        ? 'ここから先の操作は、契約先のデータを実際に書き換えます。書き込みをすると、契約先の画面にも履歴が残ります。'
        : '友だちの氏名や会話の中身が見えるようになります。代理ログインを終えると、もとの伏せた表示に戻ります。'}
      confirmLabel={write ? '書き込みに切り替える' : '表示する'}
      confirmIcon={false}
      destructive
      busy={busy}
      error={error}
      confirmDisabled={!ready}
      onConfirm={() => { if (ready) void onSubmit(reason.trim()) }}
      onCancel={() => { if (!busy) onClose() }}
    >
      <div className="flex flex-col gap-3">
        <OperationTargetSummary accounts={[]} externalTarget={{ label: '契約先', name: target.tenantName?.trim() || '不明' }} />
        <label className="block">
          <span className="mb-1.5 block text-caption font-medium text-ink">理由<RequiredBadge /><span className="font-medium text-ink-faint">（4文字以上）</span></span>
          <TextArea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            placeholder={write ? '例：お問い合わせ #2481。回答フォームの送信先タグが外れているため付け直します。' : '例：お問い合わせ #2481。配信が届かない友だちを特定するため。'}
          />
        </label>
        <NoteBar tone="warn">
          {write
            ? '解約・権限者の削除・LINE公式アカウントの削除は、運営でも行えません'
            : '表示した記録は、日時・運営者・契約先・理由とともに監査ログに残ります'}
        </NoteBar>
      </div>
    </ConfirmDialog>
  )
}
