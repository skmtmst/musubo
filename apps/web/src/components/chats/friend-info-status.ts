import { SUPPORT_STATUS_LABELS, SUPPORT_STATUS_ORDER } from '@/components/shared/status-pill'
/** 固定の対応状況。自由な対応マークとは別。 */
export const STATUS_WORD = SUPPORT_STATUS_LABELS
export const STATUS_OPTIONS = SUPPORT_STATUS_ORDER.map(value => ({value, label: STATUS_WORD[value]}))
