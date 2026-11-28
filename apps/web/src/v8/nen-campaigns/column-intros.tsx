'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, type NenColumn } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useResponseGate } from '@/lib/use-response-gate'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { DetailPage } from '@/components/templates'
import Button from '@/components/shared/button'
import FormSection from '@/components/shared/form-section'
import { Field } from '@/components/shared/form-controls'
import { TextArea } from '@/components/shared/text-field'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { formatDay } from '@/lib/format'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'


type Column = Pick<NenColumn, 'id' | 'slug' | 'title' | 'introText' | 'publishedAt' | 'updatedAt'>

/**
 * NENコラムに添える紹介文の編集。
 *
 * コラムの本文はEC側にある。ここで直せるのは「LINEで配るときに前に付ける
 * 一言」だけ。本文まで直せるように見せると、直したのに反映されない、
 * という食い違いになる。
 */
export default function ColumnIntros() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('コラムの紹介文')
  usePageCrumbs([{ label: 'NEN配信', href: '/nen-campaigns' }, { label: 'コラムの紹介文' }])
  const canEdit = canManageRole(useStaffRole())
  const saveLocks = useRef(new Set<string>())
  const { selectedAccountId } = useAccount()

  const [columns, setColumns] = useState<Column[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [forbidden, setForbidden] = useState(false)
  /*
   * U102: カードごとの保存状態。保存の成否は「どの紹介文か」と一緒に
   * 持つ。ページ上端の共通帯に出すと、どのカードの話か見失う。
   */
  const [savedId, setSavedId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null)
  /*
   * M507残差: 409で止めるだけでは元受入「最新を見せる」に届かない。
   * 読み直した最新の紹介文を、下書きを置き換えず同カード内に
   * 読み取り専用で別表示するためのもの。保存成功・読み直しで消す。
   * 書き直しても消さない（比べながら直す助けに残す）。
   */
  const [latestIntro, setLatestIntro] = useState<{ id: string; text: string } | null>(null)
  /*
   * #935 N-301: 紹介文を書きかけのまま離れると消えていた。
   * 保存済みの紹介文と違う間だけ、ブラウザ離脱・画面内リンク・戻る操作を止めて確認する。
   * hooksは分岐の前に置く（下の早期returnより先に呼ぶ）。
   */
  const dirty = columns.some((column) => (drafts[column.id] ?? '') !== (column.introText ?? ''))
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: savingId !== null })

  // ?key= が付いていれば、その配信そのものを編集する（設計 9-1-1）。
  // 付いていないときは、EC側のコラムに添える紹介文の一覧を出す。

  /* PKG109：アカウントを切り替えたら、前のアカウントの遅い応答で一覧・入力を置き換えない。 */
  const gate = useResponseGate()
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  const loadedAccountRef = useRef<string | null>(null)

  const load = useCallback(async (preserveDrafts = false) => {
    const token = gate.begin()
    setLoading(true)
    setError('')
    setForbidden(false)
    setLatestIntro(null)
    if (!selectedAccountId) {
      loadedAccountRef.current = null
      setColumns([])
      setDrafts({})
      setLoading(false)
      return
    }
    if (loadedAccountRef.current !== selectedAccountId) {
      loadedAccountRef.current = null
      setColumns([])
      setDrafts({})
    }
    try {
      const res = await api.nenCampaigns.columns(selectedAccountId)
      if (!gate.current(token)) return
      if (!res.success) throw new Error(res.error || 'コラムの紹介文を読み込めませんでした')
      loadedAccountRef.current = selectedAccountId
      setColumns(res.data)
      const next: Record<string, string> = {}
      for (const c of res.data) next[c.id] = c.introText ?? ''
      setDrafts((current) => preserveDrafts ? Object.fromEntries(res.data.map((c) => [c.id, current[c.id] ?? c.introText ?? ''])) : next)
    } catch (reason) {
      if (!gate.current(token)) return
      if (reason instanceof ApiError && reason.status === 403) {
        setForbidden(true)
      } else {
        setError(describeApiFailure(reason, 'コラムの紹介文の読み込み'))
      }
    } finally {
      if (gate.current(token)) setLoading(false)
    }
  }, [selectedAccountId, gate])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (column: Column) => {
    if (!selectedAccountId || !canEdit || saveLocks.current.has(column.id)) return
    saveLocks.current.add(column.id)
    const accountId = selectedAccountId
    const stale = () => accountRef.current !== accountId
    setSavingId(column.id)
    setError('')
    setSaveError(null)
    setSavedId(null)
    try {
      // M507: 開いたときの版を添える。ほかの人が先に保存していたら409で止まる。
      const res = await api.nenCampaigns.updateColumnMessage(selectedAccountId, column.id, drafts[column.id] ?? '', column.updatedAt)
      if (stale()) return
      if (!res.success) {
        setSaveError({ id: column.id, message: '保存に失敗しました。時間をおいてもう一度お試しください。' })
        return
      }
      // 版を成功応答の新しい版へ進める。他のカードの入力は残したままにする。
      setColumns((current) => current.map((item) => item.id === column.id
        ? { ...item, introText: drafts[column.id] ?? item.introText, updatedAt: res.data?.updatedAt ?? item.updatedAt }
        : item))
      setSavedId(column.id)
      // M507残差: 保存を通したら比べる相手は要らない。比較表示を消す。
      setLatestIntro(null)
    } catch (e) {
      if (stale()) return
      saveErrors.setServerErrors(Object.fromEntries(Object.entries(readSaveFieldErrors(e)).map(([key, message]) => [`${column.id}.${key}`, message])))
      // M507: 競合時は最新の紹介文を読み直し、入力は残したまま比べながら
      // 保存し直せるようにする。
      if (e instanceof ApiError && e.status === 409 && e.code === 'VERSION_CONFLICT') {
        const latest = (e.data as { latest?: { introText?: string; updatedAt?: string } } | null)?.latest
        if (latest) {
          setColumns((current) => current.map((item) => item.id === column.id
            ? { ...item, introText: latest.introText ?? item.introText, updatedAt: latest.updatedAt ?? item.updatedAt }
            : item))
          // M507残差: 下書きは置き換えない。最新の紹介文は同カードに別表示する。
          setLatestIntro({ id: column.id, text: latest.introText ?? '' })
        } else {
          setLatestIntro(null)
          void load(true)
        }
        setSaveError({ id: column.id, message: 'ほかの人が先に保存しました。最新の内容を確認してから、もう一度保存してください。入力した内容はそのまま残っています。' })
        return
      }
      setSaveError({ id: column.id, message: describeApiFailure(e, '保存') })
    } finally {
      saveLocks.current.delete(column.id)
      setSavingId(null)
    }
  }


  {/* 119: いつも同じ説明は帯・題下に出さず、題の横の「？」へ。 */}
  return <SaveErrorScope errors={saveErrors}><DetailPage title="コラムの紹介文" readOnly={!canEdit} help="コラムの本文はEC側にあります。ここで直せるのは、LINEで配るときに前に付ける一言だけです。">
    {!selectedAccountId ? (
      <ListState kind="empty" title="LINEアカウントを選んでください" description="上のバーから、コラムの紹介文を編集するLINEアカウントを選びます。" />
    ) : forbidden ? (
      <ListState kind="forbidden" onRetry={() => void load()} />
    ) : (
      <>
        {error && columns.length > 0 ? <Notice tone="danger" message={error} action={<Button type="button" onClick={() => void load(true)}>読み直す</Button>} /> : null}
        {loading && columns.length === 0 ? <ListState kind="loading" /> : columns.length === 0 && error ? (
          <ListState kind="error" title="コラムの紹介文を読み込めませんでした" description={error} onRetry={() => void load()} />
        ) : columns.length === 0 ? (
          <ListState kind="empty" title="コラムがまだありません。EC側で公開されると、ここに出ます。" />
        ) : columns.map((column) => <FormSection
      key={column.id} id={`column-intro-${column.id}`} title={column.title}
      description={column.publishedAt ? formatDay(column.publishedAt) : '未公開'}
      action={canEdit ? <Button onClick={() => save(column)} disabled={savingId === column.id || (drafts[column.id] ?? '') === (column.introText ?? '')} disabledReason={(drafts[column.id] ?? '') === (column.introText ?? '') ? '変えたところはありません' : null} busy={savingId === column.id} done={savedId === column.id}>保存する</Button> : undefined}>
      <Field label={`${column.title}の紹介文`}>
        <SaveErrorField names={[`${column.id}.introText`]}><TextArea rows={3} value={drafts[column.id] ?? ''} maxLength={1500} readOnly={!canEdit} onChange={(event) => {
          setDrafts((previous) => ({ ...previous, [column.id]: event.target.value }))
          if (savedId === column.id) setSavedId(null)
          if (saveError?.id === column.id) setSaveError(null)
        }} /></SaveErrorField>
      </Field>
      {latestIntro?.id === column.id ? <Field label="ほかの人が保存した最新の紹介文"><p>{latestIntro.text === '' ? '（空になっています）' : latestIntro.text}</p></Field> : null}
      {savingId === column.id ? <Notice tone="info" message="保存しています…" />
        : saveError?.id === column.id ? <Notice tone="danger" message={saveError.message} />
        : savedId === column.id ? <Notice tone="success" message="この紹介文を保存しました" />
        : (drafts[column.id] ?? '') !== (column.introText ?? '') ? <Notice tone="info" message="変更があります。保存するまで反映されません。" /> : null}
    </FormSection>)}
      </>
    )}
    <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した紹介文" onConfirm={confirmLeave} onCancel={cancelLeave} />
  </DetailPage></SaveErrorScope>
}
