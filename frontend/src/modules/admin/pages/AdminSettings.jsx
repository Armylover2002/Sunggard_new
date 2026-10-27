import React, { useEffect, useRef, useState } from 'react';
import Card from '@shared/components/ui/Card';
import PageHeader from '@shared/components/ui/PageHeader';
import {
    Save,
    Settings,
    Globe,
    Upload,
    Mail,
    Phone,
    Loader2,
    X,
    FileText,
    Shield,
    Info,
    Users,
    Truck,
    Eye,
    AlignLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@shared/components/ui/Toast';
import { adminApi } from '../services/adminApi';
import { useSettings } from '@core/context/SettingsContext';

/* ─────────────────────────────────────────────────────────────────────────
   Helpers: convert structured data ↔ HTML string
   ───────────────────────────────────────────────────────────────────────── */

/** Parse stored HTML → { intro, sections[] } so the form can show existing content */
const parseHtmlToStructured = (html) => {
    if (!html || !html.trim()) return { intro: '', sections: [] };
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const nodes = Array.from(doc.body.children);
        let intro = '';
        const sections = [];
        let current = null;
        for (const el of nodes) {
            const tag = el.tagName.toUpperCase();
            if (tag === 'H2' || tag === 'H3') {
                if (current) sections.push(current);
                current = { title: el.textContent.trim(), body: '' };
            } else if (tag === 'P' || tag === 'DIV') {
                const text = el.textContent.trim();
                if (!text) continue;
                if (current) {
                    current.body = current.body ? `${current.body}\n\n${text}` : text;
                } else {
                    intro = intro ? `${intro}\n\n${text}` : text;
                }
            } else if (tag === 'UL' || tag === 'OL') {
                const items = Array.from(el.querySelectorAll('li')).map(li => `• ${li.textContent.trim()}`).join('\n');
                if (current) current.body = current.body ? `${current.body}\n${items}` : items;
                else intro = intro ? `${intro}\n${items}` : items;
            }
        }
        if (current) sections.push(current);
        return { intro, sections };
    } catch {
        return { intro: html, sections: [] };
    }
};

/** Convert { intro, sections[] } → clean HTML string for storage / display */
const structuredToHtml = ({ intro, sections }) => {
    let html = '';
    if (intro?.trim()) {
        intro.trim().split(/\n\n+/).forEach(para => {
            if (para.trim()) html += `<p>${para.trim().replace(/\n/g, '<br/>')}</p>`;
        });
    }
    sections.forEach(({ title, body }) => {
        if (title?.trim()) html += `<h3>${title.trim()}</h3>`;
        if (body?.trim()) {
            body.trim().split(/\n\n+/).forEach(para => {
                if (para.trim()) html += `<p>${para.trim().replace(/\n/g, '<br/>')}</p>`;
            });
        }
    });
    return html;
};

/* ─────────────────────────────────────────────────────────────────────────
   Structured Content Editor — replaces the old HTML toolbar editor
   ───────────────────────────────────────────────────────────────────────── */

