'use client'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  name: requiredText("名前を入力してください"),
  slug: { required: true, check: (value: string) => SLUG_PATTERN.test(value) ? null : 'URLに使う名前は、半角英小文字・数字・ハイフンで2〜32文字にしてください' },
}


import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Check } from 'lucide-react'
import type { LineAccount } from '@line-crm/shared'
import Card, { CardHeader } from '@/components/shared/card'
import { useStaffRole } from '@/lib/staff-role'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { createPageErrorMessage, createPageReturnHref } from '@/components/shared/create-page'
import { usePageTitle } from '@/components/shell/page-chrome'
import { api } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { SbSettingsScreen } from '../sb-frame/settings-screen'
import styles from './create.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'
import { notifySaved } from '@/components/shared/toast'

/*
 * ★V8-B プール管理「プールを作る」（Pencil ・/pools/new）。
 *
 * 設定の板（中のメニューつき）の中に、左に「1. どのプールか」「2. いまの受け入れ先」の2枚、
 * 右に「プレビュー」。保存の帯は画面の下（キャンセル・保存してURLを発行）。
 * 動きは前の V8（app/pools/new/pool-new-v8.tsx。この画面に置き換えて消した）と同じ：LINEアカウントの一覧を読み（失敗は読み直しの口）、
 * 受け入れ先は複数・1件以上、URLに使う名前は半角英小文字・数字・ハイフンの2〜32文字、
 * 全部の受け入れ先を1回の保存で登録（落ちたらプールも所属も作られない・入力は残す）、作れたら一覧へ（作った行を目立たせる）。
 */

