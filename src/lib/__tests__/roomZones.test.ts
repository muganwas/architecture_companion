/* ------------------------------------------------------------------ */
/*  Tests for functional zone cut-outs (color-coded imaginary walls)   */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { computeRoomZones, RoomZone, ZoneRect, isLivingItemId, isBedItemId, boxInsideZone } from "../roomZones";
import { suggestFurniture } from "../furniturePlacer";
import { GeneratedRoom, Door } from "../ai-client";
import { PlacedFurniture, getFurnitureById } from "../furniture";

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

/* ------------------------------------------------------------------ */
/*  Zone enforcement: living furniture must stay inside the living zone */
/* ------------------------------------------------------------------ */

/** Rotation-aware bounding box (same formula as the placer's validation). */
function furnitureAabb(pf: PlacedFurniture): { w: number; h: number } {
  const item = getFurnitureById(pf.itemId)!;
  const rad = (pf.rotation * Math.PI) / 180;
  return {
    w: (Math.abs(item.width * Math.cos(rad)) + Math.abs(item.height * Math.sin(rad))) * pf.scale,
    h: (Math.abs(item.width * Math.sin(rad)) + Math.abs(item.height * Math.cos(rad))) * pf.scale,
  };
}

/** Living-group items, mirroring the placer's studio bed-side rules. */
function livingGroup(furniture: PlacedFurniture[], roomName: string): PlacedFurniture[] {
  const beds = furniture.filter(pf => pf.room === roomName && isBedItemId(pf.itemId));
  return furniture.filter(pf => {
    if (pf.room !== roomName || !isLivingItemId(pf.itemId)) return false;
    if (pf.itemId === "side-table" || pf.itemId.startsWith("rug-")) {
      const nearBed = beds.some(b =>
        Math.abs(pf.x - b.x) < 1.8 && Math.abs(pf.y - b.y) < 1.8);
      return !nearBed;
    }
    return true;
  });
}

describe("zone enforcement (living furniture)", () => {
  function expectLivingInsideZone(rooms: GeneratedRoom[], roomName: string) {
    const furniture = suggestFurniture(rooms);
    const zones = computeRoomZones(rooms, [], [], furniture);
    const living = zones.find(z => z.room === roomName && z.kind === "living");
    expect(living, `expected a living zone in "${roomName}"`).toBeDefined();

    const items = livingGroup(furniture, roomName);
    expect(items.length, "expected living furniture in the room").toBeGreaterThan(0);

    for (const pf of items) {
      const { w, h } = furnitureAabb(pf);
      expect(
        boxInsideZone(pf.x - w / 2, pf.y - h / 2, w, h, living!.rects),
        `${pf.itemId} at (${pf.x.toFixed(2)}, ${pf.y.toFixed(2)}) must lie fully inside the living zone`
      ).toBe(true);
    }
  }

  function expectLivingNotInKitchenZone(rooms: GeneratedRoom[], roomName: string) {
    const furniture = suggestFurniture(rooms);
    const zones = computeRoomZones(rooms, [], [], furniture);
    const living = zones.find(z => z.room === roomName && z.kind === "living");
    const kitchen = zones.find(z => z.room === roomName && z.kind === "kitchen");
    if (!living || !kitchen) return; // no kitchen zone in this configuration

    for (const pf of livingGroup(furniture, roomName)) {
      const { w, h } = furnitureAabb(pf);
      const box: ZoneRect = { x: pf.x - w / 2, y: pf.y - h / 2, width: w, height: h };
      const overlapsKitchen = kitchen.rects.some(r => rectsOverlap(box, r));
      expect(overlapsKitchen,
        `${pf.itemId} must not overlap the kitchen zone`).toBe(false);
    }
  }

  it("studio living furniture stays fully inside the living zone (carved bathroom)", () => {
    const studio = makeRoom({ name: "Studio", width: 5.7, height: 5.7, area: 30, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 2.8, width: 2.0, height: 2.9, area: 5.8 });
    expectLivingInsideZone([studio, bathroom], "Studio");
    expectLivingNotInKitchenZone([studio, bathroom], "Studio");
  });

  it("one-bedroom open-plan living furniture stays fully inside the living zone", () => {
    const living = makeRoom({ name: "Living Room", width: 6, height: 5, area: 30, hasKitchenZone: true });
    const bedroom = makeRoom({ name: "Bedroom 1", x: 6, y: 0, width: 3.5, height: 4, area: 14 });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 5, width: 2.2, height: 2, area: 4.4 });
    expectLivingInsideZone([living, bedroom, bathroom], "Living Room");
    expectLivingNotInKitchenZone([living, bedroom, bathroom], "Living Room");
  });

  it("studio with a bottom-left bathroom keeps living furniture in its zone", () => {
    const studio = makeRoom({ name: "Studio", width: 5.7, height: 5.7, area: 30, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 0, width: 2.0, height: 2.9, area: 5.8 });
    expectLivingInsideZone([studio, bathroom], "Studio");
  });
});

