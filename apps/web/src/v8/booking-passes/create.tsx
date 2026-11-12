'use client'

import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'
import { PASS_LIST_HREF } from './words'

import { StepSection, StepContent } from '@/components/templates/steps'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { Pencil, Plus } from 'lucide-react'
import type { BookingPassPlan, BookingPassPlanWrite } from '@line-crm/shared'
import { CreatePage } from '@/components/templates/create-page'
import Button from '@/components/shared/button'
import Toggle from '@/components/shared/toggle'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { EntityMultiPickerDialog } from '@/components/shared/entity-picker'
import { loadEntityCandidates } from '@/components/shared/entity-remote-field'
import type { EntityPickerItem } from '@/components/shared/entity-picker'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import NumberField from '@/components/shared/number-field'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { notifySaved } from '@/components/shared/toast'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { bookingPassPlansApi } from '@/lib/api/helpers/gap3'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { KIND_LABEL, VALID_CHOICES, failureText, periodLabel, countLabel, validLabel, yen } from './words'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import styles from './passes.module.css'

/*
 * ★V8 回数券・月謝を作る・直す（B2-2 `nrtRJ`）。手順は 4 つ：① 種類と値段 ② 使える予約 ③ 期限と券が無い人の予約 ④ LINE で売る。
 * 今の手順は開き、済んだ手順は 1 行に畳んで［変える］で戻れる。作ると下書きで入り、［作る］で販売を始める。
 * ④ LINE での販売（オンライン決済）はまだ口が無いので、押すと「現在準備中です」を出す。
 * 入口 `/booking/passes/new`（直すときは `?id=`。下書きだけ直せる）。
 */

type StepKey = 1 | 2 | 3 | 4
type Errors = { name?: string; price?: string; count?: string; validDays?: string }

type Form = {
  kind: BookingPassPlan['kind']
  name: string
  price: string
  count: string
  monthlyLimit: string
  validDays: number
  menuIds: string[]
  allowWithoutPass: boolean
}

const EMPTY: Form = { kind: 'ticket', name: '', price: '', count: '10', monthlyLimit: '4', validDays: 180, menuIds: [], allowWithoutPass: true }

function fromPlan(plan: BookingPassPlan): Form {
  return {
    kind: plan.kind,
    name: plan.name,
    price: String(plan.price),
    count: String(plan.count ?? 10),
    monthlyLimit: String(plan.monthlyLimit ?? 4),
    validDays: plan.validDays,
    menuIds: plan.menuIds,
    allowWithoutPass: plan.allowWithoutPass,
  }
}

