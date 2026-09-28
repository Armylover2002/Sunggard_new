import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, User, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocation as useAppLocation } from "../../context/LocationContext";
import { useSettings } from '@core/context/SettingsContext';

const Header = () => {
    const { settings } = useSettings();
    const location = useLocation();
    const isCheckoutPage = location.pathname === '/checkout';
    const { currentLocation, openLocationPicker, isFetchingLocation } = useAppLocation();
    const locationLabel = isFetchingLocation
        ? "Detecting location..."
        : (currentLocation?.name || "Select location");
    const locationTime = currentLocation?.time || "—";

    // Search placeholder animation
    const [searchPlaceholder, setSearchPlaceholder] = useState('Search ');
    const [typingState, setTypingState] = useState({
        textIndex: 0,
        charIndex: 0,
        isDeleting: false,
        isPaused: false
    });

    const staticText = "Search ";
    const typingPhrases = ['"bread"', '"milk"', '"chocolate"', '"eggs"', '"chips"'];

    React.useEffect(() => {
        const { textIndex, charIndex, isDeleting, isPaused } = typingState;
        const currentPhrase = typingPhrases[textIndex];

        if (isPaused) {
            const timeout = setTimeout(() => {
                setTypingState(prev => ({ ...prev, isPaused: false, isDeleting: true }));
            }, 2000); // Pause after full phrase
            return () => clearTimeout(timeout);
        }

        const timeout = setTimeout(() => {
            if (!isDeleting) {
                // Typing
                if (charIndex < currentPhrase.length) {
                    setSearchPlaceholder(staticText + currentPhrase.substring(0, charIndex + 1));
                    setTypingState(prev => ({ ...prev, charIndex: prev.charIndex + 1 }));
                } else {
                    // Finished typing
                    setTypingState(prev => ({ ...prev, isPaused: true }));
                }
            } else {
                // Deleting
                if (charIndex > 0) {
                    setSearchPlaceholder(staticText + currentPhrase.substring(0, charIndex - 1));
                    setTypingState(prev => ({ ...prev, charIndex: prev.charIndex - 1 }));
                } else {
                    // Finished deleting
                    setTypingState(prev => ({
                        ...prev,
                        isDeleting: false,
                        textIndex: (prev.textIndex + 1) % typingPhrases.length
                    }));
                }
            }
        }, isDeleting ? 50 : 100);

        return () => clearTimeout(timeout);
    }, [typingState]);

    return (
        <header className="absolute top-4 md:top-8 left-0 right-0 z-[200] px-4">
            <div className="container mx-auto max-w-6xl">
                {/* Mobile Top Row: Location & Profile */}
                <div className="md:hidden flex items-center justify-between mb-4 px-2 animate-in slide-in-from-top duration-500">
                    <button
                        type="button"
                        data-lenis-prevent
                        data-lenis-prevent-touch
                        onClick={openLocationPicker}
                        className="flex items-center gap-3 cursor-pointer active:scale-95 transition-transform border-0 bg-transparent p-0 text-left"
                    >
                        <div className="h-10 w-10 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center border border-white/30 shadow-sm">
                            <MapPin size={22} className="text-white fill-current" />
                        </div>
                        <div className="flex flex-col leading-tight">
                            <span className="text-[10px] font-black text-white/80 uppercase tracking-widest flex items-center gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                                {locationTime}
                            </span>
                            <div className="flex items-center gap-1 font-black text-white text-base">
                                <span className="max-w-[150px] truncate">{locationLabel}</span> <span className="text-[10px] opacity-70">▼</span>
                            </div>
                        </div>
                    </button>
                </div>

                {/* Main Header Capsule */}
                <div className="px-4 md:px-8 h-18 bg-white/95 backdrop-blur-sm rounded-full shadow-2xl flex items-center justify-between border border-white/20">
                    {/* Logo */}
                    <div className="flex items-center gap-6 mr-4 md:mr-12">
                        <Link to="/" className="flex items-center gap-1">
                            <span className="text-2xl md:text-3xl font-black tracking-tight" style={{ color: settings?.primaryColor || 'var(--primary)' }}>{settings?.appName || 'App'}</span>
                        </Link>

                        {/* Location Selector (Desktop ONLY) */}
                        <button
                            type="button"
                            data-lenis-prevent
                            data-lenis-prevent-touch
                            onClick={openLocationPicker}
                            className="hidden md:flex items-center gap-2 pl-6 border-l border-slate-200 cursor-pointer active:scale-95 transition-transform border-0 bg-transparent p-0"
                        >
                            <div className="flex flex-col items-start leading-none group">
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5 group-hover:text-[var(--primary)] transition-colors">
                                    Delivery in {locationTime}
                                </span>
                                <div className="flex items-center gap-1 font-bold text-slate-700 text-sm group-hover:text-[var(--primary)] transition-colors">
                                    <span className="max-w-[150px] truncate">{locationLabel}</span> <MapPin size={14} className="fill-current" />
                                </div>
                            </div>
                        </button>
                    </div>

                    {/* Desktop Navigation */}
                    <nav className="hidden md:flex items-center gap-6">
                        <Link to="/parcel" className="text-sm font-semibold transition-colors hover:text-[var(--primary)] text-slate-700">Book Parcel</Link>
                        <Link to="/profile/parcel-history" className="text-sm font-semibold transition-colors hover:text-[var(--primary)] text-slate-700">Parcel History</Link>
                        {/* QUICK COMMERCE DISABLED
                        <Link to="/" className="text-sm font-medium transition-colors hover:text-[var(--primary)]">Home</Link>
                        <Link to="/categories" className="text-sm font-medium transition-colors hover:text-[var(--primary)]">Categories</Link>
                        <Link to="/offers" className="text-sm font-medium transition-colors hover:text-[var(--primary)]">Offers</Link>
                        */}
                    </nav>

                    {/* QUICK COMMERCE DISABLED — Search Bar
                    {!isCheckoutPage && (
                        <div className="flex-1 flex items-center max-w-sm ml-4 md:ml-8 mr-4 md:mr-8">
                            <div className="relative w-full">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                                <input
                                    type="search"
                                    placeholder={searchPlaceholder}
                                    className="w-full rounded-full border-none bg-slate-100/50 md:bg-white md:border md:border-slate-200 pl-10 pr-4 py-2.5 text-sm focus:ring-2 focus:ring-primary transition-all outline-none"
                                />
                            </div>
                        </div>
                    )}
                    */}

                    {/* Desktop Right Icons */}
                    <div className="hidden md:flex items-center gap-4">
                        <Link to="/profile" className="flex items-center justify-center p-2 hover:bg-slate-100 rounded-full transition-colors">
                            <User className="h-6 w-6 text-slate-600 hover:text-[var(--primary)] transition-colors" />
                        </Link>
                    </div>
                </div>
            </div>
        </header>
    );
};

export default Header;

