'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Check, LogIn, Plug, Send, X } from 'lucide-react'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { CustomerInfoRows } from '@/components/shared/customer-info-rows'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import StatusBadge from '@/components/shared/status-badge'
import { usePageTitle, usePageCrumbs } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { ApiError } from '@/lib/api'
import { isUberConnectionMutationData, restaurantDeliveryApi } from '@/lib/restaurant-delivery-api'
import { formatDate } from '@/lib/format'
import {
  SERVICES,
  STATUS,
  WAITING,
  connectLabel,
  uberConnectionPatch,
  uberPatch,
  withParticle,
  type DeliveryService,
  type DeliveryStore,
} from './delivery-services'
import styles from './delivery.module.css'

/**
 * ★V8-B 設定 › デリバリー連携
 * （`dF4Ov` 未接続 ／ `OIY4Z` 接続後の状態 ／ `kJLks` 解除の確認 ／ `X5d8UF` つなぐお店を選ぶ）。
 * 承認案：`新規デザイン/2026-10-12_デリバリー管理_デリバリー連携/デリバリー連携_v04.pen`（2026-10-18 利用者承認）
 *
 * 画面の作りは設定 › SNS 連携（`v8/settings/sns/sns.tsx`）に合わせ、1列のカードを縦に並べる。
 * お店での入力欄は作らない。つなぐ操作は各社のログイン、または musubo への申し込みだけ。
 *
 * 承認された範囲は「ボタンは押せない状態で用意し、回答が来た会社から中身をつなぐ」。
 * Uber Eats は受け口がつながったので `ready` を true にし、ログインの経路を実際に動かす。
 * 出前館・ロケットナウは受付開始前のため、申し込みの操作を表示しない。
 *
 * Uber Eats の流れ：
 *  1. ［Uber Eats にログインしてつなぐ］→ `POST …/ubereats/connect/start` →返った認可URLへ移動。
 *  2. Uber で「許可」→ サーバの戻り口が受け取り、この画面へ `?ubereats=pending_store` で戻る。
 *  3. この画面は開くたびに `GET …/ubereats/connection` で本当の状態を読み直す。
 *
 * `pending_store`（ログイン済み・つなぐお店は未選択）は、まだ注文が入らないので
 * 札は「未接続」のまま、承認案 `OIY4Z` の帯（Notice）で続きを伝える。新しい状態札は増やさない。
 *
 * つなぐお店を選ぶ段（`X5d8UF`）：
 *  4. Uber から戻った直後（`?ubereats=pending_store`）は `GET …/ubereats/stores` で候補を取り、窓を開く。
 *  5. ［このお店につなぐ］→ `POST …/ubereats/stores/select` → Uber 側の連携が有効になり「接続中」。
 * 候補を取るときだけ Uber へ問い合わせる（画面を開くたびには問い合わせない）。
 * 窓を閉じたあとは、同じボタンから選び直せる（ログインのやり直しは要らない）。
 * 確定は結果が分からないまま送り直すと連携が重なるため、自動では再送しない。
 *
 * 承認案と作りが食い違うところ（`docs/v8-design-rules.md` §1 正本の順位で決めた。詳しくは同じ場所の `BEHAVIOR.md`）：
 *  - 社名のうしろの半角の空き … 絵のとおり直した（`withParticle`）。
 *  - 窓の左のボタン … 絵は「やめる」だが、オーナーの決まり （入力をやめる＝「キャンセル」、
 *    「やめる」は使わない）が絵より上なので「キャンセル」のまま。
 *  - 右上の×と窓の高さ … ×は共通部品が必ず出す（UI-25、`dialog-close-ui25.test.tsx` の見張り）。
 *    絵には×がないが「見張りに反する絵は、今の作りに合わせて絵を直す」ため、×は消さない。
 *    高さ 396 と 451 の差は、絵の余白（12/20）と間隔（12）が共通部品の値（24・16）と違うせい。
 *    「作る画面の細かい違いは共通部品の値にそろえる」ので、ここでは数字を合わせ込まない。
 *  → 絵の側は `デリバリー連携_v04.pen` で直し、2026-10-18 に承認を受けた（前の v03 はそのまま残す）。
 *
 * 出前館・ロケットナウの状態と日付は、各社の受け口が決まったあとサーバから受け取る。
 * それまでの間も画面の経路を確かめられるよう、入口の値は `services` の引数で
 * 差し替えられるようにしてある（既定は下の `SERVICES`）。
 */

