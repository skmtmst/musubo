'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { asArray, isFriendDetailShape } from './friend-detail-shape'
import { api, ApiError } from '@/lib/api'
import { useEffect,useState } from 'react'
import { FriendFieldsState,MileageState,PurchaseState,RichMenuState,UpcomingState } from './friend-info-model'
import { type FriendDetail } from './friend-info-types'

const MILEAGE_FEATURE_ID = 'mileage'

/**
 * 顧客のマイルを読む。店でマイルを使っていない（403 FEATURE_DISABLED・featureId=mileage）ときは
 * 'disabled' を返し、取得失敗と分ける。それ以外の失敗はそのまま投げる。
 */
async function loadFriendMileage(friendId: string) {
  try {
    return await api.friends.mileage(friendId, 10)
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 403 && reason.code === 'FEATURE_DISABLED'
      && reason.featureId === MILEAGE_FEATURE_ID) return 'disabled' as const
    throw reason
  }
}

type Options = {
  friendId: string | null
  accountId: string | null | undefined
}

export function useFriendInfoData({ friendId, accountId }: Options) {

  const [friend, setFriend] = useState<FriendDetail | null>(null)

  const [loading, setLoading] = useState(false)

  const [error, setError] = useState<string | null>(null)

  const [mileage, setMileage] = useState<MileageState>({ kind: 'loading' })

  /*
   * INBOX-08: 各取得は「再試行」でこのパネル内からやり直せる。
   * retry キーを増やすと effect が再取得する。失敗のたびに画面移動や
   * 全体の再読込をさせない。
   */
  const [friendRetry, setFriendRetry] = useState(0)

  const [mileageRetry, setMileageRetry] = useState(0)

  const [richMenuRetry, setRichMenuRetry] = useState(0)

  const [fieldsRetry, setFieldsRetry] = useState(0)

  const [upcomingRetry, setUpcomingRetry] = useState(0)

  useEffect(() => {
    if (!friendId) {
      setFriend(null)
      return
    }
    let cancelled = false
    setFriend(null)
    setLoading(true)
    setError(null)
    api.friends.get(friendId).then((res) => {
      if (cancelled) return
      if (res.success && isFriendDetailShape(res.data) && res.data?.id === friendId) {
        setFriend(res.data as unknown as FriendDetail)
      } else {
        // 内部の例外文字列はそのまま出さない。利用者向けの短い理由にする。
        setError(describeApiFailure(undefined, '友だち情報の読み込み'))
      }
    }).catch((reason) => {
      if (cancelled) return
      setError(describeApiFailure(reason, '友だち情報の読み込み'))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [friendId, accountId, friendRetry])

  useEffect(() => {
    if (!friendId) {
      setMileage({ kind: 'loading' })
      return
    }
    let cancelled = false
    setMileage({ kind: 'loading' })
    loadFriendMileage(friendId).then((res) => {
      if (cancelled) return
      if (res === 'disabled') {
        setMileage({ kind: 'disabled' })
      } else if (res.success && res.data?.summary) {
        setMileage({ kind: 'data', summary: res.data.summary, history: asArray(res.data.history) })
      } else {
        setMileage({ kind: 'error' })
      }
    }).catch(() => {
      if (!cancelled) setMileage({ kind: 'error' })
    })
    return () => { cancelled = true }
  }, [friendId, accountId, mileageRetry])

  const [friendFields, setFriendFields] = useState<FriendFieldsState>({ kind: 'loading' })

  useEffect(() => {
    if (!friendId) {
      setFriendFields({ kind: 'loading' })
      return
    }
    let cancelled = false
    setFriendFields({ kind: 'loading' })
    api.friendFields.forFriend(friendId, { suppressFeatureDisabledEvent: true }).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setFriendFields({ kind: 'data', items: asArray(res.data.items), hiddenPersonalCount: res.data.hiddenPersonalCount })
      } else {
        setFriendFields({ kind: 'error' })
      }
    }).catch(() => {
      if (!cancelled) setFriendFields({ kind: 'error' })
    })
    return () => { cancelled = true }
  }, [friendId, accountId, fieldsRetry])

  const [richMenu, setRichMenu] = useState<RichMenuState>({ kind: 'loading' })

  useEffect(() => {
    if (!friendId) {
      setRichMenu({ kind: 'loading' })
      return
    }
    let cancelled = false
    setRichMenu({ kind: 'loading' })
    api.friends.richMenu(friendId).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setRichMenu({ kind: 'data', ...res.data })
      } else {
        setRichMenu({ kind: 'error' })
      }
    }).catch(() => {
      if (cancelled) return
      setRichMenu({ kind: 'error' })
    })
    return () => { cancelled = true }
  }, [friendId, accountId, richMenuRetry])

  const [upcoming, setUpcoming] = useState<UpcomingState>({ kind: 'loading' })

  useEffect(() => {
    if (!friendId) {
      setUpcoming({ kind: 'loading' })
      return
    }
    let cancelled = false
    setUpcoming({ kind: 'loading' })
    api.friends.upcoming(friendId).then((res) => {
      if (cancelled) return
      if (res.success && res.data) {
        setUpcoming({ kind: 'data', data: res.data })
      } else {
        setUpcoming({ kind: 'error' })
      }
    }).catch(() => {
      if (!cancelled) setUpcoming({ kind: 'error' })
    })
    return () => { cancelled = true }
  }, [friendId, accountId, upcomingRetry])

  const [purchase, setPurchase] = useState<PurchaseState>({ kind: 'loading' })

  const [purchaseRetry, setPurchaseRetry] = useState(0)

  useEffect(() => {
    if (!friendId) {
      setPurchase({ kind: 'empty', reason: 'no-friend' })
      return
    }
    let cancelled = false
    setPurchase({ kind: 'loading' })
    // 友だち名で EC の注文を3件まで探す（friend_id の絞り口が無いため）。
    // 名前が取れない・見つからないときは合計を出さず「—」にする（0にしない）。
    const name = friend?.id === friendId ? friend.displayName ?? friend.realName ?? '' : ''
    if (!name) {
      setPurchase({ kind: 'empty', reason: 'no-name' })
      return
    }
    if (!accountId) { setPurchase({ kind: 'empty', reason: 'no-account' }); return }
    void purchaseRetry
    api.ecCommerce.orders({ lineAccountId: accountId, query: name, limit: 3 }).then((res) => {
      if (cancelled) return
      if (!res.success || !res.data) {
        setPurchase({ kind: 'empty', reason: 'unavailable' })
        return
      }
      const candidates = res.data.items
      if (!Array.isArray(candidates)) { setPurchase({ kind: 'empty', reason: 'unavailable' }); return }
      // 名前は候補検索だけ。APIの連携済み友だちIDで確かめた注文のみを出す。
      const list = candidates.filter((order) => order.friendId === friendId)
      if (list.length === 0) { setPurchase({ kind: 'empty', reason: candidates.length ? 'unlinked' : 'none' }); return }
      const items = list.slice(0, 3).map((order) => ({
        id: order.id, title: order.orderNumber ?? order.id,
        amount: order.totalAmount, at: order.orderedAt,
      }))
      if (items.some((item) => item.amount === null)) { setPurchase({ kind: 'empty', reason: 'unavailable' }); return }
      const total = items.reduce((sum, item) => sum + (item.amount ?? 0), 0)
      setPurchase({ kind: 'data', total, count: list.length, items })
    }).catch(() => {
      if (!cancelled) setPurchase({ kind: 'empty', reason: 'unavailable' })
    })
    return () => { cancelled = true }
  }, [friendId, accountId, friend?.displayName, friend?.realName, purchaseRetry, friend?.id])
  return { friend, setFriend, loading, error, mileage, setFriendRetry, setMileageRetry, setRichMenuRetry, setFieldsRetry, setUpcomingRetry, friendFields, richMenu, upcoming, purchase, setPurchaseRetry }
}