/* ------------------------------------------------------------------ */
/*  Studio door rules: living/kitchen at the entrance, bed by bath door */
/* ------------------------------------------------------------------ */

function nearestZoneTo(zones: RoomZone[], p: { x: number; y: number }): RoomZone | null {
  let best: RoomZone | null = null;
  let bestDist = Infinity;
  for (const z of zones) {
    let d = Infinity;
    for (const r of z.rects) {
      const cx = Math.max(r.x, Math.min(p.x, r.x + r.width));
      const cy = Math.max(r.y, Math.min(p.y, r.y + r.height));
      d = Math.min(d, (p.x - cx) ** 2 + (p.y - cy) ** 2);
    }
    if (d < bestDist) { bestDist = d; best = z; }
  }
  return best;
}

function doorPoint(door: Door, room: GeneratedRoom): { x: number; y: number } {
  switch (door.wall) {
    case "bottom": return { x: room.x + door.offset, y: room.y };
    case "top": return { x: room.x + door.offset, y: room.y + room.height };
    case "left": return { x: room.x, y: room.y + door.offset };
    case "right": return { x: room.x + room.width, y: room.y + door.offset };
  }
}

describe("studio door rules", () => {
  it("living or kitchen zone owns the main entrance, bed zone owns the bathroom door", () => {
    const studio = makeRoom({ name: "Studio", width: 6, height: 6, area: 36, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 3.8, y: 3.8, width: 2.2, height: 2.2, area: 4.8 });
    const entrance: Door = { room: "Studio", wall: "bottom", offset: 3, width: 1, swing: "in" };
    const bathDoor: Door = { room: "Bathroom", wall: "left", offset: 1.1, width: 0.8, swing: "in" };

    const furniture = suggestFurniture([studio, bathroom], [entrance, bathDoor]);
    const zones = computeRoomZones([studio, bathroom], [entrance, bathDoor], [], furniture)
      .filter(z => z.room === "Studio");

    const entranceZone = nearestZoneTo(zones, doorPoint(entrance, studio))!;
    expect(["living", "kitchen"], "entrance must be owned by living or kitchen").toContain(entranceZone.kind);

    const bathZone = nearestZoneTo(zones, doorPoint(bathDoor, bathroom))!;
    expect(bathZone.kind, "bed zone must be closest to the bathroom door").toBe("bed");
  });

  it("side-wall entrance keeps living/kitchen at the entrance and bed at the bathroom", () => {
    const studio = makeRoom({ name: "Studio", width: 6, height: 6, area: 36, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 3.8, y: 0, width: 2.2, height: 2.2, area: 4.8 });
    const entrance: Door = { room: "Studio", wall: "left", offset: 3, width: 1, swing: "in" };
    const bathDoor: Door = { room: "Bathroom", wall: "top", offset: 1.1, width: 0.8, swing: "in" };

    const furniture = suggestFurniture([studio, bathroom], [entrance, bathDoor]);
    const zones = computeRoomZones([studio, bathroom], [entrance, bathDoor], [], furniture)
      .filter(z => z.room === "Studio");

    const entranceZone = nearestZoneTo(zones, doorPoint(entrance, studio))!;
    expect(["living", "kitchen"], "entrance must be owned by living or kitchen").toContain(entranceZone.kind);

    const bathZone = nearestZoneTo(zones, doorPoint(bathDoor, bathroom))!;
    expect(bathZone.kind, "bed zone must be closest to the bathroom door").toBe("bed");
  });

  it("top-wall entrance pushes living/kitchen to the back wall, bed stays by the bathroom", () => {
    const studio = makeRoom({ name: "Studio", width: 6, height: 6, area: 36, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 0, width: 2.2, height: 2.2, area: 4.8 });
    const entrance: Door = { room: "Studio", wall: "top", offset: 3, width: 1, swing: "in" };
    const bathDoor: Door = { room: "Bathroom", wall: "right", offset: 1.1, width: 0.8, swing: "in" };

    const furniture = suggestFurniture([studio, bathroom], [entrance, bathDoor]);
    const zones = computeRoomZones([studio, bathroom], [entrance, bathDoor], [], furniture)
      .filter(z => z.room === "Studio");

    const entranceZone = nearestZoneTo(zones, doorPoint(entrance, studio))!;
    expect(["living", "kitchen"], "entrance must be owned by living or kitchen").toContain(entranceZone.kind);

    const bathZone = nearestZoneTo(zones, doorPoint(bathDoor, bathroom))!;
    expect(bathZone.kind, "bed zone must be closest to the bathroom door").toBe("bed");
  });

  it("no zone splits into separate pieces (bathroom at bottom-left, entrance at bottom)", () => {
    // Reported bug: the living zone was rendered as TWO separate regions —
    // one northern piece and one southern piece. Zones must behave like
    // rooms with invisible walls: ONE contiguous space each, kitchen to the
    // north, living at the entrance, bed by the bathroom door.
    const studio = makeRoom({ name: "Studio", width: 5.7, height: 5.7, area: 32, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 0, width: 2.0, height: 3.0, area: 6 });
    const entrance: Door = { room: "Studio", wall: "bottom", offset: 2.85, width: 1, swing: "in" };
    const bathDoor: Door = { room: "Bathroom", wall: "top", offset: 1.0, width: 0.8, swing: "in" };

    const furniture = suggestFurniture([studio, bathroom], [entrance, bathDoor]);
    const zones = computeRoomZones([studio, bathroom], [entrance, bathDoor], [], furniture)
      .filter(z => z.room === "Studio");

    // Every zone is a SINGLE rectangle — zones are rooms with invisible walls.
    for (const z of zones) {
      expect(z.rects.length, `${z.kind} zone must be a single rectangle`).toBe(1);
    }

    // Living owns the entrance (south), kitchen sits to the north of it.
    const entranceZone = nearestZoneTo(zones, doorPoint(entrance, studio))!;
    expect(entranceZone.kind, "living zone should own the main entrance").toBe("living");

    const kitchenZone = zones.find(z => z.kind === "kitchen")!;
    const livingZone = zones.find(z => z.kind === "living")!;
    expect(kitchenZone.y + kitchenZone.height / 2,
      "kitchen should be north of the living zone"
    ).toBeGreaterThan(livingZone.y + livingZone.height / 2);

    const bathZone = nearestZoneTo(zones, doorPoint(bathDoor, bathroom))!;
    expect(bathZone.kind, "bed zone must be closest to the bathroom door").toBe("bed");
  });
});

