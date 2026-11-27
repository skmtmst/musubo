'use client'
import SegmentedControl from '@/components/shared/segmented'

import { useListUrlJsonValue, useListUrlValue } from '@/components/shared/list-url-state';


import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bookmark, CalendarCheck, CalendarDays, FileText, History, PawPrint } from 'lucide-react';
import { ListPage } from '@/components/templates';
import Button from '@/components/shared/button'
import ActionMenu, { type ActionMenuItem } from '@/components/shared/action-menu';
import FilterChip from '@/components/shared/filter-chip'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table';
import { Tabs } from '@/components/shared/tabs';
import { usePageCrumbs } from '@/components/shell/page-chrome';
import { ApiError } from '@/lib/api';
import { nenPetsApi, petAnimalTypeLabel, type NenHealthKpis, type NenHealthListData, type NenHealthRow, type NenHealthSort, type NenHealthSummaryData } from '@/lib/nen-pets-api';
import HealthItemsV8 from './items'
import SummaryDrawerV8, { SummarySheet } from './summary';
import { EMPTY_FILTERS, Pill, RowMenu, WeightBars, changeBadges, md, type HealthFilters, type HealthTabKey } from './parts';
import styles from './health.module.css'
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import { ListToolbarRow, ListToolbarSearchSlot, ListToolbarEnd } from '@/components/shared/list-toolbar';
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select';

/*
 * ★V8-B 健康日記（Pencil「★V8-B 画面の地図」専用機能の組：
 * 一覧 ・30日のまとめ（引き出し）・記録の項目 ）。
 *
 * 外枠（見出し・獣医師向け PDF・タブ・数の帯）は3つのタブで同じ。型は ListPage。
 * データの口（health・healthSummary・印刷）は今の画面と同じ。
 * 健康日記はお客さまがマイページで付けるので、ここに変える操作は無い（閲覧のみでも同じ画面）。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

export type { HealthTabKey } from './parts'

const BOARD: Record<HealthTabKey, string> = { logs: 'mIwA4', concern: 'mIwA4', items: 'z2tvtX' }
const PAGE_SIZES = STANDARD_PAGE_SIZES
type ListStatus = 'loading' | 'ready' | 'error' | 'forbidden'
type SummaryState = { accountId: string; petId: string; data: NenHealthSummaryData }

export default function HealthV8({
  accountId,
  tab,
  onChangeTab,
}: {
  accountId: string | null
  tab: HealthTabKey
  onChangeTab: (next: HealthTabKey) => void
}) {
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const [kpis, setKpis] = useState<NenHealthKpis | null>(null)
