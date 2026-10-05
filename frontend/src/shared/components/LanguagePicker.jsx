import React, { useState } from "react";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { LANGUAGE_OPTIONS } from "@shared/constants/languages";
import { setPushLanguage } from "@shared/services/pushLanguageApi";

/**
 * Pick the language for push notifications. Saves to the server, so the
 * choice applies to every device the account signs in on.
 */
const LanguagePicker = ({ open, value, onClose, onChange }) => {
  const [saving, setSaving] = useState(null);

  if (!open) return null;

  const choose = async (code) => {
    if (code === value) {
      onClose();
      return;
    }
    setSaving(code);
    try {
      const saved = await setPushLanguage(code);
      onChange(saved);
      toast.success("Notification language updated");
      onClose();
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save the language");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md max-h-[80vh] flex flex-col rounded-3xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h3 className="font-black text-slate-900">Notification language</h3>
            <p className="text-xs text-slate-500">Alerts will be sent in the language you choose.</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-full hover:bg-slate-100" aria-label="Close">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <ul className="overflow-y-auto divide-y divide-slate-100">
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = option.code === value;
            return (
              <li key={option.code}>
                <button
                  type="button"
                  disabled={saving !== null}
                  onClick={() => choose(option.code)}
                  className="w-full px-6 py-3.5 flex items-center justify-between hover:bg-slate-50 disabled:opacity-60"
                >
                  <span className="text-left">
                    <span className="block font-bold text-slate-800">{option.native}</span>
                    <span className="block text-xs text-slate-500">{option.name}</span>
                  </span>
                  {saving === option.code ? (
                    <span className="text-xs text-slate-400">Saving…</span>
                  ) : selected ? (
                    <Check size={18} className="text-primary" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

export default LanguagePicker;