const StructuredEditor = ({ value, onChange, docLabel }) => {
    // Initialize from stored HTML (remounts on key change so useState is safe here)
    const [data, setData] = useState(() => parseHtmlToStructured(value || ''));

    const push = (newData) => {
        setData(newData);
        onChange(structuredToHtml(newData));
    };

    const setIntro = (text) => push({ ...data, intro: text });

    const updateSection = (idx, field, val) => {
        const updated = data.sections.map((s, i) => i === idx ? { ...s, [field]: val } : s);
        push({ ...data, sections: updated });
    };

    const addSection = () =>
        push({ ...data, sections: [...data.sections, { title: '', body: '' }] });

    const removeSection = (idx) =>
        push({ ...data, sections: data.sections.filter((_, i) => i !== idx) });

    const moveSection = (from, to) => {
        if (to < 0 || to >= data.sections.length) return;
        const arr = [...data.sections];
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        push({ ...data, sections: arr });
    };

    return (
        <div className="space-y-4">
            {/* Intro paragraph */}
            <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                    <AlignLeft className="h-3.5 w-3.5" />
                    Introduction / Opening Paragraph
                </label>
                <textarea
                    value={data.intro}
                    onChange={(e) => setIntro(e.target.value)}
                    rows={3}
                    placeholder={`Opening paragraph for ${docLabel}…`}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-700 outline-none focus:ring-2 focus:ring-brand-500/20 resize-none placeholder:text-slate-300 leading-relaxed"
                />
            </div>

            {/* Sections */}
            {data.sections.length > 0 && (
                <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5" />
                        Sections
                    </label>
                    {data.sections.map((sec, idx) => (
                        <div
                            key={idx}
                            className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm"
                        >
                            {/* Section header bar */}
                            <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                                <span className="h-6 w-6 rounded-lg bg-slate-200 text-slate-700 text-xs font-black flex items-center justify-center flex-shrink-0">
                                    {idx + 1}
                                </span>
                                <input
                                    type="text"
                                    value={sec.title}
                                    onChange={(e) => updateSection(idx, 'title', e.target.value)}
                                    placeholder={`Section ${idx + 1} heading…`}
                                    className="flex-1 bg-transparent text-sm font-bold text-slate-800 outline-none placeholder:text-slate-300"
                                />
                                {/* Move up / down */}
                                <div className="flex items-center gap-1 ml-auto">
                                    <button
                                        type="button"
                                        onClick={() => moveSection(idx, idx - 1)}
                                        disabled={idx === 0}
                                        className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-all disabled:opacity-30"
                                        title="Move up"
                                    >
                                        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l5 5H3z"/></svg>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => moveSection(idx, idx + 1)}
                                        disabled={idx === data.sections.length - 1}
                                        className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-all disabled:opacity-30"
                                        title="Move down"
                                    >
                                        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M8 13L3 8h10z"/></svg>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => removeSection(idx)}
                                        className="p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all ml-1"
                                        title="Remove section"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                            {/* Body textarea */}
                            <textarea
                                value={sec.body}
                                onChange={(e) => updateSection(idx, 'body', e.target.value)}
                                rows={4}
                                placeholder="Section content… (press Enter twice for a new paragraph)"
                                className="w-full px-4 py-3 text-sm text-slate-600 bg-white outline-none resize-none placeholder:text-slate-300 leading-relaxed"
                            />
                        </div>
                    ))}
                </div>
            )}

            {/* Add Section button */}
            <button
                type="button"
                onClick={addSection}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border-2 border-dashed border-slate-200 text-slate-400 hover:border-brand-400 hover:text-brand-600 hover:bg-brand-50/20 transition-all text-sm font-semibold"
            >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z"/></svg>
                Add Section
            </button>
        </div>
    );
};

/* ─────────────────────────────────────────────────────────────────────────
   Live Preview (reads the generated HTML)
   ───────────────────────────────────────────────────────────────────────── */
const ContentPreview = ({ html }) => (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden h-full">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 bg-slate-50">
            <Eye className="h-4 w-4 text-slate-400" />
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Preview</span>
        </div>
        <div
            className="p-5 overflow-y-auto max-h-[420px] prose prose-slate prose-sm max-w-none text-slate-600 [&_h3]:text-slate-800 [&_h3]:font-bold [&_h3]:mt-5 [&_h3]:mb-2 [&_p]:leading-relaxed [&_p]:text-slate-500"
            dangerouslySetInnerHTML={{
                __html: html || '<p class="text-slate-300 italic text-sm">Start filling in the form to see the preview…</p>'
            }}
        />
    </div>
);

/* ─────────────────────────────────────────────────────────────────────────
   Legal Content Tab
   ───────────────────────────────────────────────────────────────────────── */

const AUDIENCE_TABS = [
    { id: 'customer',  label: 'Customer (User)',  icon: Users, color: 'indigo' },
    { id: 'delivery',  label: 'Delivery Boy',     icon: Truck, color: 'amber' },
];

