'use client'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { canAdministerRole, useStaffRole } from '@/lib/staff-role'
import HelpTip from './help-tip'
import { ChevronDown } from 'lucide-react'
import { allergyValues, DEFAULT_ALLERGY_OPTIONS } from '@line-crm/shared'
import { EntityMultiPickerDialog } from './entity-picker'
import TagPill from './tag-pill'
import TagOverflow from './tag-overflow'
import Chip from './chip'
import Button from './button'
import { TextField } from './text-field'
import styles from './customer-info-panel.module.css'

/** 旧文字値も外せる。窓の取消では確定した値を変えない。 */
export default function AllergyField({ accountId = null, value, options = [...DEFAULT_ALLERGY_OPTIONS], readOnly = false, showEmptyValue = true, onChange }: {
  accountId?: string | null; value: string | null; options?: string[]; readOnly?: boolean; showEmptyValue?: boolean; onChange: (value: string) => void
}) {
  const role = useStaffRole()
  const scope = useRef(accountId)
  scope.current = accountId
  const [accountOptions, setAccountOptions] = useState<string[] | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [other, setOther] = useState('')
  const [added, setAdded] = useState<string[]>([])
  useEffect(() => {
    let active = true
    setAccountOptions(null); setVersion(null); setLoading(false); setError(''); setOpen(false)
    if (accountId && !readOnly) void api.accountSettings.getAllergyOptions(accountId).then(result => {
      if (!active) return
      if (!result.success) throw new Error()
      setAccountOptions(result.data.options); setVersion(result.data.version)
    }).catch(() => { if (active) setError('候補を読み込めませんでした。画面を開き直してください。') })
    return () => { active = false }
  }, [accountId, readOnly])
  const selected = allergyValues(value)
  const choices = [...new Set([...(accountOptions ?? options), ...selected, ...added])]
  async function addOption() {
    const name = other.trim()
    if (!name || loading) return
    if (!canAdministerRole(role)) { setAdded(current => [...current, name]); setOther(''); return }
    if (!accountId || version === null || !accountOptions) { setError('候補を読み込めませんでした。画面を開き直してください。'); return }
    if (accountOptions.includes(name)) { setOther(''); return }
    if (accountOptions.length >= 32) { setError('共通の候補は32件までです。'); return }
    setLoading(true); setError('')
    try {
      const next = [...accountOptions, name]
      const result = await api.accountSettings.saveAllergyOptions(accountId, next, version)
      if (!result.success || !result.data) throw new Error()
      if (scope.current !== accountId) return
      setAccountOptions(next); setVersion(result.data.version); setOther('')
    } catch (cause) {
      if (scope.current !== accountId) return
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const latest = await api.accountSettings.getAllergyOptions(accountId)
          if (scope.current !== accountId) return
          if (!latest.success) throw new Error()
          setAccountOptions(latest.data.options); setVersion(latest.data.version)
          setError('候補が更新されました。内容を確認して、もう一度追加してください。')
        } catch { if (scope.current === accountId) setError('最新の候補を読み込めませんでした。時間をおいてもう一度お試しください。') }
      } else setError('候補を保存できませんでした。時間をおいてもう一度お試しください。')
    }
    finally { if (scope.current === accountId) setLoading(false) }
  }
  return <div className={styles.allergies}>
    {selected.length ? readOnly
      ? <TagOverflow maxVisible={2} label="すべてのアレルギー">{selected.map(name => <Chip key={name}>{name}</Chip>)}</TagOverflow>
      : selected.map(name => <TagPill key={name} name={name} onRemove={() => onChange(JSON.stringify(selected.filter(item => item !== name)))} />)
      : showEmptyValue ? <span className={styles.note}>未設定</span> : null}
    {/* 絵 e5uuD0：札の下に全幅の「選んで足す」（押すと選ぶ窓）。 */}
    {!readOnly ? <Button className={styles.allergyAdd} onClick={() => { setAdded([]); setOther(''); setOpen(true) }}><span>選んで足す</span><ChevronDown size={16} aria-hidden="true" /></Button> : null}
    {open ? <EntityMultiPickerDialog title="アレルギーを選ぶ" items={choices.map(name => ({ id: name, name }))} initialIds={selected} maxSelected={32}
      listFooter={<><div className={styles.other}><TextField aria-label="そのほか（自由に書く）" placeholder="例：キウイ" maxLength={100} value={other} onChange={event => setOther(event.target.value)} /><Button disabled={!other.trim() || loading} onClick={() => void addOption()}>{canAdministerRole(role) ? '候補に足す' : 'この項目にだけ足す'}</Button>{!canAdministerRole(role) ? <HelpTip label="候補への追加について">管理者以外が追加したものは、この項目だけに保存され、共通の候補には入りません。</HelpTip> : null}</div>{canAdministerRole(role) ? <p className={styles.allergyNote}>追加した候補は、友だち情報や回答フォームにもすぐに表示されます。</p> : null}{error ? <p className={styles.allergyError} role="alert">{error}</p> : null}</>}
      onCancel={() => setOpen(false)} onConfirm={values => { onChange(JSON.stringify(values)); setOpen(false) }} /> : null}
  </div>
}