/** 3社の並び・文章・状態の読み替えは `delivery-services` にある（ここから出し直す）。 */
export { SERVICES } from './delivery-services'
export type { DeliveryService, DeliveryStore } from './delivery-services'

type BusyAction = 'connect' | 'reauthorize' | 'stores' | 'select' | 'check' | 'disconnect'
type BusyState = { serviceId: DeliveryService['id']; action: BusyAction }
/** この符号は Uber への解除送信前に終わるため、結果不明として接続操作全体を止める必要はない。 */
const DISCONNECT_PRE_FLIGHT_FAILURES = new Set([
  'connection_busy',
  'connection_not_active',
  'confirmation_required',
  'reauthorization_required',
  'provider_ownership_unverified',
  'order_dispatch_in_progress',
  'delivery_send_disabled',
  'oauth_not_configured',
  'encryption_key_invalid',
  'connection_check_failed',
])

export default function DeliverySettingsPage({ services: initialServices = SERVICES }: { services?: DeliveryService[] } = {}) {
  usePageTitle('デリバリー連携')
  usePageCrumbs([{ label: '設定', href: '/settings' }])
  const role = useStaffRole()
  const roleCanManage = canManageRole(role)
  const permissionReason = usePermissionLockReason(roleCanManage, 'manager')
  const canManage = roleCanManage && !permissionReason
  const { selectedAccountId } = useAccount()
  const searchParams = useSearchParams()
  /** Uber から戻ったときに付く符号（`?ubereats=pending_store` など）。 */
  const uberReturn = searchParams.get('ubereats') ?? ''

  const [services, setServices] = useState<DeliveryService[]>(initialServices)
  /** 外部通信を伴う操作を重ねず、どのボタンが処理中かを示す印。 */
  const [busy, setBusy] = useState<BusyState | null>(null)
  /** 解除を確かめる窓（`kJLks`）で外そうとしている会社 */
  const [disconnecting, setDisconnecting] = useState<DeliveryService | null>(null)
  const [scopeStore, setScopeStore] = useState<{ accountId: string; id: string; name: string } | null>(null)
  const disconnectWindow = useRef<object>({})
  const disconnectAccount = useRef(selectedAccountId)
  const renderedDisconnectWindow = disconnectWindow.current
  const [disconnectError, setDisconnectError] = useState('')
  const [disconnectBlocked, setDisconnectBlocked] = useState(false)
  /** つなぐお店を選ぶ窓（`X5d8UF`）。各社のログインから戻ったときに開く。 */
  const [picking, setPicking] = useState<{ service: DeliveryService; stores: DeliveryStore[]; accountId: string } | null>(null)
  const [pickedStoreId, setPickedStoreId] = useState('')
  const preparing = usePreparingDialog()
  /**
   * Uber のログインは済んでいて、つなぐお店だけ未選択（サーバの `pending_store`）。
   * 承認済みの札は4つのままなので、この続きがあることは画面の状態では持たず別に覚える。
   */
  const [uberPendingStore, setUberPendingStore] = useState(false)
  const accountRef = useRef(selectedAccountId)
  const canManageRef = useRef(canManage)
  const initialServicesRef = useRef(initialServices)
  const loadRequestRef = useRef(0)
  const operationRequestRef = useRef(0)
  const operationLockRef = useRef(false)
  const autoPickedRef = useRef(false)
  accountRef.current = selectedAccountId
  canManageRef.current = canManage
  initialServicesRef.current = initialServices

  const anyConnected = services.some((service) => service.status !== 'disconnected')

  /** 1社だけ書き換える。 */
  const patch = useCallback((id: DeliveryService['id'], next: Partial<DeliveryService>) => {
    setServices((prev) => prev.map((service) => (service.id === id ? { ...service, ...next } : service)))
  }, [])

  const beginOperation = useCallback((serviceId: DeliveryService['id'], action: BusyAction) => {
    if (operationLockRef.current) return null
    operationLockRef.current = true
    // 同じアカウントでも、操作開始前の読み取り結果があとから確定結果を上書きしないようにする。
    loadRequestRef.current += 1
    const request = ++operationRequestRef.current
    setBusy({ serviceId, action })
    return request
  }, [])

  const operationIsCurrent = useCallback((request: number, accountId: string, requireManage = true) => (
    operationRequestRef.current === request
    && accountRef.current === accountId
    && (!requireManage || canManageRef.current)
  ), [])

  const finishOperation = useCallback((request: number, accountId: string) => {
    if (operationRequestRef.current !== request || accountRef.current !== accountId) return
    operationLockRef.current = false
    setBusy(null)
  }, [])

  /** LINE公式アカウントを替えたら、前の店の表示・窓・遅い応答を持ち越さない。 */
  useEffect(() => {
    disconnectWindow.current = {}
    loadRequestRef.current += 1
    operationRequestRef.current += 1
    operationLockRef.current = false
    autoPickedRef.current = false
    setServices(initialServicesRef.current)
    setScopeStore(null)
    setBusy(null)
    setDisconnecting(null)
    setDisconnectError('')
    setDisconnectBlocked(false)
    setPicking(null)
    setPickedStoreId('')
    setUberPendingStore(false)
    return () => { disconnectWindow.current = {} }
  }, [selectedAccountId])

  /** 権限を失った後に、開始済みの変更結果や確認窓を残さない。 */
  useEffect(() => {
    if (canManage) return
    disconnectWindow.current = {}
    loadRequestRef.current += 1
    operationRequestRef.current += 1
    operationLockRef.current = false
    setBusy(null)
    setDisconnecting(null)
    setDisconnectError('')
    setDisconnectBlocked(false)
    setPicking(null)
    setPickedStoreId('')
  }, [canManage])

  /**
   * いまの接続の状態をサーバから読み直す。画面を開くたびと、Uber から戻った直後に通る。
   * 読むのはサーバの受け口（D1だけ）で、ここから Uber へは問い合わせない。
   */
  const load = useCallback(async () => {
    if (!canManage || !selectedAccountId) return
    const accountId = selectedAccountId
    const request = ++loadRequestRef.current
    const stale = () => loadRequestRef.current !== request || accountRef.current !== accountId || !canManageRef.current
    try {
      const data = await restaurantDeliveryApi.ubereatsConnection(accountId)
      if (stale()) return
      setScopeStore(data.store?.id && data.store.name ? { accountId, id: data.store.id, name: data.store.name } : null)
      setUberPendingStore(data.connection.status === 'pending_store')
      patch('uber', uberPatch(data, uberReturn))
    } catch {
      if (stale()) return
      setScopeStore(null)
      // 読めなかっただけなので、出ている状態はそのまま残し、つなぐ操作も止めない。
      patch('uber', {
        stateNote: 'いまの接続の状態を読み取れませんでした。少し待ってから画面を開き直してください。',
        stateNoteTone: 'warn',
      })
    }
  }, [canManage, patch, selectedAccountId, uberReturn])

  useEffect(() => { void load() }, [load])

  /**
   * つなぐお店の候補を取り、選ぶ窓（`X5d8UF`）を開く。
   *
   * ここだけが Uber へ問い合わせる。画面を開くたびには呼ばず、
   * ログインから戻った直後と、お店がボタンを押したときだけ通る。
   */
  const openStorePicker = useCallback(async (service: DeliveryService) => {
    if (!canManage || !selectedAccountId) return
    const accountId = selectedAccountId
    const request = beginOperation(service.id, 'stores')
    if (request === null) return
    try {
      const { stores } = await restaurantDeliveryApi.ubereatsStores(accountId)
      if (!operationIsCurrent(request, accountId)) return
      if (stores.length === 0) {
        patch(service.id, {
          stateNote: `${withParticle(service.name, 'で')}お店が見つかりませんでした。${withParticle(service.name, 'で')}お店の管理権限があるアカウントでログインし直してください。`,
          stateNoteTone: 'warn',
        })
        return
      }
      patch(service.id, { stores })
      setPickedStoreId('')
      setPicking({ service, stores, accountId })
    } catch {
      if (!operationIsCurrent(request, accountId)) return
      // 失敗の符号はサーバに残る。画面には符号を出さず、次にできることだけ伝える。
      patch(service.id, {
        stateNote: `${withParticle(service.name, 'から')}お店の一覧を取れませんでした。少し待ってからもう一度お試しください。`,
        stateNoteTone: 'danger',
      })
    } finally {
      finishOperation(request, accountId)
    }
  }, [beginOperation, canManage, finishOperation, operationIsCurrent, patch, selectedAccountId])

  /**
   * ログインから戻った直後（`?ubereats=pending_store`）だけ、続きの選び口を自動で開く。
   * 一度きりにして、窓を閉じたあとに開き直らないようにする（Uber への問い合わせも増やさない）。
   */
  useEffect(() => {
    if (!canManage || autoPickedRef.current) return
    if (uberReturn !== 'pending_store' || !uberPendingStore) return
    const uber = services.find((service) => service.id === 'uber')
    if (!uber?.ready) return
    autoPickedRef.current = true
    void openStorePicker(uber)
  }, [canManage, openStorePicker, services, uberPendingStore, uberReturn])

  /** Uber の認可画面を開く。再ログインでは reconnect 応答だけを受け入れる。 */
  const startUberOAuth = useCallback(async (service: DeliveryService, reauthorize = false) => {
    if (!canManage || !selectedAccountId) return
    const accountId = selectedAccountId
    const request = beginOperation(service.id, reauthorize ? 'reauthorize' : 'connect')
    if (request === null) return
    try {
      const response = await restaurantDeliveryApi.ubereatsConnectStart(accountId)
      if (!operationIsCurrent(request, accountId)) return
      if (reauthorize && response.mode !== 'reconnect') throw new Error('reauthorization_not_confirmed')
      // 認可URLはサーバが組み立てる。鍵も合言葉も画面には来ない。
      window.location.href = response.authorizeUrl
    } catch {
      if (!operationIsCurrent(request, accountId)) return
      patch(service.id, {
        stateNote: `${withParticle(service.name, 'の')}ログイン画面を開けませんでした。少し待ってからもう一度お試しください。`,
        stateNoteTone: 'danger',
      })
    } finally {
      finishOperation(request, accountId)
    }
  }, [beginOperation, canManage, finishOperation, operationIsCurrent, patch, selectedAccountId])

  /**
   * つなぐボタン。ログイン済みで店舗だけ未選択なら選び口を開き、それ以外は認可画面へ送る。
   * apply の会社は musubo が申し込みを代行するため、受付中の状態にする。
   */
  const connect = useCallback(async (service: DeliveryService) => {
    if (!canManage) return
    if (service.connect === 'login') {
      if (service.id === 'uber' && uberPendingStore) await openStorePicker(service)
      else await startUberOAuth(service)
      return
    }
    preparing.open(`${service.name}の連携の申し込み`)
  }, [canManage, openStorePicker, preparing, startUberOAuth, uberPendingStore])

  /**
   * 選んだお店でつなぐ（`X5d8UF` の確定）。ここで Uber 側の連携が有効になる。
   * 結果が分からないまま送り直すと連携が重なるため、自動では送り直さない。
   * 押し直しは、窓をもう一度開いてもらう人の操作として扱う。
   */
  const pickStore = useCallback(async () => {
    if (!canManage || !picking || !pickedStoreId || !selectedAccountId || picking.accountId !== selectedAccountId || busy !== null) return
    const service = picking.service
    const accountId = selectedAccountId
    const request = beginOperation(service.id, 'select')
    if (request === null) return
    try {
      const response = await restaurantDeliveryApi.ubereatsSelectStore(accountId, pickedStoreId)
      if (!operationIsCurrent(request, accountId)) return
      if (!isUberConnectionMutationData(response)) throw new Error('invalid_connection_response')
      const { connection } = response
      patch(service.id, { ...uberConnectionPatch(connection), stores: undefined })
      setUberPendingStore(connection.status === 'pending_store')
      setPicking(null)
      setPickedStoreId('')
    } catch {
      if (!operationIsCurrent(request, accountId)) return
      patch(service.id, {
        ready: false,
        stateNote: `${withParticle(service.name, 'で')}お店をつなげませんでした。結果を確認する必要があります。送り直さず musubo へお知らせください。`,
        stateNoteTone: 'danger',
      })
      setPicking(null)
      setPickedStoreId('')
    } finally {
      finishOperation(request, accountId)
    }
  }, [beginOperation, busy, canManage, finishOperation, operationIsCurrent, patch, picking, pickedStoreId, selectedAccountId])

  /** Uber Eats 側の状態を明示的に確認し、確定した結果だけを表示へ反映する。 */
  const checkConnection = useCallback(async (service: DeliveryService) => {
    if (!canManage) return
    if (service.id !== 'uber') {
      preparing.open(`${service.name}の接続の確認`)
      return
    }
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    const request = beginOperation(service.id, 'check')
    if (request === null) return
    try {
      const response = await restaurantDeliveryApi.ubereatsCheckConnection(accountId)
      if (!operationIsCurrent(request, accountId)) return
      if (!isUberConnectionMutationData(response)) throw new Error('invalid_connection_response')
      patch(service.id, uberConnectionPatch(response.connection))
      setUberPendingStore(response.connection.status === 'pending_store')
    } catch (error) {
      if (!operationIsCurrent(request, accountId)) return
      if (error instanceof ApiError && error.code === 'pos_deactivation_unknown') {
        patch(service.id, {
          ready: false,
          status: 'error',
          connectionCheckBlocked: true,
          connectionDisconnectBlocked: true,
          stateNote: '連携を解除した結果を確認する必要があります。操作を繰り返さず musubo へお知らせください。',
          stateNoteTone: 'danger',
        })
      } else {
        patch(service.id, {
          stateNote: '接続を確かめられませんでした。表示中の接続状態は変更していません。少し待ってからもう一度お試しください。',
          stateNoteTone: 'danger',
        })
      }
    } finally {
      finishOperation(request, accountId)
    }
  }, [beginOperation, canManage, finishOperation, operationIsCurrent, patch, preparing, selectedAccountId])

  /** 確認窓で確定した1回だけ解除し、明示的な解除済み応答だけを成功として扱う。 */
  const disconnect = useCallback(async () => {
    if (!disconnecting || !canManage || !canManageRef.current || disconnectWindow.current !== renderedDisconnectWindow || accountRef.current !== disconnectAccount.current) return
    if (disconnecting.id !== 'uber') {
      const name = disconnecting.name
      disconnectWindow.current = {}
      setDisconnecting(null)
      preparing.open(`${name}の連携の解除`)
      return
    }
    if (!selectedAccountId || !Number.isSafeInteger(disconnecting.connectionVersion) || (disconnecting.connectionVersion ?? 0) < 1) return
    const accountId = selectedAccountId
    const service = disconnecting
    const request = beginOperation(service.id, 'disconnect')
    if (request === null) return
    setDisconnectError('')
    try {
      const response = await restaurantDeliveryApi.ubereatsDisconnect(accountId, service.connectionVersion!)
      if (!operationIsCurrent(request, accountId)) return
      if (!isUberConnectionMutationData(response) || response.connection.status !== 'disconnected') {
        throw new Error('disconnect_not_confirmed')
      }
      patch(service.id, uberConnectionPatch(response.connection))
      setUberPendingStore(false)
      disconnectWindow.current = {}
      setDisconnecting(null)
      setDisconnectError('')
      setDisconnectBlocked(false)
    } catch (error) {
      if (!operationIsCurrent(request, accountId)) return
      const reauthorizationRequired = error instanceof ApiError && error.code === 'reauthorization_required'
      const resultUnknown = !(error instanceof ApiError)
        || !error.code
        || !DISCONNECT_PRE_FLIGHT_FAILURES.has(error.code)
      if (resultUnknown) {
        patch(service.id, {
          ready: false,
          status: 'error',
          connectionCheckBlocked: true,
          connectionDisconnectBlocked: true,
          stateNote: '連携を解除した結果を確認する必要があります。操作を繰り返さず musubo へお知らせください。',
          stateNoteTone: 'danger',
        })
      }
      if (reauthorizationRequired) {
        patch(service.id, {
          connectionDisconnectBlocked: true,
          needsReauthorization: true,
          stateNote: 'Uber Eats へログインし直す必要があります。「Uber Eats にログインし直す」から、もう一度許可してください。',
          stateNoteTone: 'warn',
        })
      }
      setDisconnectBlocked(reauthorizationRequired || resultUnknown)
      setDisconnectError(reauthorizationRequired
        ? 'Uber Eats へログインし直す必要があります。この窓を閉じて「Uber Eats にログインし直す」から、もう一度許可してください。'
        : resultUnknown
          ? '連携の解除結果を確認できませんでした。送り直さず musubo へお知らせください。'
          : '連携を解除できませんでした。画面を開き直して接続の状態を確認してください。')
    } finally {
      finishOperation(request, accountId)
    }
  }, [beginOperation, canManage, disconnecting, finishOperation, operationIsCurrent, patch, preparing, selectedAccountId, renderedDisconnectWindow])

  return (
    <>
      <PageFrame kind="settings" boardId="dF4Ov">
        {/* 板の頭は型の PageHeading だけ。頭の下に説明の行を置かず、説明は題の横の「？」へ入れる
            （docs/v8-design-rules.md:66・§6.12-2／B-158・B-172 page-head）。承認案 v03 の説明文は
            つながっている会社があるかどうかで書き分け、そのまま「？」の中身にする。 */}
        <PageHeading
          headingSize="compact"
          readOnlyBand={role !== null && !canManage}
          readOnlyNeed="manager"
          title="デリバリー連携"
          helpReserveSpace
          help={`デリバリーサービスへの接続を設定します。Uber Eats の注文の取り込みと注文ごとの操作は、連携の利用準備が整った店舗では受注画面に表示されます。営業状態の変更・メニューの同期はまだ利用できません。${
            anyConnected
              ? 'つながっているサービスの状態をここに出します。お店での入力はありません。うまくいっていない時は musubo が原因を確認し、必要な手続きを行います。'
              : 'お店での入力はありません。Uber Eats は連携できる場合、「ログインしてつなぐ」から Uber Eats の画面で許可します。出前館とロケットナウは今は申し込めません。Uber Eats の連携状況をご確認ください。鍵・接続先アドレス・通知の設定は、すべて musubo 側で行います。'
          }`}
        />
        <div className={styles.body}>
          {services.map((service) => {
            const state = STATUS[service.status]
            const connectable = service.ready
            const serviceBusy = busy?.serviceId === service.id
            return (
              /* 角丸・線・影は共通の Card に任せる。中の間と余白だけ承認案 v03 の寸法で足す。 */
              <Card key={service.id} appearance="outlined" layout="vertical" className={styles.card} aria-labelledby={`delivery-${service.id}-title`}>
                <div className={styles.cardHead}>
                  <h2 id={`delivery-${service.id}-title`} className={styles.cardTitle}>{service.name}</h2>
                  <p className={styles.cardSub}>{service.sub}</p>
                </div>

                <CustomerInfoRows rows={[
                  { label: '接続の状態', value: <StatusBadge tone={state.tone} size="compact">{state.label}</StatusBadge> },
                  ...(service.id === 'uber' ? [{ label: '注文の連携', value: (
                    <StatusBadge tone="neutral" size="compact">受注画面で確認</StatusBadge>
                  ) }] : []),
                ]} />

                {/* 状態の注記は自作の色分け（`.note[data-tone]`）をやめ、共通の帯（Notice）に任せる
                    （B-172 status-badge）。つなぐ手順の案内は色の意味を持たないので真珠色の囲みのまま。 */}
                {/* 帯を先に見るのは、ログイン済み・お店は未選択（`pending_store`）が
                    札の上では「未接続」のままで、続きを伝えるのがこの帯だけだから。 */}
                {service.stateNote ? (
                  <Notice tone={service.stateNoteTone ?? (service.status === 'error' ? 'danger' : 'warn')} appearance="soft">{service.stateNote}</Notice>
                ) : service.status === 'disconnected' ? (
                  <p className={styles.note}>{service.guide}</p>
                ) : null}

                {service.status === 'applying' ? (
                  <CustomerInfoRows rows={[{ label: '申し込んだ日', value: formatDate(service.appliedAt, { style: 'detail', fallback: '—' }) }]} />
                ) : service.status === 'disconnected' ? null : (
                  <CustomerInfoRows rows={[
                    ...(service.storeName ? [{ label: 'つないだお店', value: service.storeName }] : []),
                    { label: 'つないだ日', value: formatDate(service.connectedAt, { style: 'detail', fallback: '—' }) },
                    { label: '最後に確かめた時刻', value: formatDate(service.checkedAt, { style: 'detail', fallback: '—' }) },
                  ]} />
                )}

                <div className={styles.actions}>
                  {service.status === 'disconnected' && service.connect === 'apply' && !connectable ? (
                    <p className={styles.note}>今は申し込めません。Uber Eats の連携状況をご確認ください。</p>
                  ) : service.status === 'disconnected' ? (
                    <Button
                      variant={service.connect === 'apply' && !connectable ? 'secondary' : 'primary'}
                      lockedReason={permissionReason}
                      disabled={!canManage || !connectable || busy !== null}
                      title={connectable ? undefined : WAITING}
                      busy={serviceBusy && (busy?.action === 'connect' || busy?.action === 'stores')}
                      busyLabel="開いています…"
                      onClick={() => void connect(service)}
                    >
                      {service.connect === 'login' ? <LogIn size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                      {connectLabel(service)}
                    </Button>
                  ) : service.status === 'applying' ? (
                    <>
                      <Button
                        variant="secondary"
                        lockedReason={permissionReason}
                        disabled={!canManage || busy !== null}
                        onClick={() => { if (canManage) preparing.open(`${service.name}の申し込みの取り消し`) }}
                      >
                        <X size={16} aria-hidden="true" />
                        申し込みを取り消す
                      </Button>
                    </>
                  ) : (
                    <>
                      {service.needsReauthorization ? (
                        <Button
                          variant="secondary"
                          lockedReason={permissionReason}
                          disabled={!canManage || !service.ready || busy !== null}
                          busy={serviceBusy && busy?.action === 'reauthorize'}
                          busyLabel="開いています…"
                          onClick={() => void startUberOAuth(service, true)}
                        >
                          <LogIn size={16} aria-hidden="true" />
                          Uber Eats にログインし直す
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        lockedReason={permissionReason}
                        disabled={!canManage || busy !== null || service.connectionCheckBlocked}
                        title={service.connectionCheckBlocked ? '結果の確認が終わるまで操作できません' : undefined}
                        busy={serviceBusy && busy?.action === 'check'}
                        busyLabel="確認しています…"
                        onClick={() => void checkConnection(service)}
                      >
                        <Plug size={16} aria-hidden="true" />
                        接続を確かめる
                      </Button>
                      <Button
                        variant="secondary"
                        lockedReason={permissionReason}
                        disabled={!canManage || busy !== null || service.connectionDisconnectBlocked}
                        title={service.connectionDisconnectBlocked ? '結果の確認が終わるまで操作できません' : undefined}
                        onClick={() => { if (!canManage) return; disconnectWindow.current = {}; disconnectAccount.current = selectedAccountId; setDisconnectError(''); setDisconnectBlocked(false); setDisconnecting(service) }}
                      >
                        連携を解除する
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            )
          })}
        </div>

      </PageFrame>

      {/* 解除を確かめる窓（`kJLks`）。幅480は共通の small。 */}
      <Dialog
        open={disconnecting !== null && disconnectAccount.current === selectedAccountId}
        size="small"
        confirmation
        footerDivider
        tone="destructive"
        title={`${withParticle(disconnecting?.name ?? '', 'の')}連携を解除しますか`}
        description={`${withParticle(disconnecting?.name ?? '', 'との')}つなぎを外します。保存済みの注文や過去の履歴はそのまま残ります。`}
        confirmLabel="解除する"
        busy={busy?.serviceId === disconnecting?.id && busy?.action === 'disconnect'}
        busyLabel="解除しています…"
        confirmDisabled={disconnectBlocked}
        confirmDisabledReason={disconnectBlocked ? '解除結果の確認が必要です' : undefined}
        error={disconnectError}
        onConfirm={disconnect}
        onCancel={() => { disconnectWindow.current = {}; setDisconnectError(''); setDisconnectBlocked(false); setDisconnecting(null) }}
      >
        <OperationTargetSummary accounts={[{ id: disconnectAccount.current ?? '' }]} store={disconnecting?.id === 'uber' ? { id: scopeStore?.accountId === disconnectAccount.current ? scopeStore.id : '', name: scopeStore?.accountId === disconnectAccount.current ? scopeStore.name : null } : undefined} externalTarget={{ label: '連携先のお店', name: disconnecting?.storeName }} />
        <p className={styles.note}>
          もう一度つなぐときは、この画面の「{disconnecting ? connectLabel(disconnecting) : ''}」からやり直してください。鍵を調べたり入力したりする必要はありません。
        </p>
      </Dialog>

      {/* つなぐお店を選ぶ窓（`X5d8UF`）。各社のログインから戻り、許可されたお店を受け取れたときに開く。 */}
      <Dialog
        open={picking !== null}
        size="small"
        confirmation
        footerDivider
        title="つなぐお店を選んでください"
        description={`${withParticle(picking?.service.name ?? '', 'での')}許可をいただきました。${withParticle(picking?.service.name ?? '', 'に')}登録されているお店が${picking?.stores.length ?? 0}件見つかりました。musubo につなぐお店を選んでください。`}
        confirmLabel="このお店につなぐ"
        confirmIcon={<Check size={16} aria-hidden="true" />}
        confirmDisabled={pickedStoreId === '' || busy !== null}
        busy={busy?.action === 'select'}
        busyLabel="接続しています…"
        onConfirm={pickStore}
        onCancel={() => { setPicking(null); setPickedStoreId('') }}
      >
        {/* 1つだけ選ぶ群は共通の RadioCardGroup／RadioCard に任せる（§6.12-14・B-172 toggle）。
            群の役割も選んだときの色も共通の部品が持ち、この画面では自作しない。
            窓の中の小さい箱なので variant="form"。 */}
        <RadioCardGroup legend="つなぐお店" className={styles.stores}>
          {picking?.stores.map((store) => (
            <RadioCard
              key={store.id}
              variant="form"
              name="delivery-store"
              value={store.id}
              checked={pickedStoreId === store.id}
              onChange={setPickedStoreId}
              title={store.name}
              note={store.address}
            />
          ))}
        </RadioCardGroup>
        <p className={styles.note}>
          選んだお店への接続を設定します。接続後、受注画面で利用できる注文の操作を確認してください。あとからつなぐお店を変えるときは、musubo へお知らせください。
        </p>
      </Dialog>
      {preparing.dialog}
    </>
  )
}
