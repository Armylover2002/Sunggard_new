import { Home, Package, User, History } from 'lucide-react';

/**
 * The customer's destinations, in one place.
 *
 * BottomNav (mobile) and DesktopNav (md and up) are two presentations of this
 * same list — a floating lens bar on touch, a top bar on pointer — so adding a
 * destination here reaches both.
 */
export const navItems = [
    { label: 'Home', icon: Home, path: '/' },
    // LOCAL CITY PARCEL DISABLED — was '/parcel/local'; now lands on the hub,
    // which only offers outstation booking.
    { label: 'Courier', icon: Package, path: '/parcel' },
    { label: 'History', icon: History, path: '/profile/parcel-history' },
    { label: 'Profile', icon: User, path: '/profile' },
];

/** Which destination a pathname belongs to. Defaults to Parcel, the home step. */
export const getActiveIndex = (pathname) => {
    if (pathname === '/profile' || pathname.startsWith('/profile/edit')) return 3;
    if (pathname.startsWith('/profile/parcel-history')) return 2;
    if (pathname.startsWith('/parcel')) return 1;
    return 0;
};
