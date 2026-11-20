// この操作の公開名。案内の持ち主を貸し借りする入れ物だけを出す。
// 画面全体の入れ物（GuideHost）を抱き込まないため、案内の重ね表示とは別の入口にする。
export type { SharedGuide } from '../../guide-shared'
export { GuideSharedProvider, useSharedGuide } from '../../guide-shared'
