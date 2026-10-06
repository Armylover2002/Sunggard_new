/**
 * Countdown fields for a rider job offer.
 *
 * Used for both the FCM push data and the `parcel:broadcast` socket body, so
 * the native overlay card and the in-app dialog always show the same time for
 * the same offer. Computed per call, from the round's own searchExpiresAt, so
 * a retry round gets its fresh window rather than a stale one.
 *
 * `timeoutSeconds` is relative to `now` (the emit moment) on purpose: the app
 * prefers a relative value because it does not depend on the phone's clock.
 */
export function offerDeadlineFields(payload = {}, now = Date.now()) {
  const expiresAt = payload.deliverySearchExpiresAt || payload.searchExpiresAt;
  const deadline = expiresAt ? new Date(expiresAt) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) {
    return { acceptanceDeadlineAt: undefined, timeoutSeconds: undefined };
  }
  return {
    acceptanceDeadlineAt: deadline.toISOString(),
    timeoutSeconds: Math.max(0, Math.round((deadline.getTime() - now) / 1000)),
  };
}
