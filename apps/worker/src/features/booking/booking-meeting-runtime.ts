import type { MeetingQueueDependencies } from './booking-meeting-queue.js';
import type { Env } from '../../worker-env.js';

/** 相手先の接続は後続のアダプタで登録する。未設定なら失敗を通知し、外部操作しない。 */
export function meetingQueueDependencies(_env:Env['Bindings']):MeetingQueueDependencies {
 return { resolve: async () => null };
}
