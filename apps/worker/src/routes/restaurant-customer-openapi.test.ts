import { it, expect } from 'vitest';
import { app } from '../index.js';
it('公開仕様も席予約の任意欄・席種・休業理由・遅刻案内を説明する',async()=>{
  const spec=await (await app.request('/openapi.json')).json() as any;
  const input=(path:string,method:string)=>spec.paths[path][method].requestBody.content['application/json'].schema.properties;
  for(const path of ['/api/liff/restaurant/holds','/api/liff/restaurant/reservations/{id}/confirm']) {
    const properties=input(path,'post');
    expect(properties.note).toMatchObject({maxLength:200});
    expect(properties.customerPhone).toMatchObject({maxLength:50});
  }
  const output=(path:string,method='get')=>spec.paths[path][method].responses['200'].content['application/json'].schema.properties.data;
  const availability=output('/api/liff/restaurant/availability').properties;
  expect(availability.unavailableReason.enum).toEqual(['temporary_closed','private_event','regular_closed','full']);
  expect(availability.slots.items.properties).toHaveProperty('seatTypes');
  expect(availability.lateArrivalPolicy.properties).toHaveProperty('cancelAfterMinutes');
  expect(spec.components.schemas.RestaurantCustomerBooking.properties).toHaveProperty('seatType');
  expect(input('/api/restaurant-test/opening-hours','put')).toHaveProperty('lateArrivalPolicy');
  expect(output('/api/restaurant-test/opening-hours').properties).toHaveProperty('lateArrivalPolicy');
  expect(output('/api/restaurant-test/opening-hours').required).toContain('hoursStatus');
  expect(output('/api/restaurant-test/opening-hours').properties.hoursStatus.enum).toEqual(['available','closed','temporarily_closed','permanently_closed','unavailable','unconfigured']);
  expect(output('/api/restaurant-test/opening-hours').properties.googleStatus.enum).toContain('expired');
  expect(output('/api/restaurant-test/reservation-link','post').properties.url.description).toContain('https://liff.line.me/<店舗のLIFF ID>?page=restaurant&token=<token>');
});
