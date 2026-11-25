import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import SeatReserve from './pages/seat/seat-reserve.js';
import Form from './pages/form.js';
import RestaurantMenu from './pages/restaurant-menu/menu.js';
import { setLiffContext } from './lib/liff-auth.js';
import { setCustomerLiffRuntime, type CustomerLiffRuntime } from './lib/liff-runtime.js';
import './embedded.css';

let root:Root | null=null;
export function unmountRestaurant():void { root?.unmount(); root=null; setCustomerLiffRuntime(null); document.body.classList.remove('sb-active'); }

export function mountRestaurant(container:HTMLElement,context:{liffId:string;lineUserId:string;idToken:string;sdk?:CustomerLiffRuntime},page:'restaurant'|'restaurant-menu'|'form'='restaurant'):void {
 unmountRestaurant();
 setLiffContext(context);
 document.body.classList.add('sb-active');
 container.innerHTML='';
 root=createRoot(container);
 root.render(<StrictMode><BrowserRouter>{page === 'form' ? <Form /> : page === 'restaurant-menu' ? <RestaurantMenu /> : <SeatReserve />}</BrowserRouter></StrictMode>);
}
