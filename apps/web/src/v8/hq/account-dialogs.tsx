'use client'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { lineAccountConnectionState } from '@/lib/line-account-state'
import { requiredText } from '@/lib/form-requirement'
const accountNameRequirement = requiredText('名前を入力してください。')

import { useContext, useEffect, useRef, useState } from 'react'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { Pencil, RotateCcw, Users } from 'lucide-react'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OtpInput, { otpFailureMessage } from '@/components/shared/otp-input'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import FolderSelect, { folderById, folderCreator } from '@/components/shared/folder-select'
import { TextField } from '@/components/shared/text-field'
import { api } from '@/lib/api'
import { describeApiFailure } from '@/components/shared/api-error-message'
import type { Folder } from '@line-crm/shared'
import type { AccountWithStats } from '@/contexts/account-context'
import head from './dialog-head.module.css'
import styles from './account-dialogs.module.css'
import { FALLBACK_REASON, connectionReasons, lineHandle } from '@/lib/line-account-connection-reasons'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 統括のアカウントの3つの窓（板  設定・ アーカイブ・ 戻す）。
 * 統括ホームのカードの「設定」・「戻す」から開く。
 * 読み書きの口・本人確認は 管理画面（app/hq/account-settings-dialogs.tsx）と同じ（import できないので写した）。
 * 設定の窓だけ、見た目を絵  どおりに組み直した。
 */

/** 絵  の窓の幅と上からの位置（px）。 */
const SETTINGS_WIDTH = 560
const SETTINGS_TOP = 200
/** 絵の の窓の幅と上からの位置（px）。 */
const ARCHIVE_WIDTH = 520
const ARCHIVE_TOP = 240
const RESTORE_TOP = 220

async function stepUpToken(code: string): Promise<string> {
  const res = await api.auth.stepUp({ method: 'totp', value: code, purpose: 'line_account.archive' })
  if (!res.success) throw new Error(res.error || '認証コードを確認できませんでした。時間をおいて、もう一度お試しください。')
  return res.data.token
}

/** 窓に出す呼び名。「然 -NEN- 渋谷店（@nen-shibuya）」。@ は付けて返す（LINE の basicId は @ 付きで来るので二重にしない）。 */
export function accountHandle(account: AccountWithStats): string {
  return lineHandle(account)
}

