import type { AuthenticatedStaff } from './middleware/auth/principal/auth.js';
import { type ServerTiming } from './lib/server-timing-types.js';
import { type ImpersonationContext } from './middleware/impersonation-types.js';
import type { WorkerBindings } from './worker-bindings.js';

export type Env = {
  Bindings: WorkerBindings;
  Variables: {
    // 役割と読み取り専用は別の軸。middleware/auth.ts の AuthenticatedStaff と揃える。
    staff: AuthenticatedStaff;
    adminHandoffNonce?: string;
    /** route固有の監査を残した場合、共通middlewareとの二重記録を防ぐ。 */
    auditRecorded?: boolean;
    mfaAuditRecorded?: boolean;
    outputAuditRecorded?: boolean;
    outputAudit?: { count: number | null; accountId?: string; accountIds?: string[]; accountCounts?: Record<string, number>; targetId?: string; phase?: 'requested' | 'download' };
    /** 代理ログイン中（★37-5）。middleware/impersonation.ts が入れる。 */
    impersonation?: ImpersonationContext;
    /** スタイルで有効になった飲食店機能を、選択したLINEに限定する。 */
    restaurantScopedAccountId?: string;
    /** 段ごとの経過時間。lib/server-timing.ts が入れる。 */
    serverTiming?: ServerTiming;
  };
};
