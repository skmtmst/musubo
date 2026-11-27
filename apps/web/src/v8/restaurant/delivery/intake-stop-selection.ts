import type { DeliveryIntakeStopPreset, DeliveryService, DeliveryServiceState } from '@/lib/restaurant-delivery-api'

/** 停止中・一覧に無い対象・重複を外して入力を確かめる。接続と提供状況は共通の実行の門が確かめる。 */
export function intakeStopSelection(states: DeliveryServiceState[], selected: DeliveryService[], preset: DeliveryIntakeStopPreset | '') {
  const seen = new Set<DeliveryService>()
  const services = selected.filter((service) => {
    if (seen.has(service)) return false
    const matched = states.find((state) => state.service === service)
    if (!matched || matched.intakeStatus === 'stopped') return false
    seen.add(service)
    return true
  })
  const problem = services.length === 0 ? '停止するサービスを選んでください'
    : !preset ? '停止する時間を選んでください' : null
  return { services, preset, problem }
}
