import React from 'react';
import { Mail, Phone, LifeBuoy } from 'lucide-react';
import { useSettings } from '@core/context/SettingsContext';

/**
 * Public support page for delivery partners — no login needed, so app-store
 * listings can link to it. Contact details come from Admin → Settings.
 * (The signed-in help desk with tickets/chat is /delivery/profile/help-support.)
 */
const DeliverySupportPage = ({ audience = 'Delivery Partner' }) => {
    const { settings } = useSettings();
    const appName = settings?.appName || 'CourierGo';
    const email = settings?.supportEmail || '';
    const phone = settings?.supportPhone || '';

    return (
        <div className="min-h-screen bg-slate-50 font-sans pb-10">
            <div className="bg-white px-4 py-4 shadow-sm">
                <h1 className="text-lg font-black text-slate-800 max-w-3xl mx-auto">Support</h1>
            </div>
            <div className="p-5 max-w-3xl mx-auto space-y-4">
                <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
                    <div className="flex items-center gap-4 mb-4">
                        <div className="h-12 w-12 rounded-2xl bg-amber-50 flex items-center justify-center text-amber-600">
                            <LifeBuoy size={24} />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-800">{appName} {audience} Support</h2>
                            <p className="text-xs text-slate-500 font-medium">Questions about your bookings, payments or account</p>
                        </div>
                    </div>
                    <div className="space-y-3">
                        {email && (
                            <a href={`mailto:${email}`} className="flex items-center gap-3 text-slate-700 font-semibold">
                                <Mail size={18} className="text-slate-400" /> {email}
                            </a>
                        )}
                        {phone && (
                            <a href={`tel:${phone}`} className="flex items-center gap-3 text-slate-700 font-semibold">
                                <Phone size={18} className="text-slate-400" /> {phone}
                            </a>
                        )}
                        {!email && !phone && (
                            <p className="text-sm text-slate-500">Support contact details are not available right now.</p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DeliverySupportPage;
