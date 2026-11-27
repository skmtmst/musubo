import type { DeliveryIntakeStopPreset, DeliveryService, DeliveryServiceState } from '@/lib/restaurant-delivery-api'

/** 停止中だけを外して入力を確かめる。接続と提供状況は共通の実行の門が確かめる。 */
export function intakeStopSelection(states: DeliveryServiceState[], selected: DeliveryService[], preset: DeliveryIntakeStopPreset | '') {
  const services = selected.filter(service => states.find(state => state.service === service)?.intakeStatus !== 'stopped')
  const problem = services.length === 0 ? '停止するサービスを選んでください'
    : !preset ? '停止する時間を選んでください' : null
  return { services, preset, problem }
}