const DOCUMENT_TABS = [
    { id: 'privacy', label: 'Privacy Policy',    icon: Shield,   fieldKey: (aud) => `${aud}PrivacyPolicy` },
    { id: 'terms',   label: 'Terms & Conditions', icon: FileText, fieldKey: (aud) => `${aud}Terms`          },
    { id: 'about',   label: 'About Us',           icon: Info,     fieldKey: (aud) => `${aud}AboutUs`        },
];

const audienceLabel = (id) => id === 'customer' ? 'customer' : 'delivery';

const LegalContentTab = ({ legalContent, onChange }) => {
    const [audience, setAudience]   = useState('customer');
    const [docTab, setDocTab]       = useState('privacy');

    const currentDoc = DOCUMENT_TABS.find(d => d.id === docTab);
    const fieldKey = currentDoc?.fieldKey(audienceLabel(audience));
    const currentValue = legalContent?.[fieldKey] || '';

    const handleChange = (html) => {
        onChange({ ...legalContent, [fieldKey]: html });
    };

    const docLabel = `${currentDoc?.label} (${AUDIENCE_TABS.find(a => a.id === audience)?.label})`;

    return (
        <div className="space-y-5">
            {/* Audience toggle */}
            <div className="flex gap-2 p-1 bg-slate-100 rounded-2xl w-fit">
                {AUDIENCE_TABS.map(({ id, label, icon: Icon, color }) => (
                    <button
                        key={id}
                        onClick={() => setAudience(id)}
                        className={cn(
                            'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all',
                            audience === id
                                ? 'bg-white shadow-sm text-slate-900'
                                : 'text-slate-500 hover:text-slate-700'
                        )}
                    >
                        <Icon className={cn('h-4 w-4', audience === id && (color === 'indigo' ? 'text-orange-500' : 'text-amber-500'))} />
                        {label}
                    </button>
                ))}
            </div>

            {/* Document sub-tabs */}
            <div className="flex gap-1 border-b border-slate-100">
                {DOCUMENT_TABS.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setDocTab(id)}
                        className={cn(
                            'flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all -mb-px',
                            docTab === id
                                ? 'border-slate-900 text-slate-900'
                                : 'border-transparent text-slate-400 hover:text-slate-700'
                        )}
                    >
                        <Icon className="h-4 w-4" />
                        {label}
                    </button>
                ))}
            </div>

            {/* Context breadcrumb */}
            <div className="flex items-center gap-2">
                <span className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold',
                    audience === 'customer'
                        ? 'bg-orange-50 text-orange-700 ring-1 ring-orange-200'
                        : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                )}>
                    {audience === 'customer' ? <Users className="h-3 w-3" /> : <Truck className="h-3 w-3" />}
                    {AUDIENCE_TABS.find(a => a.id === audience)?.label}
                </span>
                <span className="text-slate-300">›</span>
                <span className="text-xs font-bold text-slate-600">
                    {currentDoc?.label}
                </span>
            </div>

            {/* Editor + Preview — side by side */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
                <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Write Content</label>
                    <StructuredEditor
                        key={`${audience}-${docTab}`}
                        value={currentValue}
                        onChange={handleChange}
                        docLabel={docLabel}
                    />
                </div>
                <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Preview</label>
                    <ContentPreview html={currentValue} />
                </div>
            </div>

            <p className="text-xs text-slate-400 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 flex-shrink-0" />
                Leave all fields empty to use the built-in default content. Changes take effect after clicking <strong>Save All Changes</strong>.
            </p>
        </div>
    );
};


/* ─────────────────────────────────────────────────────────────────────────
   Main AdminSettings Component
   ───────────────────────────────────────────────────────────────────────── */

const DEFAULT_LEGAL_CONTENT = {
    customerPrivacyPolicy: '',
    customerTerms:         '',
    customerAboutUs:       '',
    deliveryPrivacyPolicy: '',
    deliveryTerms:         '',
    deliveryAboutUs:       '',
};

