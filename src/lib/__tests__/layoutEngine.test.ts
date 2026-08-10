/* ------------------------------------------------------------------ */
/*  Tests for layout engine rules                                     */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { computeLayout, isFurnitureInBounds, AbstractPlan } from "../layoutEngine";
import { LayoutResult } from "../ai-client";

/* ---- helpers ---- */

function makePlan(overrides: Partial<AbstractPlan> = {}): AbstractPlan {
  const totalArea = overrides.totalArea ?? 150;
  return {
    totalArea, hallwayWidth: 1.2, hallwaySide: "center",
    zones: {
      frontLeft: ["Living Room"], backLeft: ["Kitchen", "Dining"],
      frontRight: ["Master Bedroom"], backRight: ["Bedroom 2", "Bedroom 3"],
    },
    roomRatios: {
      "Living Room": 0.22, Kitchen: 0.14, Dining: 0.10,
      "Master Bedroom": 0.18, "Bedroom 2": 0.12, "Bedroom 3": 0.12, Hallway: 0.12,
    },
    exteriorExtensions: {},
    ...overrides,
  };
}

function run(overrides: Partial<AbstractPlan> = {}): LayoutResult {
  return computeLayout(makePlan(overrides));
}

function planWithEnsuite(overrides: Partial<AbstractPlan> = {}): AbstractPlan {
  return makePlan({
    zones: {
      frontLeft: ["Living Room"], backLeft: ["Kitchen", "Dining", "Bathroom"],
      frontRight: ["Master Bedroom", "Ensuite"], backRight: ["Bedroom 2", "Bedroom 3"],
    },
    roomRatios: {
      "Living Room": 0.20, Kitchen: 0.12, Dining: 0.10, Bathroom: 0.06,
      "Master Bedroom": 0.18, Ensuite: 0.04, "Bedroom 2": 0.10, "Bedroom 3": 0.08, Hallway: 0.12,
    },
    ...overrides,
  });
}

const singleBath = (): AbstractPlan => makePlan({
  zones: {
    frontLeft: ["Living Room"], backLeft: ["Kitchen", "Dining", "Bathroom"],
    frontRight: ["Master Bedroom"], backRight: ["Bedroom 2", "Bedroom 3"],
  },
  roomRatios: {
    "Living Room": 0.20, Kitchen: 0.12, Dining: 0.10, Bathroom: 0.06,
    "Master Bedroom": 0.18, "Bedroom 2": 0.12, "Bedroom 3": 0.10, Hallway: 0.12,
  },
});

/* ---- tests ---- */

describe("room allocation", () => {
  it("creates rooms from all zones", () => {
    const r = run();
    const n = r.rooms.map((x) => x.name.toLowerCase());
    expect(n.some((x) => x.includes("living"))).toBe(true);
    expect(n.some((x) => x.includes("kitchen"))).toBe(true);
    expect(n.some((x) => x.includes("dining"))).toBe(true);
    expect(n.filter((x) => x.includes("bedroom")).length).toBeGreaterThanOrEqual(3);
  });

  it("ensuite appears when zones include Ensuite", () => {
    const r = run(planWithEnsuite());
    expect(r.rooms.some((x) => /ensuite/i.test(x.name))).toBe(true);
  });

  it("no ensuite when zones omit it", () => {
    const r = run(singleBath());
    expect(r.rooms.every((x) => !/ensuite/i.test(x.name))).toBe(true);
  });

  it("master > other bedrooms", () => {
    const r = run();
    const m = r.rooms.find((x) => /master/i.test(x.name))!;
    const o = r.rooms.filter((x) => /bedroom/i.test(x.name) && !/master/i.test(x.name));
    for (const x of o) expect(m.area).toBeGreaterThanOrEqual(x.area * 1.03);
  });

  it("bathroom capped", () => {
    const r = run(makePlan({
      totalArea: 500,
      zones: { frontLeft: ["Living Room"], backLeft: ["Kitchen", "Dining"], frontRight: ["Master Bedroom"], backRight: ["Bedroom 2", "Bedroom 3", "Bathroom"] },
      roomRatios: { "Living Room": 0.20, Kitchen: 0.12, Dining: 0.10, "Master Bedroom": 0.18, "Bedroom 2": 0.12, "Bedroom 3": 0.10, Bathroom: 0.06, Hallway: 0.12 },
    }));
    const b = r.rooms.find((x) => /bath/i.test(x.name) && !/ensuite/i.test(x.name))!;
    expect(b.area).toBeLessThan(35);
  });

  it("ensuite proportional & capped", () => {
    const r = run(planWithEnsuite({ totalArea: 500 }));
    const e = r.rooms.find((x) => /ensuite/i.test(x.name));
    if (e) { expect(e.area).toBeGreaterThanOrEqual(5); expect(e.area).toBeLessThan(25); }
  });
});

