/* ------------------------------------------------------------------ */
/*  Tests for functional zone cut-outs (color-coded imaginary walls)   */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { computeRoomZones, RoomZone, ZoneRect } from "../roomZones";
import { suggestFurniture } from "../furniturePlacer";
import { GeneratedRoom } from "../ai-client";

function makeRoom(overrides: Partial<GeneratedRoom>): GeneratedRoom {
  return {
    name: "Room",
    x: 0,
    y: 0,
    width: 5,
    height: 5,
    area: 25,
    ...overrides,
  };
}

function zonesFor(rooms: GeneratedRoom[]): RoomZone[] {
  const furniture = suggestFurniture(rooms);
  return computeRoomZones(rooms, [], [], furniture);
}

function rectsOverlap(a: ZoneRect, b: ZoneRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

function areaOf(z: RoomZone): number {
  return z.rects.reduce((s, r) => s + r.width * r.height, 0);
}

function totalArea(zones: RoomZone[], kind: string): number {
  return zones.filter(z => z.kind === kind).reduce((s, z) => s + areaOf(z), 0);
}

describe("computeRoomZones", () => {
  it("studio (large) gets bed, kitchen and living zones in a 15:7:18 ratio", () => {
    const studio = makeRoom({ name: "Studio", width: 6, height: 6, area: 36, hasKitchenZone: true });
    const zones = zonesFor([studio]).filter(z => z.room === "Studio");

    const kinds = new Set(zones.map(z => z.kind));
    expect(kinds).toEqual(new Set(["bed", "kitchen", "living"]));

    // 10% of the living share was moved into the cooking share (15:7:18).
    expect(Math.abs(totalArea(zones, "bed") - 13.5)).toBeLessThan(1.0);
    expect(Math.abs(totalArea(zones, "kitchen") - 6.3)).toBeLessThan(1.0);
    expect(Math.abs(totalArea(zones, "living") - 16.2)).toBeLessThan(1.5);
  });

  it("one-bedroom open-plan living room gets kitchen : living = 13 : 27", () => {
    const living = makeRoom({ name: "Living Room", width: 6, height: 5, area: 30, hasKitchenZone: true });
    const bedroom = makeRoom({ name: "Bedroom 1", x: 6, y: 0, width: 3.5, height: 4, area: 14 });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 5, width: 2.2, height: 2, area: 4.4 });
    const zones = zonesFor([living, bedroom, bathroom]).filter(z => z.room === "Living Room");

    const kinds = new Set(zones.map(z => z.kind));
    expect(kinds).toEqual(new Set(["kitchen", "living"]));
    expect(totalArea(zones, "kitchen")).toBeGreaterThan(8);
    expect(totalArea(zones, "kitchen")).toBeLessThan(11.5);
    expect(totalArea(zones, "living")).toBeGreaterThan(18.5);
  });

  it("no zones for multi-bedroom homes or homes with a dedicated kitchen", () => {
    const living = makeRoom({ name: "Living Room", width: 6, height: 5, area: 30, hasKitchenZone: true });
    const bedroom1 = makeRoom({ name: "Bedroom 1", x: 6, y: 0, width: 3.5, height: 4, area: 14 });
    const bedroom2 = makeRoom({ name: "Bedroom 2", x: 6, y: 4, width: 3.5, height: 4, area: 14 });
    expect(zonesFor([living, bedroom1, bedroom2]).filter(z => z.room === "Living Room")).toHaveLength(0);

    const kitchen = makeRoom({ name: "Kitchen", x: 0, y: 5, width: 3, height: 3, area: 9 });
    expect(zonesFor([living, bedroom1, kitchen]).filter(z => z.room === "Living Room")).toHaveLength(0);
  });

  it("small studio falls back to bed + living (1:2), tiny studio to bed only", () => {
    const small = makeRoom({ name: "Studio", width: 3.5, height: 3.5, area: 12.25 });
    const smallKinds = new Set(zonesFor([small]).filter(z => z.room === "Studio").map(z => z.kind));
    expect(smallKinds).toEqual(new Set(["bed", "living"]));

    const tiny = makeRoom({ name: "Studio", width: 2.5, height: 2.5, area: 6.25 });
    const tinyZones = zonesFor([tiny]).filter(z => z.room === "Studio");
    expect(tinyZones.map(z => z.kind)).toEqual(["bed"]);
  });

  it("zones never overlap each other or the carved bathroom, and stay contiguous", () => {
    const studio = makeRoom({ name: "Studio", width: 5.7, height: 5.7, area: 30, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 2.8, width: 2.0, height: 2.9, area: 5.8 });
    const zones = zonesFor([studio, bathroom]).filter(z => z.room === "Studio");

    const allRects: Array<{ z: RoomZone; r: ZoneRect }> = zones.flatMap(z => z.rects.map(r => ({ z, r })));

    // Pairwise rect non-overlap.
    for (let i = 0; i < allRects.length; i++) {
      for (let j = i + 1; j < allRects.length; j++) {
        expect(rectsOverlap(allRects[i].r, allRects[j].r),
          `zones ${allRects[i].z.kind} and ${allRects[j].z.kind} must not overlap`
        ).toBe(false);
      }
    }

    // No overlap with the bathroom; every rect inside the studio.
    const bathRect: ZoneRect = { x: bathroom.x, y: bathroom.y, width: bathroom.width, height: bathroom.height };
    for (const { z, r } of allRects) {
      expect(rectsOverlap(r, bathRect), `${z.kind} zone must not overlap the bathroom`).toBe(false);
      expect(r.x).toBeGreaterThanOrEqual(studio.x - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(studio.y - 1e-9);
      expect(r.x + r.width).toBeLessThanOrEqual(studio.x + studio.width + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(studio.y + studio.height + 1e-9);
    }

    // Zones cover the whole usable area (no gaps).
    const usable = studio.area - bathroom.area;
    expect(totalArea(zones, "bed") + totalArea(zones, "living") + totalArea(zones, "kitchen"))
      .toBeGreaterThan(usable - 1.5);
  });

  it("zones stay contiguous when the bathroom is on the bottom-left corner", () => {
    // The bathroom at the BOTTOM-left must not leave an isolated living strip
    // at the top — every zone stays one connected space.
    const studio = makeRoom({ name: "Studio", width: 5.7, height: 5.7, area: 30, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 0, width: 2.0, height: 2.9, area: 5.8 });
    const zones = zonesFor([studio, bathroom]).filter(z => z.room === "Studio");

    // Every rect stays inside the studio (ratios never go out of bounds).
    for (const z of zones) {
      for (const r of z.rects) {
        expect(r.x).toBeGreaterThanOrEqual(studio.x - 1e-9);
        expect(r.y).toBeGreaterThanOrEqual(studio.y - 1e-9);
        expect(r.x + r.width).toBeLessThanOrEqual(studio.x + studio.width + 1e-9);
        expect(r.y + r.height).toBeLessThanOrEqual(studio.y + studio.height + 1e-9);
      }
    }

    for (const z of zones) {
      if (z.rects.length <= 1) continue;
      let connected = true;
      for (let i = 0; i < z.rects.length; i++) {
        const touching = z.rects.some((r, j) =>
          i !== j &&
          ((Math.abs(z.rects[i].x + z.rects[i].width - r.x) < 1e-6 ||
            Math.abs(r.x + r.width - z.rects[i].x) < 1e-6) &&
           z.rects[i].y < r.y + r.height && r.y < z.rects[i].y + z.rects[i].height) ||
          ((Math.abs(z.rects[i].y + z.rects[i].height - r.y) < 1e-6 ||
            Math.abs(r.y + r.height - z.rects[i].y) < 1e-6) &&
           z.rects[i].x < r.x + r.width && r.x < z.rects[i].x + z.rects[i].width)
        );
        if (!touching) connected = false;
      }
      expect(connected, `${z.kind} zone must be one contiguous space (bottom-left bathroom)`).toBe(true);
    }
  });
});
