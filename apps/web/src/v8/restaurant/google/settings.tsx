'use client'
import { useGooglePermission } from './use-google-permission'
import { FormLeaveGuard } from '@/components/shared/form-leave-guard'
import { useRef, useState } from 'react'
import { Link2, RefreshCw } from 'lucide-react'
import SectionHeader from '@/components/shared/section-header'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { restaurantGoogleApi, type GoogleConnectionData } from '@/lib/restaurant-google-api'
import { errorMessage, formatYmd } from './format'
import styles from './google.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


/*
 * 設定 › SNS連携のGoogle接続操作。未接続・店舗の選択待ち・接続済みを扱う。
 * 接続・再接続は Google の認可画面へ移る。解除・取り消し・切り替えは確認画面を経る。
 * 接続を管理できない人には、接続・解除のボタンを置かない。
 */

export default function SettingsBoard({ accountId, data, onChanged }: { accountId: string; data: GoogleConnectionData; onChanged: () => void }) {
  const scope = useRef({ accountId, generation: 0 })
  if (scope.current.accountId !== accountId) scope.current = { accountId, generation: scope.current.generation + 1 }
  const saveErrors = useSaveFormErrors()
  const { allowed: canManage, lockedReason } = useGooglePermission('tenantWide', data.permissions.canManageConnection)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [locationSaved, setLocationSaved] = useState(false)
  const [selectedLocation, setSelectedLocation] = useState('')
  const [confirmSwitch, setConfirmSwitch] = useState(false)
  const [confirmation, setConfirmation] = useState<{ accountId: string; generation: number; connectionId?: string; revision?: number; locationName?: string; locationTitle?: string | null; previousTitle?: string | null } | null>(null)
  const { connection } = data
  const disconnectKey = JSON.stringify([accountId, data.store.id, connection.status, connection.locationName, connection.googleAccountEmail, connection.connectedAt])
  const disconnectScope = useRef({ key: disconnectKey })
  if (disconnectScope.current.key !== disconnectKey) disconnectScope.current = { key: disconnectKey }
  const openedDisconnectScope = useRef<typeof disconnectScope.current | null>(null)
  const disconnectTicket = useRef<object | null>(null)
  const disconnectAuthority = useRef({ allowed: canManage })
  if (disconnectAuthority.current.allowed !== canManage) disconnectAuthority.current = { allowed: canManage }
  const openedDisconnectAuthority = useRef<typeof disconnectAuthority.current | null>(null)
  const renderedDisconnectTicket = disconnectTicket.current
  const openDisconnect = () => { if (canManage && !busy) { openedDisconnectScope.current = disconnectScope.current; openedDisconnectAuthority.current = disconnectAuthority.current; disconnectTicket.current = {}; setActionError(''); setConfirmation({ accountId, generation: scope.current.generation, connectionId: connection.id, revision: connection.confirmationRevision, locationTitle: connection.locationTitle }); setConfirmDisconnect(true) } }
  const closeDisconnect = () => { disconnectTicket.current = null; openedDisconnectScope.current = null; setConfirmDisconnect(false) }
  const confirmDisconnectNow = () => { if (renderedDisconnectTicket && renderedDisconnectTicket === disconnectTicket.current && openedDisconnectScope.current === disconnectScope.current && openedDisconnectAuthority.current === disconnectAuthority.current && canManage) return disconnect() }
  // 店舗の選択待ちなのに前の店舗名が残っている＝別の店舗へ切り替えようとしている状態。
  const previousTitle = connection.status === 'pending_location' ? connection.locationTitle : null
  const switchingLocation = Boolean(connection.locationName) && selectedLocation !== '' && selectedLocation !== connection.locationName

  const startConnect = async () => {
    if (!canManage || busy || !data.oauthConfigured) return
    setBusy(true)
    setActionError('')
    try {
      const response = await restaurantGoogleApi.connectStart(accountId)
      window.location.assign(response.authorizeUrl)
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setActionError(errorMessage(err, 'Googleの認可画面を開けませんでした。')) }
      setBusy(false)
    }
  }

  const selectLocation = async (confirmedSwitch = false) => {
    if (!canManage || busy || !selectedLocation || (confirmedSwitch && !confirmSwitch)) return
    setBusy(true)
    setActionError('')
    try {
      if (confirmedSwitch && (!confirmation || confirmation.accountId !== accountId || confirmation.generation !== scope.current.generation || !confirmation.connectionId || !Number.isSafeInteger(confirmation.revision) || !confirmation.locationName)) throw new Error('確認した版がありません')
      await restaurantGoogleApi.selectLocation(accountId, confirmedSwitch ? confirmation!.locationName! : selectedLocation, confirmedSwitch,
        confirmedSwitch ? { expectedConnectionId: confirmation!.connectionId!, expectedConfirmationRevision: confirmation!.revision! } : undefined)
      setLocationSaved(true)
      setConfirmSwitch(false)
      onChanged()
      return true
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setActionError(errorMessage(err, '店舗を選べませんでした。')) }
      return false
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!canManage || busy || !confirmDisconnect) return
    setBusy(true)
    setActionError('')
    try {
      if (!confirmation || confirmation.accountId !== accountId || confirmation.generation !== scope.current.generation || !confirmation.connectionId || !Number.isSafeInteger(confirmation.revision)) throw new Error('確認した版がありません')
      await restaurantGoogleApi.disconnect(accountId, { expectedConnectionId: confirmation.connectionId, expectedConfirmationRevision: confirmation.revision! })
      closeDisconnect()

      onChanged()
      return true
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setActionError(errorMessage(err, '接続を解除できませんでした。')) }
      return false
    } finally {
      setBusy(false)
    }
  }


  if (connection.status === 'disconnected') {
    return (
      <SaveErrorScope errors={saveErrors}><div className={styles.connectionPanel}>
        <SectionHeader size="small" title={<span id="google-connect-title">Googleアカウントを接続</span>} />
        <p className={styles.preText}>{'店舗を管理しているGoogleアカウントでログインしてください。\n接続する店舗は、1つのLINEアカウントにつき1店舗です。'}</p>
        {!data.oauthConfigured ? <Notice tone="warn">この環境にはGoogle接続の設定がありません。運営に連絡してください。</Notice> : null}
        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
        {(
          <div className={styles.buttonRow}>
            <Button lockedReason={lockedReason} variant="primary" onClick={() => void startConnect()} disabled={!canManage || busy || !data.oauthConfigured} busy={Boolean(busy)} busyLabel="処理中…"><Link2 aria-hidden className={styles.icon16} />接続する</Button>
          </div>
        )}
        <p className={styles.grayNote}>初回接続時に、Googleで管理できる店舗から接続先を1店舗確認します。接続後は、このLINEアカウントの店舗だけを表示します。</p>
      </div></SaveErrorScope>
    )
  }

  if (connection.status === 'pending_location') {
    return (
      <SaveErrorScope errors={saveErrors}><div className={styles.connectionPanel}>
        <FormLeaveGuard dirty={Boolean(selectedLocation) && !locationSaved} busy={busy} />
        <SectionHeader size="small" title={<span id="google-location-title">接続する店舗を選ぶ</span>} />
        <p className={styles.muted}>{`Googleアカウントの認証は完了しています${connection.googleAccountEmail ? `（${connection.googleAccountEmail}）` : ''}`}</p>
        <p className={styles.preText}>{`このLINEアカウント（${data.store.name}）に接続する店舗を1つ選んでください。接続後は、選んだ店舗だけを表示します。`}</p>
        {previousTitle ? (
          <Notice tone="warn">{`いまは「${previousTitle}」につながっています。同じ店舗を選べばそのまま続けられます。別の店舗を選ぶと切り替わり、「${previousTitle}」で取り込んだ口コミ・下書き・プロフィール・投稿・数値は消えます（切り替える前に確認します）。`}</Notice>
        ) : null}
        <RadioCardGroup legend="接続するGoogleビジネスプロフィール" className={styles.radioList}>
          {data.candidates.map((candidate) => (
            <RadioCard
              key={candidate.locationName}
              name="location"
              value={candidate.locationName}
              checked={selectedLocation === candidate.locationName}
              disabled={!canManage || busy}
              onChange={() => { if (!canManage || busy) return; setSelectedLocation(candidate.locationName); setLocationSaved(false) }}
              title={candidate.locationTitle}
              note={candidate.addressText ?? undefined}
            />
          ))}
        </RadioCardGroup>
        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
        {(
          <div className={styles.buttonRowEnd}>
            <Button lockedReason={lockedReason} onClick={openDisconnect} disabled={!canManage || busy}>接続を取り消す</Button>

            <Button lockedReason={lockedReason} onClick={() => void startConnect()} disabled={!canManage || busy} busy={Boolean(busy)} busyLabel="処理中…">別のGoogleアカウントでやり直す</Button>
            <Button lockedReason={lockedReason} variant="primary" onClick={() => { if (!canManage || busy) return; setActionError(''); if (switchingLocation) { setConfirmation({ accountId, generation: scope.current.generation, connectionId: connection.id, revision: connection.confirmationRevision, locationName: selectedLocation, locationTitle: data.candidates.find(candidate => candidate.locationName === selectedLocation)?.locationTitle, previousTitle }); setConfirmSwitch(true) } else void selectLocation() }} disabled={!canManage || busy || !selectedLocation} busy={Boolean(busy)} busyLabel="処理中…">
              {switchingLocation ? 'この店舗に切り替える' : 'この店舗を接続する'}
            </Button>
          </div>
        )}
        <ConfirmDialog confirmDisabled={!canManage || openedDisconnectAuthority.current !== disconnectAuthority.current} confirmLockedReason={lockedReason} open={confirmDisconnect && confirmation?.generation === scope.current.generation && openedDisconnectScope.current === disconnectScope.current} title="接続をやり直しますか？" description="いま進めている接続を取り消します。口コミの履歴は残ります。" confirmLabel="取り消す" destructive busy={busy} error={actionError || undefined} onSuccess={closeDisconnect} onConfirm={confirmDisconnectNow} onCancel={closeDisconnect}><OperationTargetSummary accounts={[{ id: accountId }]} store={data.store} externalTarget={{ label: 'Googleの店舗', name: confirmation?.locationTitle }} /></ConfirmDialog>

        <ConfirmDialog confirmDisabled={!canManage} confirmLockedReason={lockedReason}
          open={confirmSwitch && confirmation?.generation === scope.current.generation}
          title="接続する店舗を切り替えますか？"
          description={`「${confirmation?.previousTitle ?? ''}」から「${confirmation?.locationTitle ?? '確認できない店舗'}」へ切り替えます。これまでに取り込んだ口コミ・返信の下書き・プロフィール・投稿・数値は消え、戻せません。新しい店舗の分はこのあと取り込み直します。`}
          confirmLabel="切り替える"
          destructive
          busy={busy}
          error={actionError || undefined} onSuccess={() => setConfirmSwitch(false)} onConfirm={() => selectLocation(true)}
          onCancel={() => setConfirmSwitch(false)}
        ><OperationTargetSummary accounts={[{ id: accountId }]} store={data.store} externalTarget={{ label: '切り替え先のGoogleの店舗', name: confirmation?.locationTitle }} /></ConfirmDialog>
      </div></SaveErrorScope>
    )
  }

  /* 状態は札で出す。理由と直し方は上の帯が書いている。検証環境で外へ送らない注記は検証環境の帯（google.tsx）へ。 */
  return (
    <SaveErrorScope errors={saveErrors}><>
      {connection.status === 'expired' ? <Notice tone="danger">Googleとの接続を確認してください。認可が切れています。店舗を管理するGoogleアカウントで再接続してください。保存中の返信の下書きはいま残っていますが、Googleから取得した口コミは最終更新から30日以内に削除するため、再接続しないままだと下書きも一緒に消えます。</Notice> : null}
      {connection.status === 'no_permission' ? <Notice tone="danger">この店舗を操作する権限がありません。接続済み店舗の管理権限をGoogle側で確認してください。</Notice> : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      <div className={styles.connectionPanel}>
        <SectionHeader size="small" title={<span id="google-account-title">Googleアカウント</span>} />
        <dl className={styles.facts}>
          <div className={styles.factRow}><dt className={styles.factKey}>つないでいるアカウント</dt><dd className={styles.factValue}>{connection.googleAccountEmail ?? emptyValue('unknown')}</dd></div>
          <div className={styles.factRow}><dt className={styles.factKey}>つないだ日</dt><dd className={styles.factValue}>{formatYmd(connection.connectedAt)}</dd></div>
        </dl>
        {(
          <div className={styles.buttonRowEnd}>
            <Button lockedReason={lockedReason} variant="danger-outline" onClick={openDisconnect} disabled={!canManage || busy}>接続を解除する</Button>

            <Button lockedReason={lockedReason} onClick={() => void startConnect()} disabled={!canManage || busy} busy={Boolean(busy)} busyLabel="処理中…"><RefreshCw aria-hidden className={styles.icon16} />つなぎ直す</Button>
          </div>
        )}
      </div>
      <ConfirmDialog confirmDisabled={!canManage || openedDisconnectAuthority.current !== disconnectAuthority.current} confirmLockedReason={lockedReason}
        open={confirmDisconnect && confirmation?.generation === scope.current.generation && openedDisconnectScope.current === disconnectScope.current}

        title="Googleアカウントの接続を解除しますか？"
        description="解除すると、Google側の許可を取り消し、保存しているトークンと、Googleから取得した口コミ・プロフィール・指標・取り込んだ投稿を削除します。返信の下書きも消えます。だれがいつ何をGoogleへ送ったかの記録だけ残ります。この操作は取り消せません。もう一度使うには再接続が必要です。"
        confirmLabel="接続を解除する"
        destructive
        busy={busy}
        error={actionError}
        onConfirm={confirmDisconnectNow}
        onCancel={closeDisconnect}
      ><OperationTargetSummary accounts={[{ id: accountId }]} store={data.store} externalTarget={{ label: 'Googleの店舗', name: confirmation?.locationTitle }} /></ConfirmDialog>

    </></SaveErrorScope>
  )
}