/** slug は URL に出る。日本語や記号を許すと /pool/xxx が壊れる。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/
const TITLE = 'プールを作る'
const DESCRIPTION = '複数の LINE 公式アカウントをひとまとめにして、友だちの追加先を自動で振り分けます。'
const LIST_HREF = '/pools'

function accountHandle(account: LineAccount): string | null {
  if (!account.basicId) return null
  return account.basicId.startsWith('@') ? account.basicId : `@${account.basicId}`
}

function PoolCreateBody() {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  /** 受け入れ先（複数）。先頭が作るときの受け入れ先になる。 */
  const [accountIds, setAccountIds] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerValue, setPickerValue] = useState('')
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [accountsError, setAccountsError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [inputError, setInputError] = useState<{ target: string; message: string } | null>(null)

  useEffect(() => {
    if (!inputError) return
    const control = document.getElementById(inputError.target)
    control?.focus()
    control?.scrollIntoView?.({ block: 'center' })
  }, [inputError])

  const guard = useUnsavedGuard({
    dirty: name !== '' || slug !== '' || (accounts.length > 0 && accountIds.join(',') !== accounts[0].id),
    busy: saving,
  })

  /* 一覧が取れないときに「0件」と見せない。失敗したことと読み直す口を出す。 */
  const loadAccounts = useCallback(async () => {
    setAccountsError('')
    try {
      const res = await api.lineAccounts.list()
      if (res.success) {
        setAccounts(res.data)
        if (res.data.length > 0) setAccountIds((current) => (current.length > 0 ? current : [res.data[0].id]))
      } else {
        setAccountsError('LINEアカウントを読み込めませんでした。もう一度お試しください。')
      }
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setAccountsError('LINEアカウントを読み込めませんでした。通信を確かめて、もう一度お試しください。')
    }
  }
  }, [saveErrors])

  useEffect(() => { void loadAccounts() }, [loadAccounts])

  const selectedAccounts = accountIds
    .map((id) => accounts.find((account) => account.id === id))
    .filter((account): account is LineAccount => Boolean(account))
  const addableAccounts = accounts.filter((account) => !accountIds.includes(account.id))
  const slugValid = SLUG_PATTERN.test(slug)
  const publicUrl = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/pool/${slugValid ? slug : 'shibuya'}`

  const addAccount = () => {
    if (!pickerValue) return
    setAccountIds((current) => (current.includes(pickerValue) ? current : [...current, pickerValue]))
    setPickerValue('')
    setPickerOpen(false)
  }

  const validate = (): { target: string; message: string } | null => {
    if ((FIELD_REQUIREMENTS.name.check(name) !== null)) return { target: 'pl-name', message: '名前を入力してください' }
    const slugError = FIELD_REQUIREMENTS.slug.check(slug)
    if (slugError) return { target: 'pl-slug', message: slugError }
    if (accountIds.length === 0) return { target: 'pl-add-account', message: '受け入れ先のアカウントを選んでください' }
    return null
  }

  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (saving) return
    const problem = validate()
    setError('')
    if (problem) { setInputError(problem); return }
    setInputError(null)
    setSaving(true)
    setError('')
    try {
      const res = await api.pools.create({ name: name.trim(), slug: slug.trim(), activeAccountId: accountIds[0], accountIds })
      if (!res.success) throw new Error(res.error)
      guard.disarm()
      notifySaved('プールを作成しました。')
      router.push(createPageReturnHref(LIST_HREF, res.data.id))
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)


      setError(createPageErrorMessage(e)) }
    } finally {
      setSaving(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
    <SbSettingsScreen
      boardId="D0AOyx"
      layout="narrow-nav"
      title={TITLE}
      help={DESCRIPTION}
      preview={(
        <>
          <Card variant="aside">
            <CardHeader size="stacked" title="プレビュー" />
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>友だち追加URL</dt>
                <dd>{slugValid ? publicUrl : 'まだURLは発行されていません。「URLに使う名前」を入れて保存すると、正式なURLが発行されます。'}</dd>
              </div>
              <div className={styles.fact}>
                <dt>現在の受け入れ先</dt>
                <dd>{selectedAccounts.length > 0 ? `${selectedAccounts.map((account) => account.name).join('・')}（有効の所属先からランダムに振り分け）` : '未選択'}</dd>
              </div>
            </dl>
          </Card>
        </>
      )}
      saveActions={(
        <>
          <Button href={LIST_HREF}>キャンセル</Button>
          <Button variant="primary" type="submit" form="pool-create-form" busy={saving} busyLabel="保存しています…" disabled={saving}>
            <Check className={styles.btnIcon} aria-hidden="true" />保存してURLを発行
          </Button>
        </>
      )}
    >
      <form id="pool-create-form" className={styles.main} onSubmit={(event) => void save(event)} noValidate>
          {error ? <Notice tone="danger" >{error}</Notice> : null}
          <Card variant="form" aria-labelledby="pool-create-what">
            <CardHeader size="stacked" titleId="pool-create-what" title="1. どのプールか" />
            <Field label="プール名" htmlFor="pl-name" error={inputError?.target === 'pl-name' ? inputError.message : undefined} requirement={FIELD_REQUIREMENTS.name}>
              <SaveErrorField names={["name"]}><TextField id="pl-name" value={name} onChange={(event) => { setName(event.target.value); if (inputError?.target === 'pl-name') setInputError(null) }} placeholder="例：渋谷エリア" maxLength={100} /></SaveErrorField>
            </Field>
            <Field note={<>
              {slugValid
                ? `保存すると、このURLが発行されます：${publicUrl}`
                : '半角英小文字・数字・ハイフンで2〜32文字。配ったURLが使えなくなるため、あとから変えられません。'}
            </>} label="URLに使う名前（あとから変えられません）" requirement={FIELD_REQUIREMENTS.slug} htmlFor="pl-slug" error={inputError?.target === 'pl-slug' ? inputError.message : undefined}>
              <SaveErrorField names={["slug"]}><TextField id="pl-slug" value={slug} onChange={(event) => { setSlug(event.target.value); if (inputError?.target === 'pl-slug') setInputError(null) }} placeholder="shibuya" maxLength={32} /></SaveErrorField>
            </Field>

          </Card>

          <Card variant="form" aria-labelledby="pool-create-where">
            <CardHeader size="stacked" titleId="pool-create-where" title="2. いまの受け入れ先" meta="友だちが開く追加先と、現在の受け入れ先です" />
            {selectedAccounts.map((account) => (
              <Card key={account.id} layout="horizontal" padding="compact" gap="normal" surface="muted">
                <span className={styles.accountName} ><TruncatedText value={String(account.name ?? '')} /></span>
                {accountHandle(account) ? <span className={styles.accountSub}>{accountHandle(account)}</span> : null}
                <span className={styles.spacer} />
                <Button
                  type="button"
                  onClick={() => setAccountIds((current) => current.filter((id) => id !== account.id))}
                  disabled={accountIds.length <= 1}
                  title={accountIds.length <= 1 ? '受け入れ先は1件以上必要です' : `${account.name}を外す`}
                >
                  外す
                </Button>
              </Card>
            ))}
            {pickerOpen ? (
              <div className={styles.picker}>
                <span className={styles.pickerSelect}>
                  <SaveErrorField names={["pickerValue","picker_value"]}><EntitySelect value={pickerValue} onChange={setPickerValue} aria-label="足すアカウント" size="full" options={addableAccounts.map((account) => ({ ...entityOptionMetadata(account), value: account.id, label: account.name }))} /></SaveErrorField>
                </span>
                <Button type="button" onClick={addAccount} disabled={!pickerValue}>追加</Button>
              </div>
            ) : (
              <span className={styles.addRow}>
                <Button id="pl-add-account" type="button" onClick={() => { setInputError(null); setPickerOpen(true) }} disabled={addableAccounts.length === 0}>＋ アカウントを足す</Button>
              </span>
            )}
            {inputError?.target === 'pl-add-account' ? <p className={styles.error} role="alert">{inputError.message}</p> : null}
            {accountsError ? (
              <Notice tone="danger" >{accountsError}{' '}<Button variant="text" onClick={() => void loadAccounts()}>もう一度読み込む</Button></Notice>
            ) : null}
          </Card>
      </form>
    </SbSettingsScreen>
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="入力したプールの内容" busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    </></SaveErrorScope>
  )
}

/** APIと同じowner限定。確認前も入力と変更操作を出さない。 */
export default function PoolCreateV8() {
  usePageTitle(TITLE)
  const role = useStaffRole()
  if (role !== 'owner') return <SbSettingsScreen boardId="D0AOyx" layout="narrow-nav" title={TITLE} help={DESCRIPTION}>
    <ReadOnlyNotice>プールを作れるのはオーナーだけです。作成はオーナーに頼んでください。</ReadOnlyNotice>
    <Button href={LIST_HREF}>プール一覧へ戻る</Button>
  </SbSettingsScreen>
  return <PoolCreateBody />
}
