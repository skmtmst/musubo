export type View = 'pick' | 'course' | 'confirm' | 'done' | 'mine';
export type Course = import('@line-crm/shared').RestaurantCustomerCourse;
export type Store = { id: string; name: string; timezone: string; reservationForm?:import('@line-crm/shared').RestaurantReservationFormSettings };

export type DaySlots = import('@line-crm/shared').RestaurantCustomerSlot[] | 'loading' | 'error' | 'closed';
