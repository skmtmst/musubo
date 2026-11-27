/** 外から届いた値に対応する、自分で定義した項目だけを返す。 */
export function knownValue<T>(values: Readonly<Record<string, T>>, key: string, fallback: NoInfer<T>): T {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback
}
