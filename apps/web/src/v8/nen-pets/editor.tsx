'use client'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  name: requiredText("ペットの名前を入れてください。"),
}

import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import Dialog from '@/components/shared/dialog'
import Radio from '@/components/shared/radio'
import { TextField } from '@/components/shared/text-field'
import { FieldError } from '@/components/shared/form-controls'
import { useFieldValidation } from '@/lib/use-field-validation'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { ApiError, api } from '@/lib/api'
import type { NenPetRow } from '@/lib/nen-pets-api'
import { normalizeBirthdayInput } from './parts'
import styles from './pets.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { withHonorific } from '@line-crm/shared'


/*
 * ★V8-B ペットの情報を直す。真ん中の窓（幅 560・上から 170）。
 * 窓の枠は共通の Dialog。中身は 対象のペット → 種別 → 名前・品種 → 性別 → 誕生日・体重 → 補足。
 * 口は今の画面と同じ（PUT /api/nen-campaigns/pets/:id、版つき保存）。
 * 誕生日を変えると、予約中の誕生日クーポン配信は新しい誕生日で組み直される（Worker 側）。
 * ほかの人が先に直していたら（409 VERSION_CONFLICT）止めて、入力は残したまま保存し直せる。
 */

const ANIMALS = [
  { value: 'dog', label: '犬' },
  { value: 'cat', label: '猫' },
  { value: 'other', label: 'その他' },
] as const
const GENDERS = [
  { value: 'male', label: '男の子' },
  { value: 'female', label: '女の子' },
  { value: 'unknown', label: 'わからない' },
] as const

