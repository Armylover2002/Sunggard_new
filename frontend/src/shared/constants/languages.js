// Languages a customer or delivery partner can choose for push notifications.
// Codes must match backend/app/modules/notifications/notification.i18n.js.
export const LANGUAGE_OPTIONS = Object.freeze([
  { code: "en", name: "English", native: "English" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી" },
  { code: "mr", name: "Marathi", native: "मराठी" },
  { code: "bn", name: "Bengali", native: "বাংলা" },
  { code: "ta", name: "Tamil", native: "தமிழ்" },
  { code: "te", name: "Telugu", native: "తెలుగు" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ml", name: "Malayalam", native: "മലയാളം" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "or", name: "Odia", native: "ଓଡ଼ିଆ" },
  { code: "as", name: "Assamese", native: "অসমীয়া" },
  { code: "ur", name: "Urdu", native: "اردو" },
  { code: "kok", name: "Konkani", native: "कोंकणी" },
  { code: "ne", name: "Nepali", native: "नेपाली" },
  { code: "sa", name: "Sanskrit", native: "संस्कृतम्" },
  { code: "ks", name: "Kashmiri", native: "कॉशुर" },
  { code: "mai", name: "Maithili", native: "मैथिली" },
  { code: "mni", name: "Manipuri", native: "ꯃꯤꯇꯩ ꯂꯣꯟ" },
  { code: "brx", name: "Bodo", native: "बड़ो" },
  { code: "sat", name: "Santali", native: "ᱥᱟᱱᱛᱟᱲᱤ" },
  { code: "sd", name: "Sindhi", native: "سنڌي" },
  { code: "doi", name: "Dogri", native: "डोगरी" },
]);

export const DEFAULT_LANGUAGE_CODE = "en";

/** Name shown in a settings row, e.g. "हिन्दी (Hindi)". */
export const languageLabel = (code) => {
  const option = LANGUAGE_OPTIONS.find((item) => item.code === code) || LANGUAGE_OPTIONS[0];
  return option.code === "en" ? "English" : `${option.native} (${option.name})`;
};
