/* ------------------------------------------------------------------ */
/*  Tests for the wall-placement orientation contract                  */
/*  Ensures no future changes break the bed-headboard pattern.         */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import {
  ROTATION_TO_WALL,
  WALL_TO_ROTATION,
  WallSide,
  testRotationWallMapping,
  expectAgainstWall,
  expectFacesIntoRoom,
} from "./wallOrientation";
import { suggestFurniture } from "../furniturePlacer";
import { GeneratedRoom, Door } from "../ai-client";

function makeRoom(overrides: Partial<GeneratedRoom> = {}): GeneratedRoom {
  return { name: "Test", x: 0, y: 0, width: 3, height: 2.5, area: 7.5, ...overrides };
}

describe("Rotation-to-wall mapping", () => {
  it("rot=0 → TOP wall", () => testRotationWallMapping());
  it("every rotation maps to exactly one wall", () => {
    const walls = new Set<WallSide>();
    for (const rot of [0, 90, 180, 270]) {
      const wall = ROTATION_TO_WALL[rot];
      expect(wall).toBeDefined();
      walls.add(wall);
    }
    expect(walls.size).toBe(4); // all 4 walls covered
  });

  it("WALL_TO_ROTATION is the inverse of ROTATION_TO_WALL", () => {
    for (const rot of [0, 90, 180, 270]) {
      const wall = ROTATION_TO_WALL[rot];
      expect(WALL_TO_ROTATION[wall]).toBe(rot);
    }
  });
});

describe("Toilet orientation on each wall", () => {
  // Door on one wall → toilet should go opposite, cistern against that wall
  it("door on bottom → toilet on top wall (rot=0)", () => {
    const room = makeRoom({ name: "Bathroom" });
    const door: Door = { room: "Bathroom", wall: "bottom", offset: 1.5, width: 0.8, swing: "in" };
    const result = suggestFurniture([room], [door]);
    const toilet = result.find((pf) => pf.itemId === "toilet");
    expect(toilet).toBeDefined();
    expect(toilet!.rotation).toBe(0);
    expectAgainstWall(toilet!, room);
    expectFacesIntoRoom(toilet!, room);
  });

  it("door on top → toilet on bottom wall (rot=180)", () => {
    const room = makeRoom({ name: "Bathroom" });
    const door: Door = { room: "Bathroom", wall: "top", offset: 1.5, width: 0.8, swing: "in" };
    const result = suggestFurniture([room], [door]);
    const toilet = result.find((pf) => pf.itemId === "toilet");
    expect(toilet).toBeDefined();
    expect(toilet!.rotation).toBe(180);
    expectAgainstWall(toilet!, room);
    expectFacesIntoRoom(toilet!, room);
  });

  it("door on right → toilet on left wall (rot=270)", () => {
    const room = makeRoom({ name: "Bathroom" });
    const door: Door = { room: "Bathroom", wall: "right", offset: 1.25, width: 0.8, swing: "in" };
    const result = suggestFurniture([room], [door]);
    const toilet = result.find((pf) => pf.itemId === "toilet");
    expect(toilet).toBeDefined();
    expect(toilet!.rotation).toBe(270);
    expectAgainstWall(toilet!, room);
    expectFacesIntoRoom(toilet!, room);
  });

  it("door on left → toilet on right wall (rot=90)", () => {
    const room = makeRoom({ name: "Bathroom" });
    const door: Door = { room: "Bathroom", wall: "left", offset: 1.25, width: 0.8, swing: "in" };
    const result = suggestFurniture([room], [door]);
    const toilet = result.find((pf) => pf.itemId === "toilet");
    expect(toilet).toBeDefined();
    expect(toilet!.rotation).toBe(90);
    expectAgainstWall(toilet!, room);
    expectFacesIntoRoom(toilet!, room);
  });

  it("toilet with no door defaults to valid placement", () => {
    const room = makeRoom({ name: "Bathroom" });
    const result = suggestFurniture([room], [], []);
    const toilet = result.find((pf) => pf.itemId === "toilet");
    expect(toilet).toBeDefined();
    // Should have a valid rotation (0, 90, 180, or 270)
    expect([0, 90, 180, 270]).toContain(toilet!.rotation);
    expectAgainstWall(toilet!, room);
    expectFacesIntoRoom(toilet!, room);
  });
});

describe("Bed orientation (always rot=0, headboard against back wall)", () => {
  it("bed rotation is always 0", () => {
    const room = makeRoom({ name: "Master Bedroom", width: 5, height: 4.5, area: 22 });
    const result = suggestFurniture([room]);
    const bed = result.find((pf) => pf.itemId.startsWith("bed-"));
    expect(bed).toBeDefined();
    expect(bed!.rotation).toBe(0);
  });

  it("headboard (local y=0) is against the back wall (top)", () => {
    const room = makeRoom({ name: "Master Bedroom", width: 5, height: 4.5, area: 22 });
    const result = suggestFurniture([room]);
    const bed = result.find((pf) => pf.itemId.startsWith("bed-"));
    expect(bed).toBeDefined();
    expectAgainstWall(bed!, room, 0.3); // 0.3m tolerance — bed has 0.15m margin + headboard thickness
    expectFacesIntoRoom(bed!, room);
  });
});