export default function PetEditorV8({ accountId, pet, onClose, onSaved }: {
  accountId: string
  pet: NenPetRow
  onClose: () => void
  onSaved: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const [name, setName] = useState(pet.name)
  const [animalType, setAnimalType] = useState<string>(pet.animalType)
  const [gender, setGender] = useState<string>(pet.gender)
  const [birthday, setBirthday] = useState(pet.birthday ?? '')
  const [breed, setBreed] = useState(pet.breed)
  const [weight, setWeight] = useState(pet.weightKg == null ? '' : `${pet.weightKg} kg`)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [version, setVersion] = useState<string>(pet.updatedAt)
  const savingRef = useRef(false)
  const mounted = useRef(true)
  const scope = useRef({ accountId, petId: pet.id, generation: 0 })
  if (scope.current.accountId !== accountId || scope.current.petId !== pet.id) {
    scope.current = { accountId, petId: pet.id, generation: scope.current.generation + 1 }
  }
  const prevScopeKey = useRef(`${accountId}:${pet.id}`)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const key = `${accountId}:${pet.id}`
    if (prevScopeKey.current === key) return
    prevScopeKey.current = key
    savingRef.current = false
    setSaving(false)
    setError('')
  }, [accountId, pet.id])

  const normalized = normalizeBirthdayInput(birthday)
  const weightText = weight.replace(/kg/i, '').trim()
  const weightKg = weightText === '' ? null : Number(weightText)
  const fields = useFieldValidation([
    ...((FIELD_REQUIREMENTS.name.check(name) !== null) ? [{ id: 'pet-edit-name', message: 'ペットの名前を入れてください。' }] : []),
    ...(normalized === 'invalid' ? [{ id: 'pet-edit-birthday', message: '誕生日は「2020-03-15」か「03-15」（月日だけ）で入力してください。' }] : []),
    ...(weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0.01 || weightKg > 200)
      ? [{ id: 'pet-edit-weight', message: '体重は 0.01〜200kg で入力してください。' }] : []),
  ])

  const save = async () => {
    if (savingRef.current) return
    setError('')
    if (!fields.submit()) return
    const targetAccountId = accountId
    const targetPetId = pet.id
    const targetGeneration = scope.current.generation
    const sameScope = () => mounted.current && scope.current.accountId === targetAccountId && scope.current.petId === targetPetId && scope.current.generation === targetGeneration
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const result = await api.nenCampaigns.updatePet(targetAccountId, targetPetId, {
        name: name.trim(),
        animalType,
        gender,
        birthday: normalized ?? '',
        breed: breed.trim(),
        weightKg,
        expectedUpdatedAt: version,
      })
      if (!sameScope()) return
      if (!result.success) throw new Error('ペットを保存できませんでした。時間をおいて、もう一度お試しください。')
      onSaved()
      onClose()
    } catch (caught) {
      if (!sameScope()) return
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409 && caught.code === 'VERSION_CONFLICT') {
        const latest = (caught.data as { latest?: { updatedAt?: string } } | null)?.latest
        if (latest?.updatedAt) setVersion(latest.updatedAt)
        { if (!fieldFailure)
        setError('ほかの人が先にペットの情報を変えました。最新の内容を確認してから、もう一度保存してください。入力した内容はそのまま残っています。') }
        onSaved()
        return
      }
      { if (!fieldFailure)
      setError(describeApiFailure(caught, 'ペットの保存', {
        scope: 'store',
      })) }
    } finally {
      if (sameScope()) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      key={`${accountId}:${pet.id}`}
      open
      designNode="eLjeQ"
      designWidth={560}
      designTop={170}
      designHeaderPadding="24px 24px 0"
      confirmIcon={<Check size={16} aria-hidden="true" />}
      title="ペットの情報を直す"
      description="間違っている項目を直して保存します。誕生日を変えると、予約中の誕生日クーポン配信は新しい誕生日で組み直されます。"
      dirty={name !== pet.name || animalType !== pet.animalType || gender !== pet.gender || birthday !== (pet.birthday ?? '') || breed !== pet.breed || weight !== (pet.weightKg == null ? '' : `${pet.weightKg} kg`)}
      busy={saving}
      error={error}
      confirmLabel="保存する"
      onConfirm={() => save()}
      onCancel={onClose}
    >
      <div className={styles.editor}>
        <div className={styles.editorPet}>
          <span aria-hidden="true" className={styles.editorFace}>{(pet.name || '?').slice(0, 1)}</span>
          <span className={styles.stack}>
            <span className={styles.cellStrong}>{pet.name || pet.callName}</span>
            <span className={styles.sub}>{`飼い主 ${withHonorific(pet.owner.name)}・${pet.owner.customerId ? `EC-${pet.owner.customerId}` : 'EC未連携'}`}</span>
          </span>
        </div>
        <div className={styles.editorGroup}>
          <span id="pet-animal-label" className={styles.groupLabel}>種別</span>
          <span className={styles.radioRow} role="radiogroup" aria-labelledby="pet-animal-label">
            {ANIMALS.map((item) => (
              <SaveErrorField names={["pet-animal","value","item.value","animalType"]} key={item.value}><Radio key={item.value} name="pet-animal" value={item.value} checked={animalType === item.value} onChange={() => setAnimalType(item.value)}>{item.label}</Radio></SaveErrorField>
            ))}
          </span>
        </div>
        <div className={styles.editorPair}>
          <Field label="ペットの名前" requirement={FIELD_REQUIREMENTS.name}><SaveErrorField names={["name"]}><TextField {...fields.bind('pet-edit-name')} aria-label="ペットの名前" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></SaveErrorField>
<FieldError id="pet-edit-name-error">{fields.error('pet-edit-name')}</FieldError></Field>
          <Field label="品種"><SaveErrorField names={["breed"]}><TextField aria-label="品種" value={breed} maxLength={80} onChange={(event) => setBreed(event.target.value)} /></SaveErrorField></Field>
        </div>
        <div className={styles.editorGroup}>
          <span id="pet-gender-label" className={styles.groupLabel}>性別</span>
          <span className={styles.radioRow} role="radiogroup" aria-labelledby="pet-gender-label">
            {GENDERS.map((item) => (
              <SaveErrorField names={["pet-gender","value","item.value","gender"]} key={item.value}><Radio key={item.value} name="pet-gender" value={item.value} checked={gender === item.value} onChange={() => setGender(item.value)}>{item.label}</Radio></SaveErrorField>
            ))}
          </span>
        </div>
        <div className={styles.editorPair}>
          <Field label="誕生日"><SaveErrorField names={["birthday"]}><TextField {...fields.bind('pet-edit-birthday')} aria-label="誕生日" placeholder="2022-04-03" value={birthday} onChange={(event) => setBirthday(event.target.value)} /></SaveErrorField>
<FieldError id="pet-edit-birthday-error">{fields.error('pet-edit-birthday')}</FieldError></Field>
          <Field label="体重"><SaveErrorField names={["weight"]}><TextField {...fields.bind('pet-edit-weight')} aria-label="体重" inputMode="decimal" placeholder="9.2 kg" value={weight} onChange={(event) => setWeight(event.target.value)} /></SaveErrorField>
<FieldError id="pet-edit-weight-error">{fields.error('pet-edit-weight')}</FieldError></Field>
        </div>
        <p className={styles.editorHint}>生まれた年が分からないときは「03-15」のように月日だけを入れます。空欄は未登録です。</p>
      </div>
    </Dialog></SaveErrorScope>
  )
}
