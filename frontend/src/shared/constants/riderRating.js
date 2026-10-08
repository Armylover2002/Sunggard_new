/**
 * Labels for rider ratings, shared by the customer popup, the rider's own
 * ratings card and the admin ratings view — so a tag reads the same
 * everywhere. The keys match the backend's RIDER_RATING_TAGS.
 */

export const RIDER_RATING_TAG_LABELS = {
  polite: "Polite",
  on_time: "On time",
  careful_with_parcel: "Careful with parcel",
  good_communication: "Good communication",
  late: "Late",
  rude: "Rude",
  careless_handling: "Careless handling",
  poor_communication: "Poor communication",
};

/** Offered after a good rating (4-5 stars). */
export const POSITIVE_RIDER_TAGS = ["polite", "on_time", "careful_with_parcel", "good_communication"];
/** Offered after a poor rating (1-3 stars). */
export const NEGATIVE_RIDER_TAGS = ["late", "rude", "careless_handling", "poor_communication"];

export const RIDER_STAR_WORDS = ["", "Poor", "Fair", "Good", "Very good", "Excellent"];

export const riderTagLabel = (tag) => RIDER_RATING_TAG_LABELS[tag] || tag;
