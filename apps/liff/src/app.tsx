import { liffActionFromUrl } from '@line-crm/shared';
import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import LoadingView from './components/loading-view.js';
import { useCustomerStyle } from './components/customer-style-scope.js';
import CustomerBookingEntry from './components/customer-booking-entry.js';

// 画面ごとに束を分ける。開いた画面のぶんだけ読む。
const Booking = lazy(() => import('./pages/booking.js'));
const BookingHistory = lazy(() => import('./pages/booking-history.js'));
const MyPage = lazy(() => import('./pages/my-page.js'));
const Event = lazy(() => import('./pages/event.js'));
const EventConfirm = lazy(() => import('./pages/event-confirm.js'));
const EventDone = lazy(() => import('./pages/event-done.js'));
const EventBookings = lazy(() => import('./pages/event-bookings.js'));
const Affiliate = lazy(() => import('./pages/affiliate.js'));
const Webinar = lazy(() => import('./pages/webinar.js'));
const Research = lazy(() => import('./pages/research.js'));
const EventCatalog = lazy(() => import('./pages/event-catalog.js'));
const Form = lazy(() => import('./pages/form.js'));
const EventWaitlistOffer = lazy(() => import('./pages/event-waitlist-offer.js'));
const VisitStampQr = lazy(() => import('./pages/visit-stamp-qr.js'));
const VisitStamps = lazy(() => import('./pages/visit-stamps.js'));
const SeatReserve = lazy(() => import('./pages/seat/seat-reserve.js'));
const RestaurantMenu = lazy(() => import('./pages/restaurant-menu/menu.js'));
const EntryRouteCoupon = lazy(() => import('./pages/entry-route-coupon.js'));
const FileOpen = lazy(() => import('./pages/file-open.js'));
const StatementOpen = lazy(() => import('./pages/statement-open.js'));
const NotFound = lazy(() => import('./pages/not-found.js'));

function Loading() {
  return <LoadingView />;
}

export default function App() {
  const [search] = useSearchParams();
  const location = useLocation();
  const style = useCustomerStyle();
  if (search.get('couponRef')) return <Suspense fallback={<Loading />}><EntryRouteCoupon /></Suspense>;
  const waitlistToken = search.get('eventWaitlistToken');
  if (waitlistToken) {
    return (
      <Suspense fallback={<Loading />}>
        <EventWaitlistOffer token={waitlistToken} />
      </Suspense>
    );
  }

  if (location.pathname === '/' && search.get('page') === 'webinar' && search.get('slug')) {
    return <Navigate to={{ pathname: `/webinar/${encodeURIComponent(search.get('slug')!)}`, search: location.search }} replace />;
  }

  if (location.pathname === '/' && search.get('page') === 'research' && search.get('researchId')) {
    return <Navigate to={{ pathname: `/research/${encodeURIComponent(search.get('researchId')!)}`, search: location.search }} replace />;
  }

  if (location.pathname === '/' && search.get('page') === 'mypage') {
    return <Navigate to={{ pathname: '/mypage', search: location.search }} replace />;
  }

  if (location.pathname === '/' && search.get('page') === 'event') {
    const id = search.get('eventId');
    return id
      ? <Navigate to={{ pathname: `/events/${encodeURIComponent(id)}`, search: location.search }} replace />
      : <CustomerBookingEntry><Suspense fallback={<Loading />}><NotFound /></Suspense></CustomerBookingEntry>;
  }

  if (location.pathname === '/' && search.get('page') === 'restaurant' && search.get('token')) {
    return <Navigate to={{ pathname: `/restaurant/reserve/${encodeURIComponent(search.get('token')!)}`, search: location.search }} replace />;
  }

  if (location.pathname === '/' && search.get('page') === 'restaurant-menu') {
    return <Navigate to={{ pathname: '/restaurant/menu', search: location.search }} replace />;
  }

  const action = liffActionFromUrl(`https://liff.line.me/entry/${location.search}`);
  if (location.pathname === '/' && action) {
    const pathname = action.kind === 'visit_stamp' ? '/visit-stamps'
      : action.kind === 'form' ? `/forms/${encodeURIComponent(action.formId)}`
      : action.kind === 'booking_history' ? '/booking/history' : '/booking';
    return <Navigate to={{ pathname, search: location.search }} replace />;
  }

  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/booking" element={<CustomerBookingEntry><Booking /></CustomerBookingEntry>} />
        <Route path="/booking/history" element={<BookingHistory />} />
        <Route path="/mypage" element={<MyPage />} />
        <Route path="/events" element={<EventCatalog />} />
        <Route path="/events/me" element={<EventBookings />} />
        <Route path="/events/:id/confirm" element={<EventConfirm />} />
        <Route path="/events/:id/done" element={<EventDone />} />
        <Route path="/events/:id" element={<Event />} />
        <Route path="/affiliate" element={<Affiliate />} />
        <Route path="/visit-stamps/qr" element={<VisitStampQr />} />
        <Route path="/visit-stamps" element={<VisitStamps />} />
        <Route path="/webinar/:slug" element={<Webinar />} />
        <Route path="/research/:id" element={<Research />} />
        <Route path="/files/:id" element={<FileOpen />} />
        <Route path="/files" element={<FileOpen />} />
        <Route path="/statements/:id" element={<StatementOpen />} />
        <Route path="/statements" element={<StatementOpen />} />
        <Route path="/forms/:id" element={<Form />} />
        <Route path="/information/:id" element={<Form readOnlyDocument />} />
        <Route path="/restaurant/reserve/:token" element={<SeatReserve />} />
        <Route path="/restaurant/menu" element={<RestaurantMenu />} />
        <Route path="/" element={<Navigate to={{ pathname: style === 'ec' ? '/mypage' : style === 'lesson' ? '/events/me' : '/booking', search: location.search }} replace />} />
        {/* どの住所にも当たらないとき（板 aLU3r）。 */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
