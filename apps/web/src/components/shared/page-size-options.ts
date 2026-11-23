/** 一覧の既定件数と、同じ選択肢を共有する画面の追加の刻み。 */
export const DEFAULT_PAGE_SIZE = 20
export const PAGE_SIZES: readonly number[] = [10, 20, 50]
export const EXTENDED_PAGE_SIZES: readonly number[] = [10, 20, 30, 40, 50]

/** 写真ギャラリーの固定件数。2列でも3段以内で選べる。 */
export const PHOTO_GALLERY_PAGE_SIZE = 6

export const pageSizeLabel = (size: number) => `${size}件表示`
export const pageSizeOptions = (sizes: readonly number[]) => sizes.map(size => ({ value: String(size), label: pageSizeLabel(size) }))

/** 既存の自動応答一覧が提供する20・50・100件の選択肢。 */
export const LARGE_PAGE_SIZES: readonly number[] = [20, 50, 100]
export const LARGE_PAGE_SIZE_SELECT_OPTIONS = pageSizeOptions(LARGE_PAGE_SIZES)
