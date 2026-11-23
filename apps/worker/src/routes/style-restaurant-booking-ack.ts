import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { restaurantEffectivelyEnabledForAccount } from '../services/tenant-features.js';
import { acknowledgeRestaurantBookings,undoRestaurantBookingAcknowledgement } from '../services/restaurant-booking-ack.js';
import { StyleError } from '../services/style-setup.js';
import { account,base,edit,json,text } from './styles-common.js';

export const styleRestaurantBookingAck = new Hono<Env>();
styleRestaurantBookingAck.post(base+'/new-bookings/acknowledgements',async c=>{
  edit(c,'/restaurant-test/reservations');
  const accountId=await account(c);
  if(!await restaurantEffectivelyEnabledForAccount(c,accountId))throw new StyleError('not_found',404);
  const body=await json(c);const storeId=text(body.storeId,200);const operationId=text(body.operationId,100);
  const bookingId=body.bookingId===null?null:text(body.bookingId,200);
  if(!storeId||!operationId||(body.bookingId!==null && !bookingId))throw new StyleError('invalid_request');
  return c.json({success:true,data:await acknowledgeRestaurantBookings(c.env.DB,{accountId,storeId,actorId:c.get('staff').id,operationId,bookingId})});
});
styleRestaurantBookingAck.post(base+'/new-bookings/acknowledgements/:operationId/undo',async c=>{
  edit(c,'/restaurant-test/reservations');
  const accountId=await account(c);
  if(!await restaurantEffectivelyEnabledForAccount(c,accountId))throw new StyleError('not_found',404);
  const body=await json(c);const storeId=text(body.storeId,200);
  if(!storeId)throw new StyleError('invalid_request');
  return c.json({success:true,data:await undoRestaurantBookingAcknowledgement(c.env.DB,{accountId,storeId,actorId:c.get('staff').id,operationId:c.req.param('operationId')??''})});
});
