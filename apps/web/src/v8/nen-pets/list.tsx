'use client'

import { ListToolbarRow, ListToolbarSearchSlot, ListToolbarEnd, ListToolbarSort } from '@/components/shared/list-toolbar'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import TruncatedText from '@/components/shared/truncated-text'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import EntitySelect from '@/components/shared/entity-select'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { ApiError } from '@/lib/api'
import { nenPetsApi, petAnimalTypeLabel, type NenPetKpis, type NenPetListData, type NenPetRow, type NenPetSort } from '@/lib/nen-pets-api'
import PetEditorV8 from './editor'
import { NEUTERED_LABEL, Pill, RowMenu, feedingLines, monthDay, type PetsQuery } from './parts'
import styles from './pets.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select'

/*
 * ★V8-B 登録ペットの一覧（・1152 は ）。
 * 案内の帯 → 道具の段（探す・種別・主食・体重更新・並び・件数）→ 表 → 件数 → ヒント。
 * 表は「見出し 36・行 56」。1152 では 年齢・避妊去勢・運動量 を隠し、年齢は種類の後ろへ寄せる。
 * 取得の口・指定は今の画面と同じ（GET /api/nen/pets）。
 */

type ListStatus = 'loading' | 'ready' | 'error' | 'forbidden'
const PAGE_SIZES = STANDARD_PAGE_SIZES

export default function PetsListV8({
  accountId,
  canEdit,
  query,
  onQueryChange,
  onKpis,
  onKpisFailed,
}: {
  accountId: string
  canEdit: boolean
  query: PetsQuery
  onQueryChange: (next: PetsQuery) => void
  /** 数の帯へ渡す。setState をそのまま渡す（毎回作り直さない）。 */
  onKpis: (kpis: NenPetKpis) => void
      onKpisFailed?.(true)