/* 板 ：アカウントの設定（名前・フォルダ・ほかの設定・アーカイブ）。2026-10-08 タグ→フォルダ（1つだけ・API-17）。 */
export function AccountSettingsDialogV8({ account, archived, onClose, onSaved, onArchive, onEditRegistration, canCreateFolder = false, onFolderCreated }: {
  account: AccountWithStats
  archived: boolean
  onClose: () => void
  onSaved: () => void
  onArchive: () => void
  onEditRegistration: () => void
  /** フォルダを選ぶ欄からその場で作れるか（左の列の「フォルダを追加」と同じ権限）。 */
  canCreateFolder?: boolean
  /** その場でフォルダを作ったとき（左の列を読み直す）。 */
  onFolderCreated?: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const [name, setName] = useState(account.name)
  const [nameError, setNameError] = useState('')
  const initialFolder = (account as { folderId?: string | null }).folderId ?? ''
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderState, setFolderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [folderAttempt, setFolderAttempt] = useState(0)
  const [folderId, setFolderId] = useState<string>(initialFolder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const savedName = useRef(account.name)
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: name !== savedName.current || folderId !== initialFolder || busy, busy, subject: 'アカウント設定の変更', onDiscard: onClose })

  useEffect(() => {
    let cancelled = false
    setFolderState('loading')
    void api.lineAccountFolders.list().then((res) => {
      if (!res.success || !Array.isArray(res.data?.folders)) throw new Error('folder list unavailable')
      if (!cancelled) {
        setFolders([...res.data.folders].sort((a, b) => a.displayOrder - b.displayOrder))
        setFolderState('ready')
      }
    }).catch(() => { if (!cancelled) setFolderState('error') })
    return () => { cancelled = true }
  }, [folderAttempt])

  const save = async () => {
    if (folderState !== 'ready' || busy) return

    if (accountNameRequirement.check(name)) {
      setNameError('名前を入力してください。')
      setError('')
      const input = document.getElementById('hq-account-settings-name')
      input?.focus()
      input?.scrollIntoView?.({ block: 'center' })
      return
    }
    setNameError('')
    setBusy(true)
    setError('')
    try {
      if (name.trim() !== savedName.current) {
        const res = await api.lineAccounts.update(account.id, { name: name.trim() })
        if (!res.success) {
          setError(res.error)
          return
        }
        savedName.current = name.trim()
        setName(savedName.current)
      }
      if (folderId !== initialFolder) {
        const res = await api.lineAccountFolders.move(account.id, folderId || null)
        if (!res.success) {
          setError(res.error === 'ACCOUNT_ARCHIVED' ? 'アーカイブ済みのためフォルダを変えられません。' : res.error)
          return
        }
      }
      guard.disarm()
      onSaved()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)


      setError('保存できませんでした。通信を確認して、もう一度お試しください。') }
    } finally {
      setBusy(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open
      title="アカウントの設定"
      description={`${account.displayName || account.name}（${accountHandle(account)}）`}
      designNode="HMpVx"
      designWidth={SETTINGS_WIDTH}
      designTop={SETTINGS_TOP}
      busy={busy}
      error={error || undefined}
      onCancel={() => requestUnsavedAction(onClose)}
      footer={
        <DialogActions align="center" leadingAction={<Button type="button" variant="secondary" disabled={busy} onClick={() => requestUnsavedAction(onArchive)}>
            {archived ? '戻す' : 'アーカイブ'}
          </Button>}>

          <>
            <Button type="button" variant="secondary" onClick={() => requestUnsavedAction(onClose)} disabled={busy}>キャンセル</Button>
            <Button type="button" variant="primary" onClick={() => save()} disabled={busy || folderState !== 'ready'} busy={busy} busyLabel="保存中…">保存</Button>
          </>
        </DialogActions>
      }
    >
      <div className={head.head}>
        <div className={styles.field}><Field label="名前" htmlFor="hq-account-settings-name" requirement={accountNameRequirement}><SaveErrorField names={["name"]}><TextField
            id="hq-account-settings-name"
            value={name}
            maxLength={100}
            disabled={busy}
            onChange={(event) => { setName(event.target.value); setNameError('') }}
            invalid={Boolean(nameError)}
            aria-describedby={nameError ? 'hq-account-settings-name-error' : undefined}
            className={styles.full}
          /></SaveErrorField>
{nameError ? <p id="hq-account-settings-name-error" className={styles.error} role="alert">{nameError}</p> : null}</Field></div>
        <div className={styles.field}><Field note={<>アカウントは1つのフォルダに入ります。アカウント一覧の左の列で絞り込みに使います</>} label="フォルダ" htmlFor="hq-account-folder">{folderState === 'loading' ? <p role="status">フォルダを読み込んでいます。</p> : folderState === 'error' ? <><p role="alert">フォルダを読み込めませんでした。</p><Button type="button" onClick={() => setFolderAttempt((n) => n + 1)}>もう一度読み込む</Button></> : <SaveErrorField names={["folderId","folder_id"]}><FolderSelect
            id="hq-account-folder"
            aria-label="フォルダ"
            size="full"
            value={folderId}
            disabled={busy}
            onChange={setFolderId}
            folders={folders.map(folderById)}
            onCreate={canCreateFolder
              ? folderCreator((folderName, color) => api.lineAccountFolders.create({ name: folderName, color }), folderById, (created) => {
                setFolders((current) => [...current, created])
                onFolderCreated?.()
              })
              : undefined}
          /></SaveErrorField>}
</Field></div>
        {lineAccountConnectionState(account).tone === 'warn' ? (
          /* 要確認のときだけ：引っかかった確認ごとの理由（URL は折り返して全文）。 */
          <div className={styles.field}>
            <p className={styles.label}>接続の確認</p>
            <ul className={styles.reasonList} aria-label="要確認の理由">
              {(connectionReasons(account).length > 0 ? connectionReasons(account).map((reason) => reason.detail) : [FALLBACK_REASON])
                .map((detail) => <li key={detail}>{detail}</li>)}
            </ul>
          </div>
        ) : null}
        <div className={styles.field}>
          <p className={styles.label}>ほかの設定</p>
          <div className={styles.buttonRow}>
            <Button type="button" disabled={busy} onClick={() => requestUnsavedAction(onEditRegistration)}>
              <Pencil aria-hidden="true" className={styles.icon} />LINE の登録内容を編集
            </Button>
            <Button href="/hq/members">
              <Users aria-hidden="true" className={styles.icon} />メンバー・担当範囲
            </Button>
          </div>
        </div>
      </div>
    </Dialog><OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider></SaveErrorScope>
  )
}

