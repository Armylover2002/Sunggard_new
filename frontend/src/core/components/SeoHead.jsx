import { useEffect, useRef } from 'react';
import { useSettings } from '@core/context/SettingsContext';

/**
 * Updates document title, favicon, and meta description/keywords from global settings.
 * Must be rendered inside SettingsProvider.
 */
export default function SeoHead() {
    const { settings } = useSettings();
    const metaRefs = useRef({ description: null, keywords: null, favicon: null });

    useEffect(() => {
        if (!settings) return;

        const title = settings.metaTitle || settings.appName || 'App';
        document.title = title;

        const desc = settings.metaDescription || '';
        const keywordsContent = (Array.isArray(settings.keywords) && settings.keywords.length)
            ? settings.keywords.join(', ')
            : (settings.metaKeywords || '');

        // Update or create meta description
        let metaDesc = metaRefs.current.description;
        if (!metaDesc) {
            metaDesc = document.querySelector('meta[name="description"]');
            if (!metaDesc) {
                metaDesc = document.createElement('meta');
                metaDesc.setAttribute('name', 'description');
                document.head.appendChild(metaDesc);
            }
            metaRefs.current.description = metaDesc;
        }
        metaDesc.setAttribute('content', desc);

        // Update or create meta keywords
        let metaKw = metaRefs.current.keywords;
        if (!metaKw) {
            metaKw = document.querySelector('meta[name="keywords"]');
            if (!metaKw) {
                metaKw = document.createElement('meta');
                metaKw.setAttribute('name', 'keywords');
                document.head.appendChild(metaKw);
            }
            metaRefs.current.keywords = metaKw;
        }
        metaKw.setAttribute('content', keywordsContent);

        // Favicon: the admin-set favicon (falling back to the logo). Any other
        // icon link is removed first — browsers use the FIRST one, so the old
        // static <link rel="icon"> in index.html would otherwise win.
        const iconUrl = settings.faviconUrl || settings.logoUrl || '';
        if (iconUrl) {
            document
                .querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
                .forEach((el) => { if (el.id !== 'dynamic-favicon' && el.id !== 'dynamic-apple-icon') el.remove(); });
            const ensure = (id, rel) => {
                let el = document.getElementById(id);
                if (!el) { el = document.createElement('link'); el.id = id; el.rel = rel; document.head.appendChild(el); }
                if (el.href !== iconUrl) el.href = iconUrl;
            };
            ensure('dynamic-favicon', 'icon');
            ensure('dynamic-apple-icon', 'apple-touch-icon');
            try { localStorage.setItem('cg:favicon', iconUrl); } catch { /* private mode */ }
        }
    }, [settings]);

    return null;
}
