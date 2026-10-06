import { offerDeadlineFields } from "../app/services/offerDeadline.js";

const NOW = Date.parse("2026-10-06T08:00:00.000Z");

describe("offer countdown fields", () => {
  it("gives the ISO deadline and the seconds remaining at emit time", () => {
    const expires = new Date(NOW + 30_000);
    const r = offerDeadlineFields({ searchExpiresAt: expires }, NOW);

    expect(r.acceptanceDeadlineAt).toBe("2026-10-06T08:00:30.000Z");
    expect(r.timeoutSeconds).toBe(30);
  });

  it("prefers deliverySearchExpiresAt when both are present", () => {
    const r = offerDeadlineFields(
      { searchExpiresAt: new Date(NOW + 10_000), deliverySearchExpiresAt: new Date(NOW + 25_000) },
      NOW,
    );
    expect(r.timeoutSeconds).toBe(25);
  });

  it("a retry round gets its own fresh window, not the previous one", () => {
    const firstRound = offerDeadlineFields({ searchExpiresAt: new Date(NOW + 30_000) }, NOW);
    const retryNow = NOW + 45_000;
    const retryRound = offerDeadlineFields({ searchExpiresAt: new Date(retryNow + 30_000) }, retryNow);

    expect(firstRound.timeoutSeconds).toBe(30);
    expect(retryRound.timeoutSeconds).toBe(30);
    expect(retryRound.acceptanceDeadlineAt).not.toBe(firstRound.acceptanceDeadlineAt);
  });

  it("leaves both keys undefined when there is no deadline", () => {
    expect(offerDeadlineFields({}, NOW)).toEqual({
      acceptanceDeadlineAt: undefined,
      timeoutSeconds: undefined,
    });
  });

  it("clamps an already-expired deadline to zero rather than negative", () => {
    const r = offerDeadlineFields({ searchExpiresAt: new Date(NOW - 5_000) }, NOW);
    expect(r.timeoutSeconds).toBe(0);
  });
});