/* 板 ：アカウントをアーカイブ（理由＋本人確認）。 */
export function AccountArchiveDialogV8({ account, onClose, onDone }: {
  account: AccountWithStats
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [typedCode, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: Boolean(reason) || busy, busy, onDiscard: onClose })
  /* 6桁目が入った瞬間にも送る（entered）。送っている間は二重に送らない。 */
  const archive = async (entered?: string) => {
    const code = entered ?? typedCode
    if (busy) return
    if (code.replace(/\D/g, '').length !== 6) {
      setError('認証アプリの6桁コードを入力してください。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const token = await stepUpToken(code)
      const res = await api.lineAccounts.archive(account.id, reason.trim() || undefined, token)
      if (!res.success) {
        setError(res.error)
        return
      }
      guard.disarm()
      onDone()
    } catch (caught) {
      setError(otpFailureMessage(describeApiFailure(caught, 'アーカイブ')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <><Dialog
      open
      title={`「${account.name}」をアーカイブしますか？`}
      designNode="D6ljr"
      designWidth={ARCHIVE_WIDTH}
      designTop={ARCHIVE_TOP}
      busy={busy}
      error={error || undefined}
      onCancel={onClose}
      footer={
        <DialogActions>
          <Button type="button" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button type="button" variant="danger" onClick={() => archive()} disabled={busy} busy={busy} busyLabel="アーカイブ中…">本人確認してアーカイブする</Button>
        </DialogActions>
      }
    >
      <div className={head.head}>
        <p className={styles.lead}>一覧から外します。送受信は止まり、友だちと履歴は残ります。あとで「戻す」で戻せます（オーナーのみ）。</p>
        <OperationTargetSummary accounts={[{ id: account.id, name: account.name }]} />
        <div className={styles.field}><Field label="アーカイブの理由" htmlFor="hq-account-archive-reason"><SaveErrorField names={["reason"]}><TextField
            id="hq-account-archive-reason"
            value={reason}
            maxLength={200}
            disabled={busy}
            placeholder="例：テスト用。使わなくなったため"
            onChange={(event) => setReason(event.target.value)}
            className={styles.full}
          /></SaveErrorField></Field></div>
        <div className={styles.field}>
          <span className={styles.stepLabel}>本人確認（認証アプリの6桁）</span>
          <SaveErrorField names={["typedCode","code"]}><OtpInput visualLabel="認証コード（6桁）" label="認証コード" value={typedCode} onChange={(next) => { setCode(next); if (next && error) setError('') }} onComplete={(entered) => void archive(entered)} invalid={Boolean(error)} busy={busy} /></SaveErrorField>
        </div>
      </div>
    </Dialog><OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider></>
  )
}

/* 板 ：アーカイブから戻す（本人確認）。戻った直後は止まっている状態。 */
export function AccountRestoreDialogV8({ account, onClose, onDone }: {
  account: AccountWithStats
  onClose: () => void
  onDone: () => void
}) {
  const [typedCode, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /* 6桁目が入った瞬間にも送る（entered）。送っている間は二重に送らない。 */
  const restore = async (entered?: string) => {
    const code = entered ?? typedCode
    if (busy) return
    if (code.replace(/\D/g, '').length !== 6) {
      setError('認証アプリの6桁コードを入力してください。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const token = await stepUpToken(code)
      const res = await api.lineAccounts.restore(account.id, token)
      if (!res.success) {
        setError(res.error)
        return
      }
      onDone()
    } catch (caught) {
      setError(otpFailureMessage(describeApiFailure(caught, '復元')))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title={`「${account.name}」をアーカイブから戻しますか？`}
      designNode="HFsO9"
      designWidth={ARCHIVE_WIDTH}
      designTop={RESTORE_TOP}
      busy={busy}
      error={error || undefined}
      onCancel={onClose}
      footer={
        <DialogActions>
          <Button type="button" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button type="button" variant="primary" onClick={() => restore()} disabled={busy} busy={busy} busyLabel="戻しています…">
            <RotateCcw aria-hidden="true" className={styles.icon} />本人確認して戻す
          </Button>
        </DialogActions>
      }
    >
      <div className={head.head}>
        <p className={styles.lead}>戻した直後は「止まっている」状態です。送受信を始めるときは、アカウントの詳細で「動かす」を押します。</p>
        <div className={styles.field}>
          <span className={styles.stepLabel}>本人確認（認証アプリの6桁）</span>
          <SaveErrorField names={["typedCode","code"]}><OtpInput visualLabel="認証コード（6桁）" label="認証コード" value={typedCode} onChange={(next) => { setCode(next); if (next && error) setError('') }} onComplete={(entered) => void restore(entered)} invalid={Boolean(error)} busy={busy} /></SaveErrorField>
        </div>
      </div>
    </Dialog>
  )
}
