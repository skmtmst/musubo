import { fetchApi } from './api'
import type { ApiResponse } from '@line-crm/shared'
import { formatNumber } from '@/lib/format'
import { knownValue } from '@/lib/known-value'

/**
 * 然-NEN- マイペット（★管理画面 37-3）／健康日記（★管理画面 37-4）。
 * Worker `apps/worker/src/routes/nen-pets.ts`。ペットの正本は LINE 側（お客様がマイページで登録・更新）。
 */

export type PetNeutered = 'yes' | 'no' | 'unknown'
export type PetActivity = 'low' | 'normal' | 'high'

/**
 * 動物種別の共通定義（#999 DEEP-24）。
 * API は dog / cat / other を返す。「その他」を犬へ変換して表示しない。
 * 見知らぬ値は犬へ倒さず、届いた文字列をそのまま出す。
 */
export type PetAnimalType = 'dog' | 'cat' | 'other'
export const PET_ANIMAL_TYPE_LABELS: Record<PetAnimalType, string> = { dog: '犬', cat: '猫', other: 'その他' }
export function petAnimalTypeLabel(animalType: string): string {
  return knownValue(PET_ANIMAL_TYPE_LABELS, animalType, animalType || 'その他')
}

export interface NenPetRow {
  id: string
  name: string
  /** 呼び名（男の子＝くん、女の子＝ちゃん） */
  callName: string
  gender: 'male' | 'female' | 'unknown'
  animalType: PetAnimalType
  breed: string
  birthday: string | null
  ageLabel: string
  weightKg: number | null
  neutered: PetNeutered
  activityLevel: PetActivity
  activityLabel: string
  productName: string | null
  feeding: { dailyKcal: number; dailyGrams: number | null; factorLabel: string; stageLabel: string; venisonGrams: number | null; venisonKcal: number; treatName: string | null } | null
  imageUrl: string | null
  updatedAt: string
  /** 「体重の更新」列に出す日。体重を測った・直した日だけで、名前の編集では動かない（監査 R57）。 */
  weightUpdatedAt: string
  weightStale: boolean
  owner: { friendId: string; name: string; pictureUrl: string | null; customerId: string | null }
}

export interface NenPetKpis {
  total: number
  dogs: number
  cats: number
  newThisMonth: number
  computable: number
  staleWeight: number
}

export interface NenPetListData {
  items: NenPetRow[]
  total: number
  page: number
  pageSize: number
  kpis: NenPetKpis
  products: Array<{ id: string; name: string }>
  treatLimitPercent: number
}

export type NenPetSort = 'updated_desc' | 'name' | 'weight_desc' | 'age_desc'
export type NenPetWeightFilter = '' | 'stale' | 'fresh'

export interface NenHealthChange {
  key: 'weight_drop' | 'weight_gain' | 'stool_abnormal' | 'appetite_poor' | 'silent'
  label: string
  tone: 'warn' | 'faint'
}

export interface NenHealthRow {
  pet: { id: string; name: string; callName: string; animalType: PetAnimalType; breed: string; ageLabel: string; imageUrl: string | null }
  owner: { friendId: string; name: string; customerId: string | null }
  lastLoggedOn: string | null
  lastLoggedLabel: string
  daysSinceLast: number | null
  count30d: number
  totalRecords: number
  weightSeries: Array<number | null>
  latestWeightKg: number | null
  weightChangePercent: number | null
  latestStool: string | null
  latestAppetite: string | null
  changes: NenHealthChange[]
  concerning: boolean
}

export interface NenHealthKpis {
  recordsThisWeek: number
  petsWithRecords: number
  petsTotal: number
  concerning: number
  silent30: number
}

export interface NenHealthListData {
  items: NenHealthRow[]
  total: number
  page: number
  pageSize: number
  kpis: NenHealthKpis
}

export type NenHealthChangeFilter = '' | 'concern' | 'silent' | 'none'
export type NenHealthLastFilter = '' | '7' | '30' | 'over30'
export type NenHealthSort = 'concern' | 'recent' | 'records_desc'

export interface NenHealthSummaryData {
  pet: { id: string; name: string; callName: string; animalType: PetAnimalType; breed: string; ageLabel: string; weightKg: number | null }
  owner: { friendId: string; name: string }
  generatedAt: string
  summary: {
    days: number
    records: number
    weight: { first: number; last: number; min: number; max: number } | null
    heartRateAvg: number | null
    respiratoryRateAvg: number | null
    stool: Record<string, number>
    appetite: Record<string, number>
    skin: Record<string, number>
    tearStain: Record<string, number>
    notes: Array<{ loggedOn: string; note: string }>
    logs: Array<{
      loggedOn: string; weightKg: number | null; heartRateBpm: number | null; respiratoryRateBpm: number | null
      stool: string; appetite: string; skin: string | null; tearStain: string | null
    }>
  }
  labels: { stool: Record<string, string>; appetite: Record<string, string> }
}

/**
 * 一覧の頭数表示。0頭のときは範囲を付けず「0頭」だけにする。
 * 範囲の計算に `pageSize` が要るが、取れていないときに `NaN` を
 * 出さない（全ルート監査 A3、2026-09-25）。
 */
export function headCountLabel(total: number, page: number, pageSize: number): string {
  if (total === 0) return '0頭'
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return `${formatNumber(total)}頭中 ${from}〜${to}頭`
}

function qs(params: Record<string, string | number | undefined>): string {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') out.set(key, String(value))
  }
  return out.toString()
}

export const nenPetsApi = {
  pets: (accountId: string, params: { q?: string; species?: string; product?: string; weight?: NenPetWeightFilter; sort?: NenPetSort; page?: number; pageSize?: number | 'all' } = {}) =>
    fetchApi<ApiResponse<NenPetListData>>(`/api/nen/pets?${qs({ accountId, ...params })}`),
  health: (accountId: string, params: { q?: string; change?: NenHealthChangeFilter; last?: NenHealthLastFilter; sort?: NenHealthSort; page?: number; pageSize?: number } = {}) =>
    fetchApi<ApiResponse<NenHealthListData>>(`/api/nen/health?${qs({ accountId, ...params })}`),
  healthSummary: (accountId: string, petId: string) =>
    fetchApi<ApiResponse<NenHealthSummaryData>>(`/api/nen/health/${encodeURIComponent(petId)}/summary?${qs({ accountId })}`),
}
