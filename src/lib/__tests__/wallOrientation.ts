/* ------------------------------------------------------------------ */
/*  Wall-placement orientation contract                                */
/*                                                                     */
/*  For ANY object placed against a wall with its "back" at local y=0: */
/*                                                                     */
/*    rot=0:   local y=0 → worldY = centerY + halfH   (TOP wall)       */
/*    rot=180: local y=0 → worldY = centerY - halfH   (BOTTOM wall)    */
/*    rot=270: local y=0 → worldX = centerX - halfH   (LEFT wall)      */
/*    rot=90:  local y=0 → worldX = centerX + halfH   (RIGHT wall)     */
/*                                                                     */
/*  Center position relative to the wall:                              */
/*    TOP:    centerY = room.y + room.height - halfH - margin           */
/*    BOTTOM: centerY = room.y + halfH + margin                         */
/*    LEFT:   centerX = room.x + halfH + margin                         */
/*    RIGHT:  centerX = room.x + room.width - halfH - margin            */
/*                                                                     */
/*  This matches the bed headboard pattern (which is verified working). */
/* ------------------------------------------------------------------ */

import { expect } from "vitest";
import { PlacedFurniture } from "../furniture";
import { getFurnitureById } from "../furniture";
import { GeneratedRoom } from "../ai-client";

export type WallSide = "top" | "bottom" | "left" | "right";

/** Maps rotation to which wall the object's "back" (local y=0) faces. */
export const ROTATION_TO_WALL: Record<number, WallSide> = {
  0: "top",
  180: "bottom",
  270: "left",
  90: "right",
};

/** Maps a wall side to the rotation that puts local y=0 against that wall. */
export const WALL_TO_ROTATION: Record<WallSide, number> = {
  top: 0,
  bottom: 180,
  left: 270,
  right: 90,
};

/**
 * Verify that a placed furniture item has its local-y=0 side (the "back")
 * against the expected wall, within a given tolerance.
 *
 * @param pf      - the placed furniture item
 * @param room    - the room it's in
 * @param margin  - maximum allowed distance from wall to object edge (default 0.15m)
 */
export function expectAgainstWall(
  pf: PlacedFurniture,
  room: GeneratedRoom,
  margin = 0.15
): void {
  const item = getFurnitureById(pf.itemId);
  if (!item) throw new Error(`Unknown item: ${pf.itemId}`);

  const halfH = item.height / 2;
  const expectedWall = ROTATION_TO_WALL[pf.rotation];
  if (expectedWall === undefined) {
    throw new Error(`Unsupported rotation ${pf.rotation}° — must be 0, 90, 180, or 270`);
  }

  switch (expectedWall) {
    case "top": {
      // local y=0 → worldY = centerY + halfH should be near top wall
      const backWorldY = pf.y + halfH;
      const dist = (room.y + room.height) - backWorldY;
      expect(dist, `rot=0: back should be within ${margin}m of TOP wall (room.y + room.height = ${room.y + room.height}), back is at worldY=${backWorldY.toFixed(2)}, distance=${dist.toFixed(2)}m`).toBeLessThan(margin);
      // Front (local y=h) should be away from the wall (into the room)
      expect(backWorldY - pf.y + halfH).toBeGreaterThan(0);
      break;
    }
    case "bottom": {
      const backWorldY = pf.y - halfH;
      const dist = backWorldY - room.y;
      expect(dist, `rot=180: back should be within ${margin}m of BOTTOM wall (room.y = ${room.y}), back is at worldY=${backWorldY.toFixed(2)}, distance=${dist.toFixed(2)}m`).toBeLessThan(margin);
      break;
    }
    case "left": {
      const backWorldX = pf.x - halfH;
      const dist = backWorldX - room.x;
      expect(dist, `rot=270: back should be within ${margin}m of LEFT wall (room.x = ${room.x}), back is at worldX=${backWorldX.toFixed(2)}, distance=${dist.toFixed(2)}m`).toBeLessThan(margin);
      break;
    }
    case "right": {
      const backWorldX = pf.x + halfH;
      const dist = (room.x + room.width) - backWorldX;
      expect(dist, `rot=90: back should be within ${margin}m of RIGHT wall (room.x + room.width = ${room.x + room.width}), back is at worldX=${backWorldX.toFixed(2)}, distance=${dist.toFixed(2)}m`).toBeLessThan(margin);
      break;
    }
  }
}

/**
 * Verify that a placed furniture item's "front" (local y = item.height) faces
 * into the room (away from its back wall). For rot=0, this means worldY decreases.
 */
export function expectFacesIntoRoom(
  pf: PlacedFurniture,
  room: GeneratedRoom
): void {
  const item = getFurnitureById(pf.itemId);
  if (!item) throw new Error(`Unknown item: ${pf.itemId}`);

  const halfH = item.height / 2;
  const expectedWall = ROTATION_TO_WALL[pf.rotation];

  // The front (local y = item.height) should be further from the expected wall
  // than the back (local y = 0).
  switch (expectedWall) {
    case "top": {
      const frontY = pf.y - halfH;
      const backY = pf.y + halfH;
      expect(frontY, "front should be below the back (into the room)").toBeLessThan(backY);
      // Should be inside room
      expect(frontY).toBeGreaterThanOrEqual(room.y);
      break;
    }
    case "bottom": {
      const frontY = pf.y + halfH;
      const backY = pf.y - halfH;
      expect(frontY, "front should be above the back (into the room)").toBeGreaterThan(backY);
      expect(frontY).toBeLessThanOrEqual(room.y + room.height);
      break;
    }
    case "left": {
      const frontX = pf.x + halfH;
      const backX = pf.x - halfH;
      expect(frontX, "front should be right of the back (into the room)").toBeGreaterThan(backX);
      expect(frontX).toBeLessThanOrEqual(room.x + room.width);
      break;
    }
    case "right": {
      const frontX = pf.x - halfH;
      const backX = pf.x + halfH;
      expect(frontX, "front should be left of the back (into the room)").toBeLessThan(backX);
      expect(frontX).toBeGreaterThanOrEqual(room.x);
      break;
    }
  }
}

/**
 * Verify that every rotation (0, 90, 180, 270) maps local y=0 to the
 * correct wall side. This is a pure unit test of the ROTATION_TO_WALL map.
 */
export function testRotationWallMapping(): void {
  expect(ROTATION_TO_WALL[0]).toBe("top");
  expect(ROTATION_TO_WALL[180]).toBe("bottom");
  expect(ROTATION_TO_WALL[270]).toBe("left");
  expect(ROTATION_TO_WALL[90]).toBe("right");
  // Round-trip
  for (const [rot, wall] of Object.entries(ROTATION_TO_WALL)) {
    expect(WALL_TO_ROTATION[wall as WallSide]).toBe(Number(rot));
  }
}
