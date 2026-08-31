import { describe, it, expect } from "vitest";
import { lanesFor } from "../eventListLanes";

/**
 * The matrix for List A #17. The case that shipped broken is the first one: a PHONE in
 * portrait (measured at 402 CSS px on an iPhone 17 Simulator through the ingress) must get
 * ONE lane — the old code gave every mobile two, in every orientation and at every width.
 */
describe("lanesFor", () => {
  it("gives a phone in portrait one lane", () => {
    expect(lanesFor({ mobile: true, width: 402, portrait: true })).toBe(1);
    // the narrower and wider phones in the same class
    expect(lanesFor({ mobile: true, width: 320, portrait: true })).toBe(1);
    expect(lanesFor({ mobile: true, width: 639, portrait: true })).toBe(1);
  });

  it("gives a tablet in portrait two lanes, like upstream's sm:portrait:grid-cols-2", () => {
    expect(lanesFor({ mobile: true, width: 768, portrait: true })).toBe(2);
    expect(lanesFor({ mobile: true, width: 640, portrait: true })).toBe(2);
    expect(lanesFor({ mobile: true, width: 1024, portrait: true })).toBe(2);
  });

  it("gives one lane in landscape whatever the width", () => {
    // a phone on its side is wide enough for `sm:` and must still be one lane —
    // `portrait:` is a hard gate in upstream's class, not a hint
    expect(lanesFor({ mobile: true, width: 874, portrait: false })).toBe(1);
    expect(lanesFor({ mobile: true, width: 1024, portrait: false })).toBe(1);
  });

  it("gives desktop one lane", () => {
    expect(lanesFor({ mobile: false, width: 1400, portrait: false })).toBe(1);
    // a narrow or portrait DESKTOP window is still not a mobile device
    expect(lanesFor({ mobile: false, width: 800, portrait: true })).toBe(1);
    expect(lanesFor({ mobile: false, width: 2560, portrait: false })).toBe(1);
  });
});