function PassCreateInner() {
  usePageTitle('回数券・月謝を作る')
  usePageCrumbs([{ label: '予約設定', href: '/booking/menus?tab=passes' }])
  const router = useRouter()
  const params = useSearchParams()
  const editId = params.get('id')
  const { selectedAccountId: accountId, loading: accountLoading } = useAccount()
  const role = useStaffRole()
  const canEdit = canManageRole(role)
  const preparing = usePreparingDialog()
  const [form, setForm] = useState<Form>(EMPTY)
  const [original, setOriginal] = useState<BookingPassPlan | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'missing'>(editId ? 'loading' : 'ready')
  const [open, setOpen] = useState<StepKey>(1)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState<'draft' | 'create' | null>(null)
  const [notice, setNotice] = useState('')
  const [menus, setMenus] = useState<EntityPickerItem[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [confirmScope, setConfirmScope] = useState('')
  const [validationBlocked, setValidationBlocked] = useState(false)
  useEffect(() => { setValidationBlocked(false) }, [form])
  const [dirty, setDirty] = useState(false)
  const errorsScope = useSaveFormErrors()
  const currentAttempt = useRef<{
    scope: string; key: string; plan: BookingPassPlan | null; signature: string
  } | null>(null)
  const scope = JSON.stringify([accountId, editId])
  if (!currentAttempt.current || currentAttempt.current.scope !== scope) {
    currentAttempt.current = { scope, key: crypto.randomUUID(), plan: null, signature: '' }
  }
  const attempt = currentAttempt.current
  const formKey = JSON.stringify(form)
  const formScope = useRef({ key: formKey })
  if (formScope.current.key !== formKey) formScope.current = { key: formKey }
  const authorityScope = useRef({ allowed: canEdit })
  if (authorityScope.current.allowed !== canEdit) authorityScope.current = { allowed: canEdit }
  const confirmTicket = useRef<{ attempt: typeof attempt; form: typeof formScope.current; authority: typeof authorityScope.current } | null>(null)
  const renderedTicket = confirmTicket.current
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const confirmChanged = confirmCreate && (!renderedTicket || renderedTicket.attempt !== attempt || renderedTicket.form !== formScope.current || renderedTicket.authority !== authorityScope.current)
  useEffect(() => {
    setConfirmCreate(false); setConfirmScope(''); setBusy(null); setNotice(''); setErrors({})
    setOriginal(null); setForm(EMPTY); setDirty(false)
    setLoadState(editId ? 'loading' : 'ready')
    errorsScope.reset()
  }, [attempt])


  const patch = (next: Partial<Form>) => { setNotice(''); setDirty(true); setForm((current) => ({ ...current, ...next })) }

  useEffect(() => {
    if (!accountId) return
    let alive = true
    loadEntityCandidates('booking_menu', accountId).then((items) => { if (alive) setMenus(items) }).catch(() => undefined)
    return () => { alive = false }
  }, [accountId])

  useEffect(() => {
    if (!editId || !accountId) return
    let alive = true
    bookingPassPlansApi.list(accountId, '', 0, 50)
      .then((response) => {
        if (!alive) return
        if (!response.success) throw new Error('failed')
        const found = response.data.items.find((plan) => plan.id === editId)
        if (!found || found.status !== 'draft') { setLoadState('missing'); return }
        setOriginal(found)
        setForm(fromPlan(found))
        setLoadState('ready')
      })
      .catch(() => { if (alive) setLoadState('error') })
    return () => { alive = false }
  }, [editId, accountId])

  const menuNameOf = useCallback((id: string) => menus.find((item) => item.id === id)?.name ?? id, [menus])

  const body = (): BookingPassPlanWrite | null => {
    const found: Errors = {}
    const price = Number(form.price)
    const count = Number(form.kind === 'ticket' ? form.count : form.monthlyLimit)
    if (!form.name.trim()) found.name = '名前を入れてください。'
    else if (form.name.trim().length > 100) found.name = '名前は 100 文字までです。'
    if (form.price.trim() === '' || !Number.isInteger(price) || price < 0) found.price = '0 以上の整数（円）を入れてください。'
    if (!Number.isInteger(count) || count < 1) found.count = form.kind === 'ticket' ? '1 以上の回数を入れてください。' : '1 か月に使える回数（1 以上）を入れてください。'
    setErrors(found)
    if (found.name || found.price) { setOpen(1); return null }
    if (found.count) { setOpen(1); return null }
    return {
      kind: form.kind,
      name: form.name.trim(),
      price,
      count: form.kind === 'ticket' ? count : null,
      monthlyLimit: form.kind === 'monthly' ? count : null,
      validDays: form.validDays,
      menuIds: form.menuIds,
      allowWithoutPass: form.allowWithoutPass,
    }
  }

  const submit = async (start: boolean) => {
    if (!canEdit || busy || !accountId || (start && confirmScope !== scope)) return
    const payload = body()
    if (!payload) return
    const signature = JSON.stringify(payload)
    const stillHere = () => currentAttempt.current === attempt
    setBusy(start ? 'create' : 'draft')
    setNotice('')
    try {
      let plan = attempt.plan ?? original
      if (!plan || attempt.signature !== signature) {
        const response = plan
          ? await bookingPassPlansApi.save(accountId, plan.id, { ...payload, expectedVersion: plan.version })
          : await bookingPassPlansApi.create(accountId, payload, attempt.key)
        if (!response.success) throw new Error('回数券を保存できませんでした。')
        plan = response.data
        attempt.plan = plan
        attempt.signature = signature
      }
      if (start) {
        const started = await bookingPassPlansApi.start(accountId, plan.id, plan.version)
        if (!started.success) throw new Error('販売を始められませんでした。')
      }
      if (!stillHere()) return
      setDirty(false)
      setConfirmCreate(false)
      notifySaved(start ? `「${plan.name}」の販売を始めました。` : `「${plan.name}」を下書きで保存しました。`)
      router.push(PASS_LIST_HREF)
      return true
    } catch (reason) {
      if (!stillHere()) return
      errorsScope.capture(reason)
      const fieldErrors = readSaveFieldErrors(reason)
      if (Object.keys(fieldErrors).length > 0) {
        setErrors(current => ({ ...current, name: fieldErrors.name ?? fieldErrors['form.name'], price: fieldErrors.price ?? fieldErrors['form.price'], count: fieldErrors.count ?? fieldErrors.monthlyLimit }))
        setValidationBlocked(true)
        setNotice(`${Object.values(fieldErrors).join(' ')} 戻って入力を直してください。`)
      } else setNotice(failureText(reason, start ? '作る' : '保存する'))
      return false
    } finally {
      if (stillHere()) setBusy(null)
    }
  }

  const summary1 = [KIND_LABEL[form.kind], form.name.trim() || '名前はまだ', countLabel({ kind: form.kind, count: Number(form.count) || null, monthlyLimit: Number(form.monthlyLimit) || null }), form.price.trim() === '' ? '値段はまだ' : yen(Number(form.price) || 0)].join('・')
  const summary2 = form.menuIds.length === 0 ? 'すべての予約' : form.menuIds.map(menuNameOf).join('・')
  const summary3 = `${periodLabel({ kind: form.kind, validDays: form.validDays })}・${form.allowWithoutPass ? '券が無い人も予約できる' : '券が無い人は予約できない'}`
  const summary4 = 'まだ（あとで Stripe とつなぐ）'

  const stepCard = (n: StepKey, title: string, summary: string, content: ReactNode, change?: () => void) => (
    <StepSection readOnly={!canEdit} key={n} order={n} title={title} summary={summary} open={open === n} onChange={change ?? (() => setOpen(n))}>{content}</StepSection>
  )

  const footer = canEdit ? (
    <>
      <Button onClick={() => router.push(PASS_LIST_HREF)} disabled={busy !== null}>キャンセル</Button>
      <Button variant="secondary" onClick={() => void submit(false)} busy={busy === 'draft'} disabled={busy !== null}>下書き保存</Button>
      <Button variant="primary" onClick={() => { if (body()) { confirmTicket.current = { attempt, form: formScope.current, authority: authorityScope.current }; setConfirmScope(scope); setConfirmCreate(true) } }} busy={busy === 'create'} disabled={busy !== null}>作る</Button>
    </>
  ) : null

  const content = accountLoading || loadState === 'loading' ? (
    <ListState kind="loading" title="読み込んでいます" />
  ) : !accountId ? (
    <ListState kind="empty" emptyPreset="readonly" title="LINEアカウントを選んでください" description="共通メニューで、回数券・月謝を作るアカウントを選んでください。" />
  ) : loadState === 'error' ? (
    <ListState kind="error" onRetry={() => window.location.reload()} />
  ) : loadState === 'missing' ? (
    <ListState kind="empty" emptyPreset="readonly" title="この回数券・月謝は直せません" description="見つからないか、販売を始めたあとです。販売を始めた券は、やめることだけできます。" />
  ) : (
    <StepContent step={open} className={styles.formSections}>
      {notice ? <Notice tone="danger" message={notice} /> : null}
      {stepCard(1, '種類と値段', summary1, (
        <>
          <Field label="種類" required>
            <SegmentedControl aria-label="種類" value={form.kind} onChange={(kind) => patch({ kind })} options={[{ value: 'ticket', label: '回数券' }, { value: 'monthly', label: '月謝' }]} />
          </Field>
          <Field label="名前" required error={errors.name}>
            <TextField aria-label="名前" value={form.name} maxLength={100} onChange={(event) => patch({ name: event.target.value })} />
          </Field>
          <div className={styles.row}>
            <Field label="値段" required error={errors.price}>
              <NumberField aria-label="値段" value={form.price} unit="円" min={0} onChange={(event) => patch({ price: event.target.value })} />
            </Field>
            {form.kind === 'ticket' ? (
              <Field label="回数" required error={errors.count}>
                <NumberField aria-label="回数" value={form.count} unit="回" min={1} onChange={(event) => patch({ count: event.target.value })} />
              </Field>
            ) : (
              <Field label="1 か月の回数" required error={errors.count}>
                <NumberField aria-label="1 か月の回数" value={form.monthlyLimit} unit="回" min={1} onChange={(event) => patch({ monthlyLimit: event.target.value })} />
              </Field>
            )}
          </div>
          <div><Button variant="primary" onClick={() => setOpen(2)}>次へ</Button></div>
        </>
      ))}
      {stepCard(2, '使える予約', summary2, (
        <>
          <p className={styles.note}>この券で予約できるメニュー・クラスを選びます。選ばないと、すべての予約で使えます。</p>
          <div className={styles.picked}>
            {form.menuIds.map((id) => (
              <Button key={id} variant="secondary" onClick={() => patch({ menuIds: form.menuIds.filter((value) => value !== id) })} title="押すと外します">{`${menuNameOf(id)} ×`}</Button>
            ))}
            <Button variant="secondary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setPickerOpen(true)}>選ぶ</Button>
          </div>
          <div><Button variant="primary" onClick={() => setOpen(3)}>次へ</Button></div>
        </>
      ))}
      {stepCard(3, '期限と券が無い人の予約', summary3, (
        <>
          {form.kind === 'ticket' ? (
            <Field label="期限" note="買った日から数えます。">
              <Select
                aria-label="期限"
                value={String(form.validDays)}
                onChange={(value) => patch({ validDays: Number(value) })}
                options={Array.from(new Set([...VALID_CHOICES, form.validDays])).sort((a, b) => a - b).map((days) => ({ value: String(days), label: `買って ${validLabel(days)}` }))}
              />
            </Field>
          ) : (
            <Field label="期限" note="月謝は、毎月その月の回数を使えます。">
              <Select aria-label="期限" value={String(form.validDays)} onChange={(value) => patch({ validDays: Number(value) })} options={Array.from(new Set([...VALID_CHOICES, form.validDays])).sort((a, b) => a - b).map((days) => ({ value: String(days), label: `つづけられる期間：${validLabel(days)}` }))} />
            </Field>
          )}
          <Field label="券が無い人の予約">
            <span className={styles.picked}>
              <Toggle checked={form.allowWithoutPass} label="券が無い人も予約できる" onChange={(checked) => patch({ allowWithoutPass: checked })} />
              <span>券が無い人も予約できる</span>
            </span>
          </Field>
          <div><Button variant="primary" onClick={() => setOpen(4)}>次へ</Button></div>
        </>
      ))}
      {stepCard(4, 'LINE で売る', summary4, (
        <>
          <p className={styles.note}>LINE の中で買えるようにする機能です。今は、お店の窓口で付ける形だけ使えます。</p>
          <div><Button variant="secondary" onClick={() => preparing.open('LINEでの回数券・月謝の販売')}>つなぎ方を見る</Button></div>
        </>
      ), () => preparing.open('LINEでの回数券・月謝の販売'))}
    </StepContent>
  )

  return (
    <SaveErrorScope errors={errorsScope}>
      <CreatePage
        boardId="nrtRJ"
        title="回数券・月謝を作る"
        help="お客さまが予約で使う回数券・月謝の種類を作ります。下書きで保存して、あとから販売を始められます。"
        readOnly={!canEdit}
        dirty={dirty}
        busy={busy !== null}
        footerActions={footer}
      >
        {content}
      </CreatePage>
      {pickerOpen ? (
        <EntityMultiPickerDialog
          title="使える予約"
          description="この券で予約できるメニュー・クラスを選びます。"
          items={menus}
          initialIds={form.menuIds}
          unit="件"
          onCancel={() => setPickerOpen(false)}
          onConfirm={(ids) => { patch({ menuIds: ids }); setPickerOpen(false) }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmCreate && confirmScope === scope}
        title={`「${form.name.trim()}」の販売を始めますか？`}
        description="始めると、種類・回数・値段・使える予約は変えられません。お客さまに券を付けられるようになります。まだ始めないときは、下書き保存を押してください。"
        confirmLabel="販売を始める"
        busy={busy === 'create'}
        cancelLabel={validationBlocked ? "戻って直す" : "キャンセル"} confirmDisabled={validationBlocked || confirmChanged} confirmDisabledReason={confirmChanged ? '内容が変わりました。閉じて確認し直してください。' : '戻って入力を直してください。'}
        error={notice || undefined} onSuccess={() => { confirmTicket.current = null; setConfirmCreate(false) }} onConfirm={() => { if (renderedTicket && renderedTicket === confirmTicket.current && renderedTicket.attempt === currentAttempt.current && renderedTicket.form === formScope.current && renderedTicket.authority === authorityScope.current && canEditRef.current) return submit(true) }}
        onCancel={() => { confirmTicket.current = null; setConfirmCreate(false) }}
      ><OperationTargetSummary accounts={[{ id: accountId ?? '' }]} /></ConfirmDialog>
      {preparing.dialog}
    </SaveErrorScope>
  )
}

export default function PassCreateV8() {
  return <Suspense fallback={<ListState kind="loading" title="読み込んでいます" />}><PassCreateInner /></Suspense>
}
