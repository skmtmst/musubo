'use client'

/*
 * 統合ユーザー詳細（w8W4Eh / ★V8 ）の読み込み・保存・解除の正本。
 * 管理画面 の詳細（merged-person-detail.tsx）と ★V8 の詳細（merged-person-detail-v8.tsx）
 * が同じ口を使う——版の扱い（expectedRevision）や 409 の読み直しは2か所で
 * ずれないようにここにだけ置く。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MergedPersonDeliveryPriority, MergedPersonLinkedFriend } from '@line-crm/shared'
import { api, ApiError, type MergedPersonWithCandidates } from '@/lib/api'
import { failureOf, type MergedPersonFailure } from './merged-person-view'
import type { ProfileCandidateDraft } from './merged-profile-dialog'
import { emptyProfileCandidateDraft } from './merged-profile-dialog'

/**
 * 出せないときは4つに分ける。**読込・失敗・権限不足は面ごと差し替え**、
 * **取得できた0件は各節の中で「まだありません」**と書く。失敗を0件と
 * 同じ文にすると、読めていないだけなのに「消えた」に見える。
 */
export type MergedPersonPhase = 'loading' | 'ready' | 'error' | 'forbidden'

export function useMergedPerson(personId: string, selectedAccountId: string | null, canManage: boolean) {
  const scope = useRef({ personId, selectedAccountId, canManage, epoch: 0 })
  if (scope.current.personId !== personId || scope.current.selectedAccountId !== selectedAccountId || scope.current.canManage !== canManage) scope.current = { personId, selectedAccountId, canManage, epoch: scope.current.epoch + 1 }
  const [phase, setPhase] = useState<MergedPersonPhase>('loading')
  const [person, setPerson] = useState<MergedPersonWithCandidates | null>(null)
  const [failure, setFailure] = useState<MergedPersonFailure | null>(null)
  const [editing, setEditing] = useState(false)
  const [profileEditing, setProfileEditing] = useState(false)
  const [profileDraft, setProfileDraft] = useState<ProfileCandidateDraft>({})
  const [profileSaving, setProfileSaving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [unlinkSnapshot, setUnlinkSnapshot] = useState<{ friend: MergedPersonLinkedFriend; personId: string; revision: number; epoch: number } | null>(null)
  const unlinkTarget = unlinkSnapshot && unlinkSnapshot.epoch === scope.current.epoch && unlinkSnapshot.personId === personId && unlinkSnapshot.revision === person?.revision ? unlinkSnapshot.friend : null
  const setUnlinkTarget = useCallback((friend: MergedPersonLinkedFriend | null) => {
    if (!friend) { setUnlinkSnapshot(null); return }
    if (!canManage || !person || person.id !== personId || !person.linkedFriends.some(item => item.friendId === friend.friendId)) return
    setUnlinkSnapshot({ friend, personId, revision: person.revision, epoch: scope.current.epoch })
  }, [canManage, person, personId])
  const [unlinkReason, setUnlinkReason] = useState('')
  const [unlinking, setUnlinking] = useState(false)

  useEffect(() => {
    let alive = true
    setPhase('loading')
    setFailure(null)
    api.mergedPeople
      .get(personId)
      .then((res) => {
        if (!alive) return
        /*
         * 200 でも `success: false` が返ることがある（画面確認のモックも
         * この形で失敗を返す）。中身を読む前に必ず見る。
         */
        if (!res.success) {
          setFailure(failureOf(null))
          setPhase('error')
          return
        }
        setPerson({ ...res.data, profileCandidates: res.data.profileCandidates ?? [], tagCandidates: res.data.tagCandidates ?? [] })
        setPhase('ready')
      })
      .catch((error: unknown) => {
        if (!alive) return
        const next = error instanceof ApiError
          ? failureOf({ status: error.status, code: error.code })
          : failureOf(null)
        setFailure(next)
        setPhase(next.kind === 'forbidden' ? 'forbidden' : 'error')
      })
    return () => {
      alive = false
    }
  }, [personId, reloadKey])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  const save = useCallback(
    (rows: MergedPersonDeliveryPriority[]) => {
      if (!person) return
      setSaving(true)
      setSaveError('')
      api.mergedPeople
        .updateDeliveryPriorities(person.id, {
          expectedRevision: person.revision,
          priorities: rows.map((row) => ({
            purpose: row.purpose,
            friendId: row.friendId,
            priority: row.priority,
            isActive: row.isActive,
            reason: row.reason,
          })),
        })
        .then((res) => {
          if (!res.success) {
            setSaveError(failureOf(null).description)
            return
          }
          setPerson((current) => current ? { ...res.data, profileCandidates: current.profileCandidates, tagCandidates: current.tagCandidates } : null)
          setEditing(false)
        })
        .catch((error: unknown) => {
          const next = error instanceof ApiError
            ? failureOf({ status: error.status, code: error.code })
            : failureOf(null)
          setSaveError(`${next.title}。${next.description}`)
        })
        .finally(() => setSaving(false))
    },
    [person],
  )

  /*
   * ★V8 ：「配信に使う」の切替は行ごとのスイッチ。目的（用途）ごとの
   * 行をまとめて、その友だち分だけ isActive を反転して保存する。
   * 「全部『使わない』にすると、どこからも送れなくなります」は画面側の注意書き。
   */
  const setDeliveryActive = useCallback(
    (friendId: string, isActive: boolean) => {
      if (!person) return
      save(
        person.deliveryPriorities.map((row) =>
          row.friendId === friendId ? { ...row, isActive } : row,
        ),
      )
    },
    [person, save],
  )

  const unlink = useCallback(() => {
    if (!person || !unlinkSnapshot || !unlinkTarget || !canManage || unlinkSnapshot.epoch !== scope.current.epoch || person.id !== personId || !unlinkReason.trim()) return
    setUnlinking(true)
    setSaveError('')
    api.mergedPeople.unlink(unlinkSnapshot.personId, unlinkSnapshot.friend.friendId, {
      expectedRevision: unlinkSnapshot.revision,
      reason: unlinkReason.trim(),
    }).then((res) => {
      if (scope.current.epoch !== unlinkSnapshot.epoch) return
      if (!res.success) {
        setSaveError(failureOf(null).description)
        return
      }
      setUnlinkTarget(null)
      setUnlinkReason('')
      setReloadKey((key) => key + 1)
    }).catch((error: unknown) => {
      if (scope.current.epoch !== unlinkSnapshot.epoch) return
      const next = error instanceof ApiError
        ? failureOf({ status: error.status, code: error.code })
        : failureOf(null)
      setSaveError(`${next.title}。${next.description}`)
      /*
       * R389: 版の競合は古い結び付きのまま残さない。解除の窓を閉じて
       * 最新を読み直し、成功した対象だけが解除済みになる。
       */
      if (error instanceof ApiError && error.status === 409) {
        setUnlinkTarget(null)
        setUnlinkReason('')
        setReloadKey((key) => key + 1)
      }
    }).finally(() => setUnlinking(false))
  }, [person, personId, canManage, unlinkReason, unlinkTarget, unlinkSnapshot, setUnlinkTarget])

  const openProfileEditor = useCallback(() => {
    if (!person) return
    setSaveError('')
    setProfileDraft(emptyProfileCandidateDraft(person.profileCandidates))
    setProfileEditing(true)
  }, [person])

  const saveProfile = useCallback(() => {
    if (!person) return
    const selections = person.profileCandidates.flatMap((field) => {
      const draft = profileDraft[field.fieldKey]
      const optionIndex = Number(draft?.optionIndex)
      const option = draft?.optionIndex !== '' && Number.isInteger(optionIndex) && optionIndex >= 0
        ? field.options[optionIndex]
        : undefined
      return option?.candidateId && draft
        ? [{ fieldKey: field.fieldKey, candidateId: option.candidateId, updateMode: draft.updateMode }]
        : []
    })
    if (selections.length === 0) return
    setProfileSaving(true)
    setSaveError('')
    api.mergedPeople.updateProfileValues(person.id, {
      expectedRevision: person.revision,
      selections,
    }).then((res) => {
      if (!res.success) {
        setSaveError(failureOf(null).description)
        return
      }
      setPerson(res.data)
      setProfileEditing(false)
      setProfileDraft({})
    }).catch((error: unknown) => {
      const next = error instanceof ApiError
        ? failureOf({ status: error.status, code: error.code })
        : failureOf(null)
      setSaveError(`${next.title}。${next.description}`)
    }).finally(() => setProfileSaving(false))
  }, [person, profileDraft])

  return {
    phase,
    person,
    failure,
    editing,
    setEditing,
    profileEditing,
    setProfileEditing,
    profileDraft,
    setProfileDraft,
    profileSaving,
    saving,
    saveError,
    setSaveError,
    reload,
    save,
    setDeliveryActive,
    unlinkTarget,
    setUnlinkTarget,
    unlinkReason,
    setUnlinkReason,
    unlinking,
    unlink,
    openProfileEditor,
    saveProfile,
  }
}
