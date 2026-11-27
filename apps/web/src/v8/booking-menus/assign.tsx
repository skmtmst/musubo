'use client'
import { notifySaved, notifyToast } from '@/components/shared/toast'
import { Th } from '@/components/shared/table'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import { Tabs } from '@/components/shared/tabs'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { describeApiFailure, classifyApiFailure, isForbiddenOrRateLimited, loadFailureCopy, withPermissionFailure } from '@/components/shared/api-error-message'
import { useAccount } from '@/contexts/account-context'
import { useStaffRole } from '@/lib/staff-role'
import { useBookingEdit } from './lib/edit-permission'
import { CreatePage } from '@/components/templates/create-page'
import { Check } from 'lucide-react'
import { describeSaveFailure, bookingApi, type BookingMenu, type BookingStaff, type StaffMenuMatrix } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { menuPriceLabel } from './lib/menu-price'
import shell from './settings.module.css'
import styles from './assign.module.css'
import TruncatedText from '@/components/shared/truncated-text'

import { Field } from '@/components/shared/form-controls'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { V8_TABS } from './settings-parts'

/*
 * ★V8「担当メニューをまとめて決める」（板 ）。
 *
 * 白い板1枚：頭（←予約へ・題・未保存の印・9タブ）→ 中身（左＝メニュー×
 * スタッフの升目表と升の中身を変える段、右＝空きの欄）→ 書きかけがある間だけ
 * 下に保存帯（キャンセル・保存）。タブは押すと予約設定のそのタブへ移る
 * （未保存なら共通の離脱確認が出る）。
 *
 * 升の緑の升を押すと「受ける／受けない」が切り替わり、その升の時間と料金を
 * 変える段が下に出る。担当が0人のメニューは黄色い帯で知らせる。
 * 動き（一括保存・未保存の離脱確認・権限での閲覧のみ化・失敗時の扱い）は
 * 管理画面 の /booking/menus/staff と同じ。テーマが 互換経路のときはこのファイルは
 * 読まれず、従来の見た目が出る。
 */

type SelectedCell = { staffId: string; menuId: string }

function staffLabel(person: BookingStaff): string {
  return person.display_name || person.name
}

