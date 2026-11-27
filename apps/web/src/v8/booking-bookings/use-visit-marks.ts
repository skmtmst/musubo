'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { bookingApi, type BookingVisitMark } from '@/lib/api'
import { notifyToast } from '@/components/shared/toast'

export function usePeopleVisitMarks(accountId: string | null, date: string, enabled: boolean, onChanged: () => void) {
  const key = `${accountId}|${date}|${enabled}`
  const current = useRef(key)
  current.current = key
  const generation = useRef(0)
  const running = useRef(new Set<string>())
  const [busyIds, setBusyIds] = useState(new Set<string>())
  const [seq, setSeq] = useState(0)
  const [state, setState] = useState<{ key: string; status: 'loading' | 'ready' | 'error'; marks: Map<string, BookingVisitMark | null> }>({ key: '', status: 'loading', marks: new Map() })
  useEffect(() => {
    if (!accountId || !enabled) return
    const request = ++generation.current
    let alive = true
    setState(previous => ({ key, status: 'loading', marks: previous.key === key ? previous.marks : new Map() }))
    void bookingApi.getToday(accountId, { date, mode: 'staff' }).then(result => {
      if (!alive || request !== generation.current || current.current !== key) return
      setState({ key, status: 'ready', marks: new Map(result.bookings.map(row => [row.id, row.visit_mark])) })
    }).catch(() => {
      if (alive && request === generation.current && current.current === key) setState(previous => ({ key, status: 'error', marks: previous.key === key ? previous.marks : new Map() }))
    })
    return () => { alive = false }
  }, [accountId, date, enabled, key, seq])
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const mutate = useCallback(async (id: string, kind: BookingVisitMark['kind'] | null, lateMinutes?: number) => {
    if (!accountId || !enabled || current.current !== key) return
    const operation = `${key}|${id}`
    if (running.current.has(operation)) return
    running.current.add(operation)
    setBusyIds(new Set(running.current))
    try {
      let nextMark: BookingVisitMark | null = null
      if (kind === null) await bookingApi.deleteVisitMark(accountId, id)
      else nextMark = (await bookingApi.postVisitMark(accountId, id, { kind, ...(lateMinutes === undefined ? {} : { late_minutes: lateMinutes }) })).visit_mark
      if (!mounted.current || current.current !== key) return
      if (kind !== null && (!nextMark || nextMark.kind !== kind)) throw new Error('invalid visit mark')
      setState(previous => previous.key === key ? { ...previous, marks: new Map(previous.marks).set(id, nextMark) } : previous)
      onChanged()
      setSeq(value => value + 1)
      notifyToast(kind === 'visited' ? '来店しました' : kind === 'late' ? `${lateMinutes}分遅れにしました` : kind === 'no_show' ? '来なかったにしました' : '印を取り消しました')
    } catch {
      if (mounted.current && current.current === key) notifyToast('印の変更を確認できません。', { tone: 'error', actionLabel: '読み直す', onAction: () => { if (mounted.current && current.current === key) { setSeq(value => value + 1); onChanged() } } })
    } finally {
      running.current.delete(operation)
      if (mounted.current) setBusyIds(new Set(running.current))
    }
  }, [accountId, enabled, key, onChanged])
  return {
    status: state.key === key ? state.status : 'loading',
    mark: (id: string) => state.key === key ? state.marks.get(id) ?? null : null,
    busy: (id: string) => busyIds.has(`${key}|${id}`),
    markVisit: mutate,
    reload: () => setSeq(value => value + 1),
  }
}