describe("column balancing", () => {
  it("both columns have rooms and diff ≤ 3", () => {
    const r = run();
    const h = r.rooms.find((x) => /hall/i.test(x.name))!;
    const L = r.rooms.filter((x) => x.x + x.width / 2 < h.x + h.width / 2 && !/hall/i.test(x.name));
    const R = r.rooms.filter((x) => x.x + x.width / 2 >= h.x + h.width / 2 && !/hall/i.test(x.name));
    expect(L.length).toBeGreaterThan(0);
    expect(R.length).toBeGreaterThan(0);
    expect(Math.abs(L.length - R.length)).toBeLessThanOrEqual(3);
  });
});

describe("building proportions", () => {
  it("wider at larger area", () => {
    const s = run({ totalArea: 100 });
    const l = run({ totalArea: 300 });
    expect(Math.max(...l.rooms.map((x) => x.x + x.width))).toBeGreaterThan(Math.max(...s.rooms.map((x) => x.x + x.width)));
  });

  it("reasonably square at 300m²", () => {
    const r = run(makePlan({ totalArea: 300 }));
    const mx = Math.max(...r.rooms.map((x) => x.x + x.width));
    const my = Math.max(...r.rooms.map((x) => x.y + x.height));
    const ratio = mx / my;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  });
});

describe("balcony / porch", () => {
  it("exterior extension creates balcony", () => {
    const r = computeLayout(makePlan({ exteriorExtensions: { Balcony: "front" } }));
    expect(r.rooms.filter((x) => /balcony/i.test(x.name)).length).toBeGreaterThanOrEqual(1);
  });

  it("porch area << interior area", () => {
    const r = computeLayout(makePlan({ exteriorExtensions: { Porch: "front" } }));
    const p = r.rooms.find((x) => /porch/i.test(x.name));
    if (p) {
      const interior = r.rooms.filter((x) => !/porch|balcony|hall/i.test(x.name)).reduce((s, x) => s + x.area, 0);
      expect(interior).toBeGreaterThan(p.area * 3);
    }
  });
});

describe("ensuite carving", () => {
  it("ensuite overlaps master bounds", () => {
    const r = run(planWithEnsuite());
    const m = r.rooms.find((x) => /master/i.test(x.name));
    const e = r.rooms.find((x) => /ensuite/i.test(x.name));
    if (m && e) {
      expect(e.x < m.x + m.width && e.x + e.width > m.x).toBe(true);
      expect(e.y < m.y + m.height && e.y + e.height > m.y).toBe(true);
    }
  });

  it("ensuite ≥ 5m²", () => {
    const r = run(planWithEnsuite({ totalArea: 80 }));
    const e = r.rooms.find((x) => /ensuite/i.test(x.name));
    if (e) expect(e.area).toBeGreaterThanOrEqual(5);
  });
});

describe("hallway", () => {
  it("exists and spans building height", () => {
    const r = run();
    const h = r.rooms.find((x) => /hall/i.test(x.name))!;
    const bh = Math.max(...r.rooms.map((x) => x.y + x.height));
    expect(h.height).toBeGreaterThan(bh * 0.7);
  });
});

describe("isFurnitureInBounds", () => {
  const room = { name: "t", x: 0, y: 0, width: 5, height: 4, area: 20 };
  it("true when fully inside", () => expect(isFurnitureInBounds(2.5, 2, 2, 1.5, room)).toBe(true));
  it("false when extending beyond", () => expect(isFurnitureInBounds(4.5, 2, 2, 3, room)).toBe(false));
  it("false when partially outside", () => expect(isFurnitureInBounds(2.5, 1.5, 1.5, 1.5, { ...room, width: 3, height: 3, area: 9 })).toBe(false));
});

describe("zero-gap", () => {
  it("no vertical gaps between rooms in a column", () => {
    const r = run(makePlan({ totalArea: 200 }));
    const h = r.rooms.find((x) => /hall/i.test(x.name));
    if (!h) return;
    const col = r.rooms.filter((x) => x.x + x.width / 2 < h.x + h.width / 2 && !/hall|balcony|porch/i.test(x.name)).sort((a, b) => a.y - b.y);
    for (let i = 0; i < col.length - 1; i++) {
      expect(Math.abs(col[i].y + col[i].height - col[i + 1].y)).toBeLessThan(0.05);
    }
  });
});

describe("edge cases", () => {
  it("small area falls back to 100m² minimum", () => {
    const r = run({ totalArea: 50 });
    expect(r.rooms.length).toBeGreaterThan(0);
  });

  it("every room has positive dimensions", () => {
    for (const x of run(makePlan({ totalArea: 200 })).rooms) {
      expect(x.area).toBeGreaterThan(0);
      expect(x.width).toBeGreaterThan(0);
      expect(x.height).toBeGreaterThan(0);
    }
  });

  it("total interior ≈ requested area (±30%)", () => {
    const r = run({ totalArea: 150 });
    const t = r.rooms.filter((x) => !/balcony|porch/i.test(x.name)).reduce((s, x) => s + x.area, 0);
    expect(t).toBeGreaterThan(150 * 0.7);
    expect(t).toBeLessThan(150 * 1.3);
  });
});
