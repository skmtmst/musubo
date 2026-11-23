import { styleRestaurantBookingAck } from './style-restaurant-booking-ack.js';
import { styleStarterDistribution } from './style-starter-distribution.js';
import { Hono } from 'hono';


import type { Env } from '../worker-env.js';

import { requireRole } from '../middleware/role-guard.js';
import { StyleError } from '../services/style-setup.js';




import { hq } from './styles-common.js';
import { styles as group1 } from './styles-routes-1.js';
import { styles as group2 } from './styles-routes-2.js';
import { styles as group3 } from './styles-routes-3.js';
import { styles as group4 } from './styles-routes-4.js';
import { styles as group5 } from './styles-routes-5.js';
export { bookingAudience } from './styles-common.js';

export const styles = new Hono<Env>();

styles.onError((e, c) => {
  if (String(e).includes('style_mode_capacity_full'))
    return c.json({ success: false, code: 'mode_capacity_full' }, 409);
  if (
    String(e).includes('STYLE_VERSION_CONFLICT') ||
    String(e).includes('UNIQUE constraint failed: style_starter_items.') ||
    String(e).includes('malformed JSON')
  )
    return c.json({ success: false, code: 'version_conflict' }, 409);
  return c.json(
    {
      success: false,
      code: e instanceof StyleError ? e.code : 'style_unavailable',
      error:
        e instanceof StyleError
          ? e.code
          : '情報を確認できません。再読み込みしてください',
    },
    e instanceof StyleError ? e.status : 503,
  );
});

styles.use(
  '/api/dashboard/style*',
  requireRole('owner', 'admin', 'staff'),
  async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method) && c.get('staff').readOnly)
      throw new StyleError('read_only', 403);
    await next();
  },
);

styles.use('/api/hq/style*', requireRole('owner', 'admin'), async (c, next) => {
  await hq(c, c.req.path === '/api/hq/style-attention');
  await next();
});
styles.route('/', styleRestaurantBookingAck);
styles.route('/', group1);
styles.route('/', group2);
styles.route('/', group3);
styles.route('/', group4);
styles.route('/', group5);

styles.route('/',styleStarterDistribution);
