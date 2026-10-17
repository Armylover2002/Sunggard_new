/** Default fallbacks when settings are not yet loaded or API fails */
export const DEFAULT_SETTINGS = {
  appName: "App",
  supportEmail: "",
  supportPhone: "",
  currencySymbol: "\u20B9",
  currencyCode: "INR",
  timezone: "Asia/Kolkata",
  logoUrl: "",
  faviconUrl: "",
  primaryColor: "var(--primary)",
  companyName: "",
  taxId: "",
  address: "",
  facebook: "",
  twitter: "",
  instagram: "",
  linkedin: "",
  youtube: "",
  playStoreLink: "",
  appStoreLink: "",
  metaTitle: "",
  metaDescription: "",
  metaKeywords: "",
  keywords: [],
  returnDeliveryCommission: 0,
  deliveryPricingMode: "distance_based",
  pricingMode: "distance_based",
  customerBaseDeliveryFee: 30,
  riderBasePayout: 30,
  baseDeliveryCharge: 30,
  baseDistanceCapacityKm: 0.5,
  incrementalKmSurcharge: 10,
  deliveryPartnerRatePerKm: 5,
  fleetCommissionRatePerKm: 5,
  fixedDeliveryFee: 30,
  handlingFeeStrategy: "highest_category_fee",
  codEnabled: true,
  onlineEnabled: true,
  lowStockAlertsEnabled: true,
  productApproval: {
    sellerCreateRequiresApproval: false,
    sellerEditRequiresApproval: false,
  },
  legalContent: {
    customerPrivacyPolicy: "",
    customerTerms: "",
    customerAboutUs: "",
    deliveryPrivacyPolicy: "",
    deliveryTerms: "",
    deliveryAboutUs: "",
  },
};

/**
 * Applies theme CSS variables to document root from settings.
 */
export function applyThemeVariables(settings) {
  if (!settings) return;
  const root = document.documentElement;
  const primary = settings.primaryColor;

  if (primary && primary !== "var(--primary)" && primary.trim() !== "") {
    root.style.setProperty("--primary", primary);
    root.style.setProperty("--primary-color", primary);

    if (primary.startsWith("#")) {
      const hex = primary.replace("#", "");
      if (hex.length === 6) {
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        const yiq = (r * 299 + g * 587 + b * 114) / 1000;
        const contrastColor = yiq >= 160 ? "#000000" : "#FFFFFF";
        root.style.setProperty("--primary-foreground", contrastColor);
      }
    }
  }
}

