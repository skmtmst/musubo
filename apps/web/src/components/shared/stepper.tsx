export type StepperState = 'done' | 'current' | 'todo' | 'attention'

/** 旧名。Stepper に寄せたので、新しくは StepperState を使う。 */
export type StepState = StepperState

export interface StepperStep {
  /** 省略時は label を使う。同名の段が並ぶときだけ付ける。 */
  key?: string
  label: string
  /** 案内用の縦並び手順で、操作名の下に表示する補足。 */
  description?: string
  /** 1始まりの表示番号。省略時は上からの順番。 */
  order?: number
  /**
   * 入力が済んだか（done／まだか todo／直すところがあるか attention）。
   * 「いまいる所」はここでは決めない。`currentKey`（段の居場所）と分ける（設計 C）。
   * `currentKey` を渡さない昔の呼び方は、そのまま state の `current` を居場所にする。
   */
  state: StepperState
  /** 押したときに飛ぶ節の id。済み・要修正の段だけに付ける。 */
  anchor?: string
  /** anchor の代わりに押したときの動き。済み・要修正の段だけに付ける。 */
  onSelect?: () => void
  /**
   * まだ（todo）の段でも押して移れる。開き直した下書きの最後の段（公開）のように、
   * 済みの印は付けないが入ってよい段だけに付ける。印は番号のまま、読み上げは「〇〇に進む」。
   */
  reachable?: boolean
}