const AdminSettings = () => {
    const normalizeProductApprovalConfig = (raw) => {
        const config = raw?.productApproval || raw || {};
        return {
            sellerCreateRequiresApproval: Boolean(config.sellerCreateRequiresApproval),
            sellerEditRequiresApproval: Boolean(config.sellerEditRequiresApproval),
        };
    };

    const normalizeLegalContent = (raw) => {
        const lc = raw?.legalContent || {};
        return {
            customerPrivacyPolicy: lc.customerPrivacyPolicy || '',
            customerTerms:         lc.customerTerms         || '',
            customerAboutUs:       lc.customerAboutUs        || '',
            deliveryPrivacyPolicy: lc.deliveryPrivacyPolicy || '',
            deliveryTerms:         lc.deliveryTerms          || '',
            deliveryAboutUs:       lc.deliveryAboutUs        || '',
        };
    };

    const { refetch } = useSettings();
    const { showToast } = useToast();
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('general');
    const [logoUploading, setLogoUploading] = useState(false);
    const [faviconUploading, setFaviconUploading] = useState(false);
    const logoInputRef = useRef(null);
    const faviconInputRef = useRef(null);

    const [settings, setSettings] = useState({
        appName: '',
        supportEmail: '',
        supportPhone: '',
        currencySymbol: '₹',
        currencyCode: 'INR',
        timezone: 'Asia/Kolkata',
        logoUrl: '',
        faviconUrl: '',
        primaryColor: 'var(--primary)',
        msg91AuthKey: '',
        msg91TemplateId: '',
        companyName: '',
        taxId: '',
        address: '',
        facebook: '',
        twitter: '',
        instagram: '',
        linkedin: '',
        youtube: '',
        playStoreLink: '',
        appStoreLink: '',
        metaTitle: '',
        metaDescription: '',
        metaKeywords: '',
        keywords: [],
        returnDeliveryCommission: 0,
        lowStockAlertsEnabled: true,
        productApproval: {
            sellerCreateRequiresApproval: false,
            sellerEditRequiresApproval: false,
        },
        legalContent: { ...DEFAULT_LEGAL_CONTENT },
    });

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const res = await adminApi.getSettings();
                const data = res.data?.result ?? res.data;
                if (data) {
                    setSettings(prev => ({
                        ...prev,
                        ...data,
                        productApproval: normalizeProductApprovalConfig(data || {}),
                        legalContent: normalizeLegalContent(data),
                        keywords: Array.isArray(data.keywords) ? data.keywords : (data.metaKeywords ? data.metaKeywords.split(',').map(k => k.trim()).filter(Boolean) : []),
                        returnDeliveryCommission: data.returnDeliveryCommission ?? 0,
                    }));
                }
            } catch (error) {
                console.error("Failed to load settings", error);
                showToast('Failed to load settings', 'error');
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    }, [showToast]);

    const handleSave = async () => {
        try {
            setIsSaving(true);
            const payload = {
                ...settings,
                keywords: Array.isArray(settings.keywords) ? settings.keywords : (settings.metaKeywords ? settings.metaKeywords.split(',').map(k => k.trim()).filter(Boolean) : []),
            };
            const res = await adminApi.updateSettings(payload);
            const updatedData = res.data?.result ?? res.data;

            if (updatedData) {
                setSettings(prev => ({
                    ...prev,
                    ...updatedData,
                    productApproval: normalizeProductApprovalConfig(updatedData),
                    legalContent: normalizeLegalContent(updatedData),
                }));
            }
            await refetch({ forceRefresh: true });
            showToast('Settings updated successfully', 'success');
        } catch (error) {
            console.error("Failed to update settings", error);
            showToast('Failed to update settings', 'error');
        } finally {
            setIsSaving(false);
        }
    };

    const handleInputChange = (field, value) => {
        setSettings(prev => ({ ...prev, [field]: value }));
    };

    const handleProductApprovalToggle = (field) => {
        setSettings((prev) => ({
            ...prev,
            productApproval: {
                ...(prev.productApproval || {}),
                [field]: !Boolean(prev.productApproval?.[field]),
            },
        }));
    };

    const handleLegalContentChange = (newLegal) => {
        setSettings(prev => ({ ...prev, legalContent: newLegal }));
    };

    const handleLogoUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('Please select an image file (PNG, JPG, etc.)', 'error');
            return;
        }
        setLogoUploading(true);
        try {
            const fd = new FormData();
            fd.append('image', file);
            const res = await adminApi.uploadSettingsImage(fd, 'logo');
            const url = res.data?.result?.url || res.data?.url;
            if (url) {
                handleInputChange('logoUrl', url);
                showToast('Logo uploaded. Click Save Changes to apply.', 'success');
            } else throw new Error('No URL returned');
        } catch (err) {
            console.error(err);
            showToast(err.response?.data?.message || 'Failed to upload logo', 'error');
        } finally {
            setLogoUploading(false);
            e.target.value = '';
        }
    };

    const handleFaviconUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('Please select an image file (PNG, ICO, etc.)', 'error');
            return;
        }
        setFaviconUploading(true);
        try {
            const fd = new FormData();
            fd.append('image', file);
            const res = await adminApi.uploadSettingsImage(fd, 'favicon');
            const url = res.data?.result?.url || res.data?.url;
            if (url) {
                handleInputChange('faviconUrl', url);
                showToast('Favicon uploaded. Click Save Changes to apply.', 'success');
            } else throw new Error('No URL returned');
        } catch (err) {
            console.error(err);
            showToast(err.response?.data?.message || 'Failed to upload favicon', 'error');
        } finally {
            setFaviconUploading(false);
            e.target.value = '';
        }
    };

    const tabs = [
        { id: 'general',  label: 'General',        icon: Settings  },
        { id: 'branding', label: 'Branding',        icon: Globe     },
        { id: 'sms',      label: 'SMS',             icon: Phone     },
        { id: 'legal',    label: 'Legal Content',   icon: FileText  },
    ];

    return (
        <div className="ds-section-spacing animate-in fade-in slide-in-from-bottom-4 duration-700 pb-12">
            {/* Header Section */}
            <PageHeader
                title="Platform Settings"
                description="Manage global configurations, branding, and legal information."
                badge={
                    <div className="p-2 bg-slate-100 rounded-xl">
                        <Settings className="h-5 w-5 text-slate-600" />
                    </div>
                }
                actions={
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className={cn(
                            "ds-btn ds-btn-lg bg-[color:var(--primary)] text-primary-foreground shadow-xl shadow-brand-200 hover:shadow-brand-300 active:shadow-inner",
                            isSaving ? "opacity-70 cursor-wait" : "hover:bg-brand-700"
                        )}
                    >
                        {isSaving ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                            <Save className="h-5 w-5" />
                        )}
                        {isSaving ? 'Updating...' : 'Save All Changes'}
                    </button>
                }
            />

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                {/* Sidebar Navigation */}
                <div className="lg:col-span-3 space-y-2">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all text-left",
                                activeTab === tab.id
                                    ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200 shadow-sm"
                                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                            )}
                        >
                            <tab.icon className={cn("h-4 w-4", activeTab === tab.id ? "text-brand-600" : "text-slate-400")} />
                            {tab.label}
                            {tab.id === 'legal' && (
                                <span className="ml-auto text-[9px] font-black bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-md uppercase tracking-wide">CMS</span>
                            )}
                        </button>
                    ))}
                </div>

                {/* Content Area */}
                <div className="lg:col-span-9 space-y-6">

                    {isLoading && (
                        <Card className="border-none shadow-xl ring-1 ring-slate-100 bg-white rounded-xl overflow-hidden">
                            <div className="p-8 flex items-center justify-center">
                                <div className="h-8 w-8 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" />
                            </div>
                        </Card>
                    )}

                    {/* General Settings */}
                    {!isLoading && activeTab === 'general' && (
                        <Card className="border-none shadow-xl ring-1 ring-slate-100 bg-white rounded-xl overflow-hidden">
                            <div className="p-6 border-b border-slate-50 bg-slate-50/30">
                                <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-3">
                                    General Information
                                </h3>
                            </div>
                            <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">App Name</label>
                                    <input
                                        type="text"
                                        value={settings.appName}
                                        onChange={(e) => handleInputChange('appName', e.target.value)}
                                        className="w-full px-5 py-4 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/10 transition-all"
                                    />
                                </div>
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Support Email</label>
                                    <div className="relative group">
                                        <Mail className="absolute left-5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                                        <input
                                            type="email"
                                            value={settings.supportEmail}
                                            onChange={(e) => handleInputChange('supportEmail', e.target.value)}
                                            className="w-full pl-12 pr-5 py-4 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/10 transition-all"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Support Phone</label>
                                    <div className="relative group">
                                        <Phone className="absolute left-5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                                        <input
                                            type="text"
                                            value={settings.supportPhone}
                                            onChange={(e) => handleInputChange('supportPhone', e.target.value)}
                                            className="w-full pl-12 pr-5 py-4 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/10 transition-all"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Currency Symbol</label>
                                    <input
                                        type="text"
                                        value={settings.currencySymbol}
                                        onChange={(e) => handleInputChange('currencySymbol', e.target.value)}
                                        className="w-full px-5 py-4 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/10 transition-all"
                                    />
                                </div>
                            </div>
                        </Card>
                    )}

                    {/* Branding Settings */}
                    {!isLoading && activeTab === 'branding' && (
                        <Card className="border-none shadow-xl ring-1 ring-slate-100 bg-white rounded-xl overflow-hidden">
                            <div className="p-6 border-b border-slate-50 bg-slate-50/30">
                                <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-3">
                                    Visual Identity
                                </h3>
                            </div>
                            <div className="p-8 space-y-8">
                                <input type="file" ref={logoInputRef} accept="image/*" className="hidden" onChange={handleLogoUpload} />
                                <input type="file" ref={faviconInputRef} accept="image/*" className="hidden" onChange={handleFaviconUpload} />
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-3">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">App Logo</label>
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => !logoUploading && logoInputRef.current?.click()}
                                            onKeyDown={(e) => e.key === 'Enter' && !logoUploading && logoInputRef.current?.click()}
                                            className={cn(
                                                "h-40 w-full rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-all group overflow-hidden",
                                                settings.logoUrl ? "border-slate-200 bg-slate-50/50" : "border-slate-200 hover:border-brand-500/50 hover:bg-brand-50/10 cursor-pointer"
                                            )}
                                        >
                                            {logoUploading ? (
                                                <Loader2 className="h-10 w-10 text-brand-600 animate-spin" />
                                            ) : settings.logoUrl ? (
                                                <>
                                                    <img src={settings.logoUrl} alt="App logo" className="max-h-24 w-auto object-contain" />
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs font-bold text-slate-500">Click to replace</span>
                                                        <button type="button" onClick={(e) => { e.stopPropagation(); handleInputChange('logoUrl', ''); }} className="p-1 rounded hover:bg-red-100 text-slate-400 hover:text-red-600" title="Remove logo"><X className="h-4 w-4" /></button>
                                                    </div>
                                                </>
                                            ) : (
                                                <>
                                                    <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                                                        <Upload className="h-5 w-5 text-slate-400 group-hover:text-brand-600" />
                                                    </div>
                                                    <span className="text-xs font-bold text-slate-400 group-hover:text-brand-600">Click to upload logo</span>
                                                </>
                                            )}
                                        </div>
                                        <input type="url" value={settings.logoUrl} onChange={(e) => handleInputChange('logoUrl', e.target.value)} placeholder="Or paste logo URL" className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-brand-500/20" />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Favicon</label>
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => !faviconUploading && faviconInputRef.current?.click()}
                                            onKeyDown={(e) => e.key === 'Enter' && !faviconUploading && faviconInputRef.current?.click()}
                                            className={cn(
                                                "h-40 w-full rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-all group overflow-hidden",
                                                settings.faviconUrl ? "border-slate-200 bg-slate-50/50" : "border-slate-200 hover:border-brand-500/50 hover:bg-brand-50/10 cursor-pointer"
                                            )}
                                        >
                                            {faviconUploading ? (
                                                <Loader2 className="h-10 w-10 text-brand-600 animate-spin" />
                                            ) : settings.faviconUrl ? (
                                                <>
                                                    <img src={settings.faviconUrl} alt="Favicon" className="max-h-16 w-auto object-contain" />
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs font-bold text-slate-500">Click to replace</span>
                                                        <button type="button" onClick={(e) => { e.stopPropagation(); handleInputChange('faviconUrl', ''); }} className="p-1 rounded hover:bg-red-100 text-slate-400 hover:text-red-600" title="Remove favicon"><X className="h-4 w-4" /></button>
                                                    </div>
                                                </>
                                            ) : (
                                                <>
                                                    <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center group-hover:scale-110 transition-transform">
                                                        <Upload className="h-5 w-5 text-slate-400 group-hover:text-brand-600" />
                                                    </div>
                                                    <span className="text-xs font-bold text-slate-400 group-hover:text-brand-600">Click to upload favicon</span>
                                                </>
                                            )}
                                        </div>
                                        <input type="url" value={settings.faviconUrl} onChange={(e) => handleInputChange('faviconUrl', e.target.value)} placeholder="Or paste favicon URL" className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-brand-500/20" />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Primary Brand Color</label>
                                    <div className="flex items-center gap-4">
                                        <input
                                            type="color"
                                            value={settings.primaryColor}
                                            onChange={(e) => handleInputChange('primaryColor', e.target.value)}
                                            className="h-12 w-24 rounded-lg cursor-pointer bg-transparent"
                                        />
                                        <input
                                            type="text"
                                            value={settings.primaryColor}
                                            onChange={(e) => handleInputChange('primaryColor', e.target.value)}
                                            className="w-full px-5 py-3 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/10 transition-all font-mono"
                                        />
                                    </div>
                                </div>
                            </div>
                        </Card>
                    )}

                    {!isLoading && activeTab === 'sms' && (
                        <Card className="border-none shadow-xl ring-1 ring-slate-100 bg-white rounded-xl overflow-hidden">
                            <div className="p-6 border-b border-slate-50 bg-slate-50/30">
                                <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-3">
                                    SMS Provider (MSG91)
                                </h3>
                            </div>
                            <div className="p-8 space-y-8">
                                <p className="text-xs font-medium text-slate-500">
                                    Used to send OTPs over real SMS. Leave blank to keep OTP in mock mode (fixed 1234, no SMS sent).
                                </p>
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">MSG91 Auth Key</label>
                                    <input
                                        type="text"
                                        value={settings.msg91AuthKey}
                                        onChange={(e) => handleInputChange('msg91AuthKey', e.target.value)}
                                        placeholder="Auth key from MSG91 dashboard"
                                        className="w-full px-5 py-3 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/10 transition-all font-mono"
                                    />
                                </div>
                                <div className="space-y-3">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">DLT Template ID</label>
                                    <input
                                        type="text"
                                        value={settings.msg91TemplateId}
                                        onChange={(e) => handleInputChange('msg91TemplateId', e.target.value)}
                                        placeholder="DLT-approved OTP template ID"
                                        className="w-full px-5 py-3 bg-slate-50 border-none rounded-2xl text-sm font-bold text-slate-900 outline-none focus:ring-2 focus:ring-brand-500/10 transition-all font-mono"
                                    />
                                </div>
                            </div>
                        </Card>
                    )}

                    {/* Legal Content Tab */}
                    {!isLoading && activeTab === 'legal' && (
                        <Card className="border-none shadow-xl ring-1 ring-slate-100 bg-white rounded-xl overflow-hidden">
                            <div className="p-6 border-b border-slate-50 bg-slate-50/30">
                                <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-3">
                                    <FileText className="h-4 w-4 text-orange-500" />
                                    Legal &amp; Informational Content
                                    <span className="text-xs font-bold text-orange-600 bg-orange-50 px-2 py-1 rounded-lg normal-case tracking-normal">CMS</span>
                                </h3>
                                <p className="text-xs text-slate-500 mt-1">
                                    Manage Privacy Policy, Terms &amp; Conditions, and About Us separately for customers and delivery boys.
                                </p>
                            </div>
                            <div className="p-6">
                                <LegalContentTab
                                    legalContent={settings.legalContent}
                                    onChange={handleLegalContentChange}
                                />
                            </div>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AdminSettings;