/** 升目表の読み込み待ちの骨組み（見出し行＋5行・メニュー列＋担当3列の形）。 */
function MatrixSkeleton() {
  return (
    <section className={shell.section} data-design="Table" aria-hidden="true">
      <div className={shell.sectionHead}>
        <Skeleton width={200} height={18} />
      </div>
      <div className={styles.matrixWrap}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <Th className={styles.matrixMenuHead} scope="col"><Skeleton width={80} height={14} /></Th>
              {[0, 1, 2].map((i) => (
                <Th key={i} className={styles.matrixStaffHead} scope="col"><Skeleton width={64} height={14} /></Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3, 4].map((row) => (
              <tr key={row}>
                <Th scope="row" className={styles.matrixMenuCell}><Skeleton width="80%" height={15} /></Th>
                {[0, 1, 2].map((col) => (
                  <td key={col} className={styles.matrixCell}><Skeleton width={18} height={18} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function AssignMatrixV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('予約設定')
  const sp = useSearchParams()
  /** 一覧から「スタッフ割当」で来たときに、その行を目立たせる。 */
  const focusMenuId = sp.get('menu_id') ?? ''
  const { selectedAccountId } = useAccount()
  const [menus, setMenus] = useState<BookingMenu[]>([])
  const [staff, setStaff] = useState<BookingStaff[]>([])
  /** staffId → menuId → 設定。 */
  const [grid, setGrid] = useState<Record<string, Record<string, StaffMenuMatrix>>>({})
  /* 保存済みの表を控えておき、差分が未保存と分かるようにする（管理画面 #975 U075 と同じ）。 */
  const [savedGrid, setSavedGrid] = useState<Record<string, Record<string, StaffMenuMatrix>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** 保存が終わった直後の1.2秒だけ、保存ボタンに完了（✓）を出す。 */
  const [saveDone, setSaveDone] = useState(false)
  const saveDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const loadSeqRef = useRef(0)
  const saveSeqRef = useRef(0)
  const savingRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadSeqRef.current += 1
      saveSeqRef.current += 1
      savingRef.current = false
      if (saveDoneTimerRef.current !== null) clearTimeout(saveDoneTimerRef.current)
    }
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  /** 升を押したあと、時間・料金を変える段が対象にする升。 */
  const [selected, setSelected] = useState<SelectedCell | null>(null)
  const canEditMenus = useBookingEdit('/booking/menus')
  // 役割が読めるまで帯は出さない（空の div で段間を空けない。他画面と同じ）。
  const role = useStaffRole()

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    saveSeqRef.current += 1
    savingRef.current = false
    setSaving(false)
    setSaveDone(false)
    if (!selectedAccountId) {
      setLoading(false)
      setError(null)
      setLoadError(null)
      setMenus([])
      setStaff([])
      setGrid({})
      setSavedGrid(null)
      setSelected(null)
      return
    }
    const accountId = selectedAccountId
    setLoading(true)
    setError(null)
    setLoadError(null)
    setMenus([])
    setStaff([])
    setGrid({})
    setSavedGrid(null)
    setSelected(null)
    try {
      const [menusRes, staffRes] = await Promise.all([
        bookingApi.listMenus(accountId),
        bookingApi.listStaff(accountId),
      ])
      if (!mountedRef.current || seq !== loadSeqRef.current) return
      if (!Array.isArray(menusRes?.menus) || !Array.isArray(staffRes?.staff)) {
        throw new Error('データの形式が正しくありません')
      }
      // お客さまの画面・メニュー一覧と同じ並び（sort_order）で並べる。
      setMenus([...menusRes.menus].sort((a, b) => a.sort_order - b.sort_order))
      setStaff(staffRes.staff)

      /* #1060 と同じ：一括口が無い Worker ではスタッフごとの取得へ退く。 */
      const matrices = new Map<string, StaffMenuMatrix[]>()
      try {
        const bulk = await bookingApi.listStaffMenusBulk(accountId)
        if (!mountedRef.current || seq !== loadSeqRef.current) return
        if (!Array.isArray(bulk?.staff)) throw new Error('一括割り当ての形式が正しくありません')
        for (const entry of bulk.staff) {
          if (entry && Array.isArray(entry.matrix)) matrices.set(entry.staff_id, entry.matrix)
        }
      } catch (saveFailure) {
        if (!mountedRef.current || seq !== loadSeqRef.current) return
        saveErrors.capture(saveFailure)
        await Promise.all(
          staffRes.staff.map(async (s) => {
            const r = await bookingApi.getStaffMenus(accountId, s.id)
            if (!mountedRef.current || seq !== loadSeqRef.current) return
            if (!Array.isArray(r?.matrix)) throw new Error('担当メニューの形式が正しくありません')
            matrices.set(s.id, r.matrix)
          }),
        )
        if (!mountedRef.current || seq !== loadSeqRef.current) return
      }
      const next: Record<string, Record<string, StaffMenuMatrix>> = {}
      for (const s of staffRes.staff) {
        const matrix = matrices.get(s.id) ?? []
        const byMenu: Record<string, StaffMenuMatrix> = {}
        for (const m of menusRes.menus) {
          byMenu[m.id] = matrix.find((x) => x.menu_id === m.id) ?? {
            menu_id: m.id,
            name: m.name,
            is_offered: 0,
            override_duration_minutes: null,
            override_price: null,
          }
        }
        next[s.id] = byMenu
      }
      setGrid(next)
      setSavedGrid(next)
    } catch (e) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)
      setLoadError(e) }
      if (isForbiddenOrRateLimited(e)) {
        { if (!fieldFailure)

        setError(loadFailureCopy(e, '担当スタッフの割り当て').description ?? '読み込めませんでした。')
      }
      } else {
        const message = describeApiFailure(e, '読み込み')
        { if (!fieldFailure)
        setError(message && !/^API error: /.test(message) ? message : '読み込めませんでした。画面を再読み込みして確認してください。')
      }
    }
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setLoading(false)
      }
    }
  }, [selectedAccountId, saveErrors])

  useEffect(() => {
    void load()
  }, [load])

  function update(staffId: string, menuId: string, patch: Partial<StaffMenuMatrix>) {
    if (!canEditMenus || savingRef.current) return
    setGrid((cur) => {
      const staffRow = cur[staffId]
      const cell = staffRow?.[menuId]
      if (!staffRow || !cell) return cur
      return {
        ...cur,
        [staffId]: { ...staffRow, [menuId]: { ...cell, ...patch } },
      }
    })
  }

  /** 表1枚ぶんを一括の口へ流す。 */
  async function putGrid(accountId: string, next: Record<string, Record<string, StaffMenuMatrix>>) {
    await bookingApi.putStaffMenusBulk(
      accountId,
      staff.map((s) => ({
        staff_id: s.id,
        menus: menus.map((m) => {
          const row = next[s.id]?.[m.id]
          return {
            menu_id: m.id,
            is_offered: Boolean(row?.is_offered),
            override_duration_minutes: row?.override_duration_minutes ?? null,
            override_price: row?.override_price ?? null,
          }
        }),
      })),
    )
  }

  function flashDone() {
    setSaveDone(true)
    if (saveDoneTimerRef.current !== null) clearTimeout(saveDoneTimerRef.current)
    saveDoneTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setSaveDone(false)
    }, 1600)
  }

  async function saveAll() {
    if (!selectedAccountId || !canEditMenus || savingRef.current || loading || savedGrid === null) return
    const accountId = selectedAccountId
    const saveSeq = ++saveSeqRef.current
    const loadSeq = loadSeqRef.current
    const snapshot = grid
    savingRef.current = true
    setSaving(true)
    setSaveDone(false)
    setError(null)
    try {
      await putGrid(accountId, snapshot)
      if (!mountedRef.current || saveSeq !== saveSeqRef.current || loadSeq !== loadSeqRef.current) return
      setSavedGrid(snapshot)
      flashDone()
      notifySaved('保存しました')
    } catch (e) {
      if (!mountedRef.current || saveSeq !== saveSeqRef.current || loadSeq !== loadSeqRef.current) return
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)

      setError(
        `${withPermissionFailure(e, describeSaveFailure(e), 'store')}（保存は取り消されました。画面を再読み込みして最新の状態を確認してください）`,
      ) }
    } finally {
      if (saveSeq === saveSeqRef.current) {
        savingRef.current = false
        if (mountedRef.current) setSaving(false)
      }
    }
  }


  /* 「いま受付できる人数」（有効の担当だけ）と「割ってある人数」を分ける（管理画面 R308 と同じ）。 */
  const assignedCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of menus) {
      let n = 0
      for (const s of staff) if (grid[s.id]?.[m.id]?.is_offered) n += 1
      counts.set(m.id, n)
    }
    return counts
  }, [menus, staff, grid])
  const availableCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of menus) {
      let n = 0
      for (const s of staff) if (s.is_active && grid[s.id]?.[m.id]?.is_offered) n += 1
      counts.set(m.id, n)
    }
    return counts
  }, [menus, staff, grid])

  /** 受付できる担当がいないメニュー（誰も割っていない／止めている担当だけ）。 */
  const orphans = menus.filter((m) => (availableCounts.get(m.id) ?? 0) === 0)
  const unassigned = orphans.filter((m) => (assignedCounts.get(m.id) ?? 0) === 0)
  const inactiveOnly = orphans.filter((m) => (assignedCounts.get(m.id) ?? 0) > 0)

  const dirty = useMemo(
    () => savedGrid !== null && JSON.stringify(grid) !== JSON.stringify(savedGrid),
    [grid, savedGrid],
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  const loadFailed = error !== null && savedGrid === null
  const loadFailure = loadError ? loadFailureCopy(loadError, '担当スタッフの割り当て') : null

  /* 読み込んだら、上書きのある最初の升を選んでおく（上書きがあることに気づけるように。絵 ）。 */
  useEffect(() => {
    if (loading || selected !== null) return
    for (const m of menus) {
      for (const s of staff) {
        const row = grid[s.id]?.[m.id]
        if (row && (row.override_duration_minutes != null || row.override_price != null)) {
          setSelected({ staffId: s.id, menuId: m.id })
          return
        }
      }
    }
  }, [loading, selected, menus, staff, grid])

  /* 升の中身を変える段が対象にしている升。 */
  const selectedStaff = selected ? staff.find((s) => s.id === selected.staffId) ?? null : null
  const selectedMenu = selected ? menus.find((m) => m.id === selected.menuId) ?? null : null
  const selectedRow = selected ? grid[selected.staffId]?.[selected.menuId] ?? null : null
  const selectedOverridden =
    Boolean(selectedRow) &&
    (selectedRow!.override_duration_minutes != null || selectedRow!.override_price != null)

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage boardId="ooufy" dirty={false}
              footerActions={canEditMenus ? (
              <>
                <Button
                  onClick={() => { setGrid(savedGrid ?? grid); if (!loadFailed) setError(null) }}
                  disabled={saving}
                >
                  キャンセル
                </Button>
                <Button
                  variant="primary" icon={<Check size={16} aria-hidden="true" />}
                  onClick={() => {
                    if (!dirty) {
                      notifyToast('変更はありません。')
                      return
                    }
                    void saveAll()
                  }}
                  // WEB061：保存の失敗で保存を押せなくしない（やり直せるように）。止めるのは読み込みの失敗だけ。
                  disabled={saving || !selectedAccountId || loading || loadFailed}
                  busy={saving}

                >
                  <Check size={16} aria-hidden="true" />保存する
                </Button>
              </>
            ) : null}
        title="予約設定"
        help="メニューごとに、予約を受けられるスタッフを決めます"
        status={dirty ? '未保存の変更があります' : undefined}
        tabs={<><Tabs
            label="予約設定のタブ"
            items={V8_TABS.map((item) => ({
              label: item.label,
              current: item.key === 'staff',
              href: item.key === 'staff'
                ? undefined
                : item.key === 'menus'
                  ? '/booking/menus'
                  : `/booking/menus?tab=${item.key}`,
            }))}
          /></>} >

          {/* R5：同じ理由が並ぶ画面は上に1回だけ短い文（題の下・自前の帯。他画面と同じ置き方）。 */}
          {selectedAccountId && role !== null && !canEditMenus ? (
            <div className={styles.viewerBand}><ReadOnlyNotice role="status" /></div>
          ) : null}

          {!selectedAccountId ? (
            <div className={shell.stateCard}>
              <p className={shell.stateTitle}>LINEアカウントを選んでください</p>
              <p className={shell.stateDesc}>共通メニューで、予約設定を開くLINEアカウントを選んでください。</p>
            </div>
          ) : loading ? (
            <div aria-busy="true">
              <span className="sr-only" role="status">メニューと担当スタッフを読み込んでいます</span>
              <DelayedSkeleton loading skeleton={<MatrixSkeleton />} />
            </div>
          ) : loadFailed ? (
            <div className={shell.stateCard}>
              <p className={shell.stateTitle}>{loadFailure?.title ?? '読み込めませんでした'}</p>
              <p className={shell.stateDesc}>{loadFailure?.description ?? error}</p>
              {loadFailure?.retryable || classifyApiFailure(loadError) === 'forbidden' ? (
                <div className={shell.stateActions}>
                  <Button onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button>
                </div>
              ) : null}
            </div>
          ) : staff.length === 0 ? (
            <div className={shell.stateCard}>
              <p className={shell.stateTitle}>スタッフはまだいません</p>
              <p className={shell.stateDesc}>先に担当スタッフを登録してください。</p>
              <div className={shell.stateActions}>
                <Button href="/booking/menus?tab=staff">担当スタッフを開く</Button>
              </div>
            </div>
          ) : (
            <>
              {error && !loadFailed ? (
                <Notice tone="danger" className={shell.warnBandNoticePlacement} >{error}</Notice>
              ) : null}

              <section className={shell.section} data-design="Table">
                <div className={shell.sectionHead}>
                  <h2 className={shell.sectionTitle}>だれがどのメニューを受けるか</h2>
                  <p className={shell.sectionDesc}>担当が0人のメニューは、出していてもお客さまの画面に枠が出ません</p>
                </div>

                <div className={styles.matrixWrap}>

                  <table className={styles.matrix}>
                    <thead>
                      <tr>
                        <Th className={styles.matrixMenuHead} scope="col">メニュー</Th>
                        {staff.map((s) => (
                          <Th key={s.id} className={styles.matrixStaffHead} scope="col">
                            {/* 止めている・指名なしは名前の横の小さな印と title で（行の高さを変えない）。 */}
                            <span
                              className={styles.matrixStaffName}
                              title={`${staffLabel(s)}${!s.is_active ? '（止めている）' : ''}${s.is_designation_optional === 1 ? '（指名なしを受ける）' : ''}`}
                            >
                              {staffLabel(s)}
                              {!s.is_active ? <span className={styles.matrixStaffOff}>停止中</span> : null}
                            </span>
                          </Th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {menus.map((m) => (
                        <tr
                          key={m.id}
                          id={`menu-${m.id}`}
                          className={focusMenuId === m.id ? styles.matrixRowFocus : undefined}
                        >
                          <Th scope="row" className={styles.matrixMenuCell}>
                            <span className={styles.matrixMenuName} ><TruncatedText value={String(m.name ?? '')} /></span>
                          </Th>
                          {staff.map((s) => {
                            const row = grid[s.id]?.[m.id]
                            const offered = Boolean(row?.is_offered)
                            const overridden =
                              row?.override_duration_minutes != null || row?.override_price != null
                            const isSelected = selected?.staffId === s.id && selected?.menuId === m.id
                            return (
                              <td
                                key={s.id}
                                className={styles.matrixCell}
                                data-selected={isSelected || undefined}
                                onClick={() => setSelected({ staffId: s.id, menuId: m.id })}
                                onFocusCapture={() => setSelected({ staffId: s.id, menuId: m.id })}
                              >
                                <span className={styles.cellBox}>
                                  <SaveErrorField names={["offered"]}><Checkbox
                                    checked={offered}
                                    disabled={!canEditMenus || saving}
                                    onCheckedChange={(checked) =>
                                      update(s.id, m.id, { is_offered: checked ? 1 : 0 })
                                    }
                                    aria-label={`${m.name} を ${staffLabel(s)} が受ける`}
                                  /></SaveErrorField>
                                  {overridden ? (
                                    <span className={styles.ovrDot} title="時間・料金をこのスタッフ用に変えています" />
                                  ) : null}
                                </span>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {selectedStaff && selectedMenu && selectedRow ? (
                  <div className={styles.overrideCard} data-design="Override">
                    <h3 className={styles.overrideTitle}>
                      {`升を押したとき（${staffLabel(selectedStaff)} × ${selectedMenu.name}）`}
                    </h3>
                  <div className={styles.overrideFields}>
                    <Field fill label="このスタッフの所要時間" help={`メニューは ${selectedMenu.duration_minutes} 分`}><SaveErrorField names={["override_duration_minutes","selectedRow.override_duration_minutes","selected_row.override_duration_minutes"]}><NumberInput unit="分"
                          type="number"
                          min={1}
                          disabled={!canEditMenus || saving || !selectedRow.is_offered}
                          value={selectedRow.override_duration_minutes ?? ''}
                          onChange={(e) => {
                            if (e.target.value === '') {
                              update(selectedStaff.id, selectedMenu.id, { override_duration_minutes: null })
                              return
                            }
                            const nextVal = Number(e.target.value)
                            if (!Number.isFinite(nextVal)) return
                            update(selectedStaff.id, selectedMenu.id, { override_duration_minutes: nextVal })
                          }}
                          placeholder={String(selectedMenu.duration_minutes)}
                          aria-label={`${staffLabel(selectedStaff)} の ${selectedMenu.name} の所要時間`}
                        /></SaveErrorField>
                        </Field>
                    <Field fill label="このスタッフの料金" help={`メニューは ${menuPriceLabel(selectedMenu)}`}><SaveErrorField names={["override_price","selectedRow.override_price","selected_row.override_price"]}><NumberInput unit="円"
                          type="number"
                          min={0}
                          disabled={!canEditMenus || saving || !selectedRow.is_offered}
                          value={selectedRow.override_price ?? ''}
                          onChange={(e) => {
                            if (e.target.value === '') {
                              update(selectedStaff.id, selectedMenu.id, { override_price: null })
                              return
                            }
                            const nextVal = Number(e.target.value)
                            if (!Number.isFinite(nextVal)) return
                            update(selectedStaff.id, selectedMenu.id, { override_price: nextVal })
                          }}
                          placeholder={formatNumber(selectedMenu.base_price)}
                          aria-label={`${staffLabel(selectedStaff)} の ${selectedMenu.name} の料金`}
                        /></SaveErrorField>
                        </Field>
                    <span className={styles.overrideClear}>
                      <Button
                        disabled={!canEditMenus || saving || !selectedOverridden}
                        onClick={() =>
                          update(selectedStaff.id, selectedMenu.id, {
                            override_duration_minutes: null,
                            override_price: null,
                          })
                        }
                      >
                        上書きを消す
                      </Button>
                    </span>
                  </div>
                  <div className={styles.legendRow}>
                    <span className={styles.legendCheck} aria-hidden="true">
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4l2.5 2.5L9 1" /></svg>
                    </span>
                    <span className={styles.legendName}>{staffLabel(selectedStaff)}</span>
                    {selectedOverridden ? (
                      <span className={styles.ovrBadge}>
                        <span className={styles.ovrBadgeDot} aria-hidden="true" />
                        上書きあり
                      </span>
                    ) : null}
                    <span className={styles.legendCaption}>上書きがある升にはこの印が付きます</span>
                  </div>
                  </div>
                ) : null}

                {orphans.length > 0 ? (
                  <Notice tone="warn" role="alert" data-design="Warn"><span>
                    {unassigned.length > 0
                      ? `「${unassigned.map((m) => m.name).join('」「')}」は担当が0人です。出しても予約は入りません。`
                      : null}
                    {inactiveOnly.length > 0
                      ? `${unassigned.length > 0 ? ' ' : ''}「${inactiveOnly.map((m) => m.name).join('」「')}」は受付を止めている担当しかいません。`
                      : null}
                  </span></Notice>
                ) : null}
              </section>
            </>
          )}
      </CreatePage>

      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="担当割り当てへの変更"
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
      />
    </SaveErrorScope>
  )
}