/* ------------------------------------------------------------------ */
/*  All zones are plain rectangles — no L-shapes, no split pieces      */
/* ------------------------------------------------------------------ */

describe("zones are plain rectangles", () => {
  it("studio zones are single rectangles with a carved bathroom (no doors)", () => {
    const studio = makeRoom({ name: "Studio", width: 5.7, height: 5.7, area: 30, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 2.8, width: 2.0, height: 2.9, area: 5.8 });
    const furniture = suggestFurniture([studio, bathroom]);
    const zones = computeRoomZones([studio, bathroom], [], [], furniture)
      .filter(z => z.room === "Studio");

    expect(zones.length).toBeGreaterThanOrEqual(2);
    for (const z of zones) {
      expect(z.rects.length, `${z.kind} zone must be a single rectangle`).toBe(1);
    }
  });

  it("one-bedroom open-plan living zones are single rectangles", () => {
    const living = makeRoom({ name: "Living Room", width: 6, height: 5, area: 30, hasKitchenZone: true });
    const bedroom = makeRoom({ name: "Bedroom 1", x: 6, y: 0, width: 3.5, height: 4, area: 14 });
    const furniture = suggestFurniture([living, bedroom]);
    const zones = computeRoomZones([living, bedroom], [], [], furniture)
      .filter(z => z.room === "Living Room");

    expect(zones.length).toBe(2);
    for (const z of zones) {
      expect(z.rects.length, `${z.kind} zone must be a single rectangle`).toBe(1);
    }
  });

  it("studio zones are single rectangles when the bathroom is at the bottom-left", () => {
    const studio = makeRoom({ name: "Studio", width: 5.7, height: 5.7, area: 32, hasKitchenZone: true });
    const bathroom = makeRoom({ name: "Bathroom", x: 0, y: 0, width: 2.0, height: 3.0, area: 6 });
    const entrance: Door = { room: "Studio", wall: "bottom", offset: 2.85, width: 1, swing: "in" };
    const bathDoor: Door = { room: "Bathroom", wall: "top", offset: 1.0, width: 0.8, swing: "in" };
    const furniture = suggestFurniture([studio, bathroom], [entrance, bathDoor]);
    const zones = computeRoomZones([studio, bathroom], [entrance, bathDoor], [], furniture)
      .filter(z => z.room === "Studio");

    for (const z of zones) {
      expect(z.rects.length, `${z.kind} zone must be a single rectangle`).toBe(1);
    }
  });
});
