/** 日付・時刻の範囲を、前後に半角空白を入れたダッシュでつなぐ。 */
export function displayRange(start: string, end: string): string {
  return `${start} – ${end}`
}
