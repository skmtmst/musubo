import type { DeliveryIntakeStopPreset, DeliveryService, DeliveryServiceState } from '@/lib/restaurant-delivery-api'

/** 停止中と重複だけを外して入力を確かめる。一覧に無い対象・接続・提供状況は共通の実行の門が全体を止める。 */
export function intakeStopSelection(states: DeliveryServiceState[], selected: DeliveryService[], preset: DeliveryIntakeStopPreset | '') {
  const seen = new Set<DeliveryService>()
  const services = selected.filter((service) => {
    if (seen.has(service)) return false
    if (states.find((state) => state.service === service)?.intakeStatus === 'stopped') return false
    seen.add(service)
    return true
  })
  const problem = services.length === 0 ? '停止するサービスを選んでください'
    : !preset ? '停止する時間を選んでください' : null
  return { services, preset, problem }
}
