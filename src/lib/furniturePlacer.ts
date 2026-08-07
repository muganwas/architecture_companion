/* ------------------------------------------------------------------ */
/*  Furniture Placer — intelligently places furniture in rooms         */
/*  Based on room type, size, and furniture dimensions                 */
/* ------------------------------------------------------------------ */

import { GeneratedRoom, Door, Window } from "./ai-client";
import { PlacedFurniture } from "./furniture";
import { getFurnitureForRoom, getFurnitureById } from "./furniture";
import { isFurnitureInBounds } from "./layoutEngine";

/* ------------------------------------------------------------------ */
/*  Obstruction zones (doors + windows)                                 */
/* ------------------------------------------------------------------ */

/** Represents a rectangular zone that a door swing or window occupies */
interface ObstructionZone {
  x: number;       // center x of the zone
  y: number;       // center y of the zone
  halfW: number;   // half-width of the zone
  halfH: number;   // half-height of the zone
}

/**
 * Compute the obstruction zone for a door's swing path.
 * For swing="in", the zone extends inward from the door by the door width.
 * For swing="out", we still reserve a small walkway clearance inside.
 */
function getDoorZone(door: Door, room: GeneratedRoom): ObstructionZone | null {
  // Clearance into the room: capped at 0.9m for wide doors (passages/sliding)
  // to avoid blocking the entire room with a huge obstruction zone.
  const rawClearance = door.swing === "in" ? door.width + 0.15 : 0.5;
  const clearance = Math.min(rawClearance, door.width >= 1.5 ? 0.5 : 1.2);

  switch (door.wall) {
    case "bottom": {
      const doorLeft = room.x + door.offset - door.width / 2;
      return { x: doorLeft + door.width / 2, y: room.y + clearance / 2, halfW: door.width / 2, halfH: clearance / 2 };
    }
    case "top": {
      const doorLeft = room.x + door.offset - door.width / 2;
      return { x: doorLeft + door.width / 2, y: room.y + room.height - clearance / 2, halfW: door.width / 2, halfH: clearance / 2 };
    }
    case "left": {
      const doorTop = room.y + door.offset - door.width / 2;
      return { x: room.x + clearance / 2, y: doorTop + door.width / 2, halfW: clearance / 2, halfH: door.width / 2 };
    }
    case "right": {
      const doorTop = room.y + door.offset - door.width / 2;
      return { x: room.x + room.width - clearance / 2, y: doorTop + door.width / 2, halfW: clearance / 2, halfH: door.width / 2 };
    }
  }
}

/**
 * Compute the obstruction zone for a window.
 * Windows occupy their wall segment; furniture should not block them.
 * The zone extends inward slightly (sill/reveal depth).
 */
function getWindowZone(win: Window, room: GeneratedRoom): ObstructionZone | null {
  const sillDepth = 0.25; // how far the window zone extends into the room

  switch (win.wall) {
    case "bottom": {
      const winLeft = room.x + win.offset - win.width / 2;
      return { x: winLeft + win.width / 2, y: room.y + sillDepth / 2, halfW: win.width / 2, halfH: sillDepth / 2 };
    }
    case "top": {
      const winLeft = room.x + win.offset - win.width / 2;
      return { x: winLeft + win.width / 2, y: room.y + room.height - sillDepth / 2, halfW: win.width / 2, halfH: sillDepth / 2 };
    }
    case "left": {
      const winTop = room.y + win.offset - win.width / 2;
      return { x: room.x + sillDepth / 2, y: winTop + win.width / 2, halfW: sillDepth / 2, halfH: win.width / 2 };
    }
    case "right": {
      const winTop = room.y + win.offset - win.width / 2;
      return { x: room.x + room.width - sillDepth / 2, y: winTop + win.width / 2, halfW: sillDepth / 2, halfH: win.width / 2 };
    }
  }
}

/**
 * Build the combined list of obstruction zones (doors + windows) for a room.
 */
function getRoomObstructionZones(room: GeneratedRoom, allDoors: Door[], allWindows: Window[]): ObstructionZone[] {
  const dZones = allDoors
    .filter(d => d.room === room.name)
    .map(d => getDoorZone(d, room))
    .filter((z): z is ObstructionZone => z !== null);
  const wZones = allWindows
    .filter(w => w.room === room.name)
    .map(w => getWindowZone(w, room))
    .filter((z): z is ObstructionZone => z !== null);
  return [...dZones, ...wZones];
}

/**
 * Check if a furniture item overlaps any obstruction zone (door or window).
 */
function overlapsObstruction(
  itemX: number, itemY: number,
  itemHalfW: number, itemHalfH: number,
  zones: ObstructionZone[]
): boolean {
  const margin = 0.05;
  for (const zone of zones) {
    if (
      Math.abs(itemX - zone.x) < itemHalfW + zone.halfW + margin &&
      Math.abs(itemY - zone.y) < itemHalfH + zone.halfH + margin
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Smart placement: tries original position, polygon centroid, scaled down, rotated.
 * Returns the PlacedFurniture if any attempt fits, null otherwise.
 */
function smartPlace(
  itemId: string,
  room: GeneratedRoom,
  prefX: number, prefY: number,
  rotation: number,
  scale: number,
  existingItems: PlacedFurniture[],
  obstZones?: ObstructionZone[],
  logLabel?: string
): PlacedFurniture | null {
  const item = getFurnitureById(itemId);
  if (!item) return null;

  const centroid = getRoomCentroid(room);

  const positions = [
    { x: prefX, y: prefY, scale },
    { x: centroid.x, y: centroid.y, scale },
    { x: centroid.x, y: centroid.y, scale: scale * 0.8 },
    { x: centroid.x, y: centroid.y, scale: scale * 0.65 },
    { x: centroid.x, y: centroid.y, scale: scale * 0.5 },
    { x: centroid.x, y: centroid.y, scale: scale * 0.4 },
  ];

  for (const pos of positions) {
    for (const rot of [rotation, (rotation + 90) % 360]) {
      const isVertical = rot === 90 || rot === 270;
      const iw = (isVertical ? item.height : item.width) * pos.scale;
      const ih = (isVertical ? item.width : item.height) * pos.scale;

      if (!isFurnitureInBounds(pos.x, pos.y, iw, ih, room)) {
        if (logLabel) console.log(`[place:${logLabel}] rot=${rot}° pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) scale=${pos.scale.toFixed(2)} → OUT OF BOUNDS`);
        continue;
      }

      if (collidesWithExisting(pos.x, pos.y, iw, ih, room.name, existingItems, itemId)) {
        if (logLabel) console.log(`[place:${logLabel}] rot=${rot}° pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) scale=${pos.scale.toFixed(2)} → COLLISION`);
        continue;
      }

      // Check window/door obstruction zones
      if (obstZones && overlapsObstruction(pos.x, pos.y, iw / 2, ih / 2, obstZones)) {
        if (logLabel) console.log(`[place:${logLabel}] rot=${rot}° pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) scale=${pos.scale.toFixed(2)} → OBSTRUCTION (door/window)`);
        continue;
      }

      if (logLabel) console.log(`[place:${logLabel}] ✅ rot=${rot}° pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) scale=${pos.scale.toFixed(2)} w=${iw.toFixed(2)} h=${ih.toFixed(2)}`);
      return { itemId, room: room.name, x: pos.x, y: pos.y, rotation: rot as 0 | 90 | 180 | 270, scale: pos.scale };
    }
  }

  if (logLabel) console.log(`[place:${logLabel}] ❌ FAILED`);
  return null;
}

/** Place an item against a wall — tries positions along each wall, never falls back to centroid */
function wallPlace(
  itemId: string,
  room: GeneratedRoom,
  rotation: number,
  scale: number,
  existingItems: PlacedFurniture[]
): PlacedFurniture | null {
  const item = getFurnitureById(itemId);
  if (!item) return null;

  const rw = room.width, rh = room.height;
  const margin = 0.3;

  // Build wall-adjacent positions using ONLY the specified rotation
  const positions: Array<{ x: number; y: number; rot: number }> = [];
  const halfDepth = (rotation === 90 || rotation === 270 ? item.width : item.height) / 2;
  const halfLength = (rotation === 90 || rotation === 270 ? item.height : item.width) / 2;

  if (rotation === 0 || rotation === 180) {
    // Horizontal: top and bottom walls
    positions.push(
      { x: room.x + rw / 2, y: room.y + margin + halfDepth, rot: 0 },
      { x: room.x + rw / 2, y: room.y + rh - margin - halfDepth, rot: 0 },
    );
  }
  if (rotation === 90 || rotation === 270) {
    // Vertical: left and right walls
    positions.push(
      { x: room.x + margin + halfDepth, y: room.y + rh / 2, rot: 90 },
      { x: room.x + rw - margin - halfDepth, y: room.y + rh / 2, rot: 90 },
    );
  }
  // If rotation is something else, try both orientations
  if (positions.length === 0) {
    positions.push(
      { x: room.x + rw / 2, y: room.y + margin + item.height / 2, rot: 0 },
      { x: room.x + rw / 2, y: room.y + rh - margin - item.height / 2, rot: 0 },
      { x: room.x + margin + item.height / 2, y: room.y + rh / 2, rot: 90 },
      { x: room.x + rw - margin - item.height / 2, y: room.y + rh / 2, rot: 90 },
    );
  }

  const scales = [scale, scale * 0.85, scale * 0.7, scale * 0.55];
  for (const s of scales) {
    for (const pos of positions) {
      const iw = (pos.rot === 90 || pos.rot === 270 ? item.height : item.width) * s;
      const ih = (pos.rot === 90 || pos.rot === 270 ? item.width : item.height) * s;

      if (!isFurnitureInBounds(pos.x, pos.y, iw, ih, room)) continue;
      if (collidesWithExisting(pos.x, pos.y, iw, ih, room.name, existingItems, itemId)) continue;

      return { itemId, room: room.name, x: pos.x, y: pos.y, rotation: pos.rot as 0 | 90 | 180 | 270, scale: s };
    }
  }

  return null;
}

/** Get a point guaranteed to be inside the room's polygon (or rectangle center) */
function getRoomCentroid(room: GeneratedRoom): { x: number; y: number } {
  if (room.polygon && room.polygon.length >= 3) {
    // Try bounding box center first (works for most clipped polygons)
    const bcx = room.x + room.width / 2;
    const bcy = room.y + room.height / 2;
    if (pointInPolygon(bcx, bcy, room.polygon)) {
      return { x: bcx, y: bcy };
    }
    // Grid search within bounding box for an interior point
    for (let gx = 0.1; gx < 1; gx += 0.15) {
      for (let gy = 0.1; gy < 1; gy += 0.15) {
        const tx = room.x + room.width * gx;
        const ty = room.y + room.height * gy;
        if (pointInPolygon(tx, ty, room.polygon)) {
          return { x: tx, y: ty };
        }
      }
    }
    // Fallback: vertex average
    const cx = room.polygon.reduce((s, p) => s + p.x, 0) / room.polygon.length;
    const cy = room.polygon.reduce((s, p) => s + p.y, 0) / room.polygon.length;
    return { x: cx, y: cy };
  }
  return { x: room.x + room.width / 2, y: room.y + room.height / 2 };
}

/** Simple point-in-polygon test (local copy to avoid circular imports) */
function pointInPolygon(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Check if a new furniture item overlaps with any existing items in the same room */
function collidesWithExisting(
  x: number, y: number, w: number, h: number,
  roomName: string,
  existing: PlacedFurniture[],
  myItemId: string
): boolean {
  const margin = 0.05; // 5cm gap — tight but prevents true overlap
  const halfW = w / 2 + margin;
  const halfH = h / 2 + margin;

  for (const pf of existing) {
    if (pf.room !== roomName) continue;
    // Don't collision-check against items in the same functional group
    // (kitchen items can be adjacent, bathroom items can be adjacent)
    if (sameGroup(myItemId, pf.itemId)) continue;

    const item = getFurnitureById(pf.itemId);
    // Virtual obstacle blocks the entire ensuite area
    if (!item && pf.itemId === "__ensuite_obstacle__") {
      const obsHalfW = 1.0 + margin; // ensuite half-width (2m wide)
      const obsHalfH = 1.25 + margin; // ensuite half-height (2.5m tall)
      if (Math.abs(x - pf.x) < halfW + obsHalfW && Math.abs(y - pf.y) < halfH + obsHalfH) {
        return true;
      }
      continue;
    }
    if (!item) continue;

    const ew = item.width * pf.scale;
    const eh = item.height * pf.scale;
    const eHalfW = ew / 2 + margin;
    const eHalfH = eh / 2 + margin;

    if (
      Math.abs(pf.x - x) < halfW + eHalfW &&
      Math.abs(pf.y - y) < halfH + eHalfH
    ) {
      return true;
    }
  }
  return false;
}

/** Items in the same functional group can be placed adjacent (no collision check between them) */
function sameGroup(id1: string, id2: string): boolean {
  const kitchenItems = ["kitchen-counter", "stove", "refrigerator", "kitchen-sink"]; // island excluded — must not overlap counter
  const bathItems = ["toilet", "sink-bathroom", "bathtub", "shower"];
  const livingItems = ["sofa", "coffee-table", "tv-unit", "armchair", "side-table", "rug-large"];
  const bedItems = ["bed-", "side-table", "rug-large"]; // wardrobe intentionally excluded — must not overlap bed

  const groups = [kitchenItems, bathItems, livingItems, bedItems];
  for (const group of groups) {
    const m1 = group.some(prefix => id1.includes(prefix));
    const m2 = group.some(prefix => id2.includes(prefix));
    if (m1 && m2) return true; // same group, allow adjacency
  }
  return false;
}

/**
 * Place furniture into rooms based on room type and dimensions.
 * Returns an array of placed furniture items with world-space coordinates.
 * Doors are used to avoid placing furniture in door swing paths.
 */
export function suggestFurniture(rooms: GeneratedRoom[], doors: Door[] = [], windows: Window[] = []): PlacedFurniture[] {
  const placed: PlacedFurniture[] = [];

  // Pre-compute obstruction zones per room (doors + windows)
  const obstructionZonesByRoom = new Map<string, ObstructionZone[]>();
  for (const room of rooms) {
    obstructionZonesByRoom.set(room.name, getRoomObstructionZones(room, doors, windows));
  }

  // Sort: ensuite first (so master bedroom furniture can avoid it), then others
  const sortedRooms = [...rooms].sort((a, b) => {
    const aEnsuite = /ensuite/i.test(a.name) ? 0 : 1;
    const bEnsuite = /ensuite/i.test(b.name) ? 0 : 1;
    return aEnsuite - bEnsuite;
  });

  for (const room of sortedRooms) {
    const candidates = getFurnitureForRoom(room.name);
    if (candidates.length === 0) continue;

    // Room center
    const cx = room.x + room.width / 2;
    const cy = room.y + room.height / 2;

    // Room dimensions in meters
    const rw = room.width;
    const rh = room.height;
    const minDim = Math.min(rw, rh);
    const roomArea = room.area;

    const name = room.name.toLowerCase();

    /* ---- LIVING ROOM (door-aware) ---- */
    if (/living|lounge|family|media/i.test(name)) {
      const obstZones = obstructionZonesByRoom.get(room.name) || [];

      // Determine which walls have doors or windows (furniture should avoid both)
      const hasBottomObst = obstZones.some(z => Math.abs(z.y - (room.y + z.halfH)) < 0.3);
      const hasTopObst = obstZones.some(z => Math.abs(z.y - (room.y + room.height - z.halfH)) < 0.3);
      const hasLeftObst = obstZones.some(z => Math.abs(z.x - (room.x + z.halfW)) < 0.3);
      const hasRightObst = obstZones.some(z => Math.abs(z.x - (room.x + room.width - z.halfW)) < 0.3);

      // TV placement: avoid walls with doors, prefer a wall without doors
      // Default: TV on bottom wall (y = rh * 0.12), sofa on top wall (y = rh * 0.72)
      let tvY = room.y + rh * 0.12;
      let tvWall = "bottom";

      if (hasBottomObst && !hasTopObst) {
        // Bottom has door → TV on top, sofa on bottom
        tvY = room.y + rh * 0.88;
        tvWall = "top";
      } else if (hasBottomObst && hasTopObst) {
        // Both top and bottom have doors → try side walls
        if (!hasLeftObst) {
          // TV on left wall, sofa on right
          tvWall = "left";
        } else if (!hasRightObst) {
          // TV on right wall, sofa on left
          tvWall = "right";
        }
        // If all walls have doors, default to bottom (best effort)
      }

      // Sofa — place opposite the TV
      const sofa = getFurnitureById("sofa-3-seater");
      if (sofa && rw >= sofa.width + 0.3) {
        if (tvWall === "bottom") {
          placed.push({
            itemId: "sofa-3-seater",
            room: room.name,
            x: cx,
            y: room.y + rh * 0.72,
            rotation: 0,
            scale: 1.0,
          });
        } else if (tvWall === "top") {
          placed.push({
            itemId: "sofa-3-seater",
            room: room.name,
            x: cx,
            y: room.y + rh * 0.28,
            rotation: 0,
            scale: 1.0,
          });
        } else if (tvWall === "left") {
          placed.push({
            itemId: "sofa-3-seater",
            room: room.name,
            x: room.x + room.width * 0.75,
            y: cy,
            rotation: 90,
            scale: 1.0,
          });
        } else if (tvWall === "right") {
          placed.push({
            itemId: "sofa-3-seater",
            room: room.name,
            x: room.x + room.width * 0.25,
            y: cy,
            rotation: 270,
            scale: 1.0,
          });
        }
      }

      // Coffee table — between sofa and TV
      if (roomArea >= 15) {
        const coffeeY = tvWall === "bottom"
          ? room.y + rh * 0.45
          : tvWall === "top"
            ? room.y + rh * 0.55
            : cy;
        const coffeeX = tvWall === "left"
          ? room.x + room.width * 0.45
          : tvWall === "right"
            ? room.x + room.width * 0.55
            : cx;
        placed.push({
          itemId: "coffee-table",
          room: room.name,
          x: coffeeX,
          y: coffeeY,
          rotation: 0,
          scale: 1.0,
        });
      }

      // TV unit — place on the wall opposite to door, or best available wall
      if (rw >= 1.5 || rh >= 1.5) {
        let tvX = cx;
        let tvRot: 0 | 90 | 180 | 270 = 0;

        if (tvWall === "bottom") {
          tvX = cx;
          tvY = room.y + rh * 0.12;
          tvRot = 0;
        } else if (tvWall === "top") {
          tvX = cx;
          tvY = room.y + rh * 0.88;
          tvRot = 0;
        } else if (tvWall === "left") {
          tvX = room.x + room.width * 0.12;
          tvY = cy;
          tvRot = 90;
        } else {
          // right
          tvX = room.x + room.width * 0.88;
          tvY = cy;
          tvRot = 270;
        }

        placed.push({
          itemId: "tv-unit",
          room: room.name,
          x: tvX,
          y: tvY,
          rotation: tvRot,
          scale: 1.0,
        });
      }

      // Armchairs for larger rooms
      if (roomArea >= 25) {
        if (tvWall === "bottom" || tvWall === "top") {
          placed.push({
            itemId: "armchair",
            room: room.name,
            x: room.x + rw * 0.15,
            y: room.y + rh * 0.45,
            rotation: 270,
            scale: 1.0,
          });
          placed.push({
            itemId: "armchair",
            room: room.name,
            x: room.x + rw * 0.85,
            y: room.y + rh * 0.45,
            rotation: 90,
            scale: 1.0,
          });
        }
      }

      // Rug under coffee table for larger rooms
      if (roomArea >= 22) {
        const rugY = tvWall === "bottom"
          ? room.y + rh * 0.48
          : tvWall === "top"
            ? room.y + rh * 0.52
            : cy;
        placed.push({
          itemId: "rug-large",
          room: room.name,
          x: cx,
          y: rugY,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Side tables — near sofa, not near doors
      if (rw >= 3 && (tvWall === "bottom" || tvWall === "top")) {
        const sofaSide = tvWall === "bottom" ? rh * 0.7 : rh * 0.3;
        placed.push({
          itemId: "side-table",
          room: room.name,
          x: room.x + rw * 0.12,
          y: room.y + sofaSide,
          rotation: 0,
          scale: 1.0,
        });
        placed.push({
          itemId: "side-table",
          room: room.name,
          x: room.x + rw * 0.88,
          y: room.y + sofaSide,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Plant — place in a corner without a door
      if (roomArea >= 20 && rw >= 3) {
        // Find a corner without a door obstruction zone
        const plantCorners = [
          { x: room.x + rw * 0.08, y: room.y + rh * 0.12, label: "bottom-left" },
          { x: room.x + rw * 0.92, y: room.y + rh * 0.12, label: "bottom-right" },
          { x: room.x + rw * 0.08, y: room.y + rh * 0.88, label: "top-left" },
          { x: room.x + rw * 0.92, y: room.y + rh * 0.88, label: "top-right" },
        ];
        const plantItem = getFurnitureById("plant-indoor");
        const plantHalf = plantItem ? plantItem.width / 2 : 0.2;
        const bestCorner = plantCorners.find(c =>
          !overlapsObstruction(c.x, c.y, plantHalf, plantHalf, obstZones)
        ) || plantCorners[0];

        placed.push({
          itemId: "plant-indoor",
          room: room.name,
          x: bestCorner.x,
          y: bestCorner.y,
          rotation: 0,
          scale: 1.0,
        });
      }
    }

    /* ---- DINING ROOM — guaranteed table + chairs that fit ---- */
    if (/dining/i.test(name)) {
      // Scale table based on room size
      const tableId = roomArea >= 20 ? "dining-table-6" : "dining-table-4";
      const tableScale = roomArea < 8 ? 0.65 : roomArea < 12 ? 0.8 : 1.0;
      const table = getFurnitureById(tableId);
      if (table) {
        placed.push({
          itemId: tableId,
          room: room.name,
          x: cx,
          y: cy,
          rotation: rw > rh ? 0 : 90,
          scale: tableScale,
        });

        // Chairs around the table — only place those that fit in the room
        const maxChairs = tableId === "dining-table-6" ? 6 : 4;
        // Small rooms get fewer chairs
        const targetChairs = roomArea < 8 ? 2 : roomArea < 14 ? 4 : maxChairs;
        const tw = table.width * tableScale;
        const th = table.height * tableScale;
        let chairsPlaced = 0;

        for (let i = 0; i < maxChairs && chairsPlaced < targetChairs; i++) {
          const angle = (i / maxChairs) * Math.PI * 2 - Math.PI / 2;
          const dist = Math.max(tw, th) * 0.55;
          const cx2 = cx + Math.cos(angle) * dist;
          const cy2 = cy + Math.sin(angle) * dist;

          // Only place chair if it fits in room bounds
          if (pointInRoomBounds(cx2, cy2, room)) {
            placed.push({
              itemId: "dining-chair",
              room: room.name,
              x: cx2,
              y: cy2,
              rotation: 0,
              scale: tableScale,
            });
            chairsPlaced++;
          }
        }
      }
    }

    /* ---- BEDROOM — guaranteed bed + wardrobe ---- */
    if (/bedroom|master|guest|kids/i.test(name) && !/bathroom|ensuite/i.test(name)) {
      const isMaster = /master/i.test(name);

      // If master bedroom has an ensuite inside it, block that area as an obstacle
      if (isMaster) {
        const ensuiteRoom = rooms.find(r => /ensuite/i.test(r.name));
        if (ensuiteRoom) {
          // Add a virtual obstacle covering the entire ensuite rectangle
          // so master bedroom furniture can't be placed there
          placed.push({
            itemId: "__ensuite_obstacle__",
            room: room.name,
            x: ensuiteRoom.x + ensuiteRoom.width / 2,
            y: ensuiteRoom.y + ensuiteRoom.height / 2,
            rotation: 0,
            scale: 1.0,
          });
        }
      }

      const bedId = isMaster ? "bed-queen" : roomArea >= 14 ? "bed-double" : "bed-single";
      const bed = getFurnitureById(bedId);

      // Always place a bed — scale down if room is very small
      let bedY = cy;
      let bedH = 0;
      if (bed) {
        const bedScale = roomArea < 9 ? 0.75 : 1.0;
        const bedX = cx;
        bedY = room.y + (bed.height * bedScale) / 2 + 0.15;
        bedH = (rw > rh ? bed.height : bed.width) * bedScale;
        placed.push({
          itemId: bedId,
          room: room.name,
          x: bedX,
          y: bedY,
          rotation: rw > rh ? 0 : 90,
          scale: bedScale,
        });

        // Side tables flanking the headboard (pillow side)
        const bedRot = rw > rh ? 0 : 90;
        const bedW = (bedRot === 0 ? bed.width : bed.height) * bedScale;
        // Head position: for rot=0, head is at higher y; for rot=90, head is at lower x
        const headX = bedRot === 0 ? bedX : bedX - bedH / 2 - 0.3;
        const headY = bedRot === 0 ? bedY + bedH * 0.25 : bedY;
        // Place one side table at the head (pillow side)
        const st1X = bedRot === 0 ? bedX - bedW / 2 - 0.3 : headX;
        const st1Y = bedRot === 0 ? headY : bedY - bedW / 2 - 0.3;
        placed.push({
          itemId: "side-table", room: room.name,
          x: st1X, y: st1Y, rotation: 0, scale: bedScale,
        });
        // Second side table if room is large enough
        if (roomArea >= 12) {
          const st2X = bedRot === 0 ? bedX + bedW / 2 + 0.3 : headX;
          const st2Y = bedRot === 0 ? headY : bedY + bedW / 2 + 0.3;
          placed.push({
            itemId: "side-table", room: room.name,
            x: st2X, y: st2Y, rotation: 0, scale: bedScale,
          });
        }
      }

      // Wardrobe — always against a wall, never in the middle of the room.
      // Try right wall first (opposite typical bed position), then left wall, then top.
      const wardScale = minDim >= 3 ? 1.0 : 0.8;
      let wardResult = wallPlace("wardrobe", room, 0, wardScale, placed);
      if (!wardResult) wardResult = wallPlace("wardrobe", room, 90, wardScale, placed);
      if (!wardResult) wardResult = wallPlace("wardrobe", room, 180, wardScale, placed);
      if (!wardResult) {
        // Last resort: smartPlace against any wall
        wardResult = smartPlace("wardrobe", room, room.x + rw - 0.5, room.y + rh - 0.5, 0, wardScale, placed,
          obstructionZonesByRoom.get(room.name), "wardrobe");
      }
      if (wardResult) placed.push(wardResult);

      // Rug at foot of bed — past the foot, never overlapping the mattress
      if (bed && roomArea >= 14) {
        const rugItem = getFurnitureById("rug-large");
        const rugHalfH = rugItem ? (rugItem.height * 0.8) / 2 : 0.56; // rug half-height at scale 0.8
        placed.push({
          itemId: "rug-large",
          room: room.name,
          x: cx,
          y: bedY + bedH * 0.5 + rugHalfH + 0.2,
          rotation: 0,
          scale: 0.8,
        });
      }

      // Desk for master or larger bedrooms
      if (roomArea >= 14 && rw >= 2 && rh >= 2.5) {
        placed.push({
          itemId: "desk",
          room: room.name,
          x: room.x + 0.9,
          y: room.y + rh - 0.5,
          rotation: 0,
          scale: 0.9,
        });
        placed.push({
          itemId: "office-chair",
          room: room.name,
          x: room.x + 0.9,
          y: room.y + rh - 1.0,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Plant
      if (minDim >= 2.5) {
        placed.push({
          itemId: "plant-indoor",
          room: room.name,
          x: room.x + 0.3,
          y: room.y + 0.3,
          rotation: 0,
          scale: 1.0,
        });
      }
    }

    /* ---- KITCHEN — wall counter or island fallback, avoiding passage wall ---- */
    if (/kitchen/i.test(name)) {
      const roomDoors = doors.filter(d => d.room === room.name);
      const livingRoomDoor = roomDoors.find(d => d.width >= 0.8);
      const passageWall: Door["wall"] | null = livingRoomDoor?.wall ?? null;

      // Counter wall: opposite the passage, or bottom by default
      const counterWall: Door["wall"] = passageWall === "bottom" ? "top"
        : passageWall === "top" ? "bottom"
        : passageWall === "left" ? "right"
        : passageWall === "right" ? "left"
        : "bottom";

      const margin = 0.4;
      let cX: number, cY: number, cRot: number;
      if (counterWall === "bottom")      { cX = cx; cY = room.y + margin; cRot = 0; }
      else if (counterWall === "top")     { cX = cx; cY = room.y + rh - margin; cRot = 0; }
      else if (counterWall === "left")    { cX = room.x + margin; cY = cy; cRot = 90; }
      else /* right */                    { cX = room.x + rw - margin; cY = cy; cRot = 90; }

      const counterId = roomArea < 8 ? "kitchen-counter-small" : "kitchen-counter-straight";
      const counterScale = roomArea < 8 ? 0.85 : 0.9;
      const cResult = smartPlace(counterId, room, cX, cY, cRot, counterScale, placed, obstructionZonesByRoom.get(room.name), "kitchen-counter");

      if (cResult) {
        // Wall counter fits — stove and sink are built into the counter rendering
        placed.push(cResult);
      } else if (roomArea >= 10 && rw >= 2.5 && rh >= 2.5) {
        // Counter doesn't fit on wall — place island with stove + sink on top
        console.log(`[kitchen] counter didn't fit on ${counterWall} wall — placing island`);
        const islandResult = smartPlace("kitchen-island", room, cx, cy, rw > rh ? 0 : 90, 0.9, placed, obstructionZonesByRoom.get(room.name), "island");
        if (islandResult) {
          // Stove and sink are built into the island rendering
          placed.push(islandResult);
        }
      }

      // Refrigerator — corner opposite the counter wall (or any free corner)
      if (rw >= 2 && rh >= 2) {
        const fX = counterWall === "right" ? room.x + 0.6
          : counterWall === "left" ? room.x + rw - 0.6
          : room.x + rw - 0.6;
        const fY = counterWall === "bottom" ? room.y + rh - 0.6
          : counterWall === "top" ? room.y + 0.6
          : room.y + rh - 0.6;
        const fResult = smartPlace("refrigerator", room, fX, fY, 0, 1.0, placed);
        if (fResult) placed.push(fResult);
      }

      // Island for larger kitchens — only if wall counter was placed (not island fallback)
      if (cResult && roomArea >= 14 && rw >= 3 && rh >= 3) {
        const extraIsland = smartPlace("kitchen-island", room, cx, cy, rw > rh ? 0 : 90, 0.85, placed,
          obstructionZonesByRoom.get(room.name), "extra-island");
        if (extraIsland) placed.push(extraIsland);
      }

      // Dining nook — only if table fits via smartPlace, then chairs
      if (roomArea >= 16 && rw >= 3 && rh >= 3.5) {
        const tableResult = smartPlace("dining-table-4", room,
          room.x + rw * 0.25, room.y + rh * 0.75, 0, 0.85, placed,
          obstructionZonesByRoom.get(room.name), "dining-table");
        if (tableResult) {
          placed.push(tableResult);
          const tX = tableResult.x, tY = tableResult.y;
          for (let i = 0; i < 4; i++) {
            const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
            const cx2 = tX + Math.cos(angle) * 0.5;
            const cy2 = tY + Math.sin(angle) * 0.5;
            if (pointInRoomBounds(cx2, cy2, room)) {
              placed.push({
                itemId: "dining-chair", room: room.name,
                x: cx2, y: cy2, rotation: 0, scale: 0.85,
              });
            }
          }
        }
      }
    }

    /* ---- BATHROOM — spaced fixtures, no overlap ---- */
    if (/bathroom|ensuite|powder|wc/i.test(name)) {
      const isLarge = roomArea >= 6;

      // Toilet — back-left corner (cistern against back wall)
      placed.push({
        itemId: "toilet",
        room: room.name,
        x: room.x + rw * 0.22,
        y: room.y + rh * 0.22,
        rotation: 0,
        scale: 1.0,
      });

      // Sink — opposite side from toilet
      placed.push({
        itemId: "sink-bathroom",
        room: room.name,
        x: room.x + rw * 0.78,
        y: room.y + rh * 0.2,
        rotation: 0,
        scale: 1.0,
      });

      // Bathtub or shower — placed along back wall, to the right, AWAY from toilet
      if (isLarge) {
        placed.push({
          itemId: "bathtub",
          room: room.name,
          x: room.x + rw * 0.75,
          y: room.y + rh * 0.72,
          rotation: 0,
          scale: 0.9,
        });
      } else {
        placed.push({
          itemId: "shower",
          room: room.name,
          x: room.x + rw * 0.72,
          y: room.y + rh * 0.68,
          rotation: 0,
          scale: 0.85,
        });
      }
    }

    /* ---- OFFICE / STUDY ---- */
    if (/office|study/i.test(name)) {
      placed.push({
        itemId: "desk",
        room: room.name,
        x: cx,
        y: room.y + rh * 0.35,
        rotation: 0,
        scale: 1.0,
      });
      placed.push({
        itemId: "office-chair",
        room: room.name,
        x: cx,
        y: room.y + rh * 0.6,
        rotation: 0,
        scale: 1.0,
      });
      if (rw >= 2) {
        placed.push({
          itemId: "bookshelf",
          room: room.name,
          x: room.x + rw - 0.5,
          y: room.y + rh * 0.5,
          rotation: 90,
          scale: 1.0,
        });
      }
      if (minDim >= 2) {
        placed.push({
          itemId: "plant-indoor",
          room: room.name,
          x: room.x + 0.3,
          y: room.y + rh - 0.3,
          rotation: 0,
          scale: 1.0,
        });
      }
    }

    /* ---- HALLWAY / CORRIDOR ---- */
    if (/hallway|corridor|foyer/i.test(name)) {
      if (minDim >= 1.2 && roomArea >= 4) {
        placed.push({
          itemId: "plant-indoor",
          room: room.name,
          x: rw > rh ? room.x + rw * 0.85 : cx,
          y: rw > rh ? cy : room.y + rh * 0.1,
          rotation: 0,
          scale: 0.8,
        });
      }
      if (rw >= 1.5 || rh >= 1.5) {
        placed.push({
          itemId: "cabinet",
          room: room.name,
          x: rw > rh ? room.x + rw * 0.15 : cx,
          y: rw > rh ? cy : room.y + rh * 0.85,
          rotation: rw > rh ? 0 : 90,
          scale: 0.7,
        });
      }
    }

    /* ---- PORCH / BALCONY ---- */
    if (/porch|veranda|terrace|balcony/i.test(name)) {
      if (roomArea >= 6) {
        placed.push({
          itemId: "outdoor-table",
          room: room.name,
          x: cx,
          y: cy,
          rotation: 0,
          scale: 1.0,
        });
        // Outdoor chairs
        for (let i = 0; i < 4; i++) {
          const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
          placed.push({
            itemId: "outdoor-chair",
            room: room.name,
            x: cx + Math.cos(angle) * 0.55,
            y: cy + Math.sin(angle) * 0.55,
            rotation: 0,
            scale: 1.0,
          });
        }
      }
    }

    /* ---- GARAGE ---- */
    if (/garage/i.test(name)) {
      // No furniture in garage typically, just structure
    }

    /* ---- LAUNDRY ---- */
    if (/laundry/i.test(name)) {
      placed.push({
        itemId: "kitchen-counter-straight",
        room: room.name,
        x: cx,
        y: room.y + 0.3,
        rotation: 0,
        scale: 0.7,
      });
      placed.push({
        itemId: "cabinet",
        room: room.name,
        x: room.x + rw * 0.15,
        y: room.y + rh * 0.75,
        rotation: 0,
        scale: 0.8,
      });
    }
  }

  // ── Post-validation: keep essentials, try to fix out-of-bounds items ──
  const roomMap = new Map(rooms.map(r => [r.name, r]));
  const essentialIds = new Set([
    "bed-single", "bed-double", "bed-queen", "bed-king",
    "dining-table-4", "dining-table-6",
    "toilet", "sink-bathroom", "shower",
    "stove-4-burner", "refrigerator", "kitchen-sink",
    "kitchen-counter-straight", "kitchen-counter-small", "kitchen-counter-corner", "kitchen-island",
    "wardrobe", "desk",
    // Living room core: sofa + rug + TV are the highest-priority decor items
    "sofa-3-seater", "sofa-2-seater", "tv-unit", "rug-large",
  ]);
  // Note: "bathtub" NOT in essentialIds — it gets full bounds check;
  // if it doesn't fit even after smartPlace, shower is substituted below

  // Items that MUST appear — if smartPlace fails, compute fitting scale
  const forceItems = new Set([
    "kitchen-counter-straight", "kitchen-counter-small", "stove-4-burner",
    "toilet", "kitchen-sink", "kitchen-island",
    // Living room core items always appear
    "sofa-3-seater", "sofa-2-seater", "tv-unit", "rug-large",
  ]);

  const validated: PlacedFurniture[] = [];

  for (const pf of placed) {
    const room = roomMap.get(pf.room);
    if (!room) continue;
    const item = getFurnitureById(pf.itemId);
    // Allow virtual obstacles to pass through for collision blocking
    if (!item && pf.itemId === "__ensuite_obstacle__") {
      validated.push(pf);
      continue;
    }
    if (!item) continue;

    // Check current placement — swap w/h for 90°/270° rotation
    const isRotated = pf.rotation === 90 || pf.rotation === 270;
    const iw = (isRotated ? item.height : item.width) * pf.scale;
    const ih = (isRotated ? item.width : item.height) * pf.scale;
    const fits = isFurnitureInBounds(pf.x, pf.y, iw, ih, room);
    const collides = fits && collidesWithExisting(pf.x, pf.y, iw, ih, pf.room, validated, pf.itemId);
    // Check door zone overlap (non-essential items should avoid door swing paths)
    const roomObstZones = obstructionZonesByRoom.get(pf.room) || [];
    const inObstZone = fits && !collides && overlapsObstruction(pf.x, pf.y, iw / 2, ih / 2, roomObstZones);

    if (fits && !collides && !inObstZone) {
      validated.push(pf);
      continue;
    }

    // Log rejection reason
    if (!fits) console.log(`[validate] ${pf.itemId} in "${pf.room}" → OUT OF BOUNDS (pos=${pf.x.toFixed(1)},${pf.y.toFixed(1)} rot=${pf.rotation}° scale=${pf.scale.toFixed(2)})`);
    else if (collides) console.log(`[validate] ${pf.itemId} in "${pf.room}" → COLLISION with existing`);
    else if (inObstZone) console.log(`[validate] ${pf.itemId} in "${pf.room}" → IN OBSTRUCTION ZONE (door/window)`);

    // In obstruction zone but fits otherwise — for forceItems, accept as-is
    // for other essentials, try smartPlace; skip non-essentials
    if (inObstZone && fits && !collides) {
      if (forceItems.has(pf.itemId)) {
        // Core item: keep it even in a door zone — placement was already optimized
        validated.push(pf);
        continue;
      }
      if (essentialIds.has(pf.itemId)) {
        const fixed = smartPlace(pf.itemId, room, pf.x, pf.y, pf.rotation, pf.scale, validated, roomObstZones);
        if (fixed) {
          validated.push(fixed);
          continue;
        }
      }
      // Non-essential item in door zone: skip it silently
      continue;
    }

    // Doesn't fit — try smartPlace for essentials (tries smaller scales too)
    if (essentialIds.has(pf.itemId)) {
      const fixed = smartPlace(pf.itemId, room, pf.x, pf.y, pf.rotation, pf.scale, validated, roomObstZones);
      if (fixed) {
        validated.push(fixed);
      } else if (forceItems.has(pf.itemId)) {
        // MUST appear: compute the max scale that fits at room center
        const guaranteed = guaranteedPlace(pf.itemId, room, validated);
        if (guaranteed) validated.push(guaranteed);
      }
    } else if (pf.itemId === "bathtub") {
      // Bathtub doesn't fit — try a shower instead
      const showerFix = smartPlace("shower", room, pf.x, pf.y, pf.rotation, 0.9, validated);
      if (showerFix) {
        validated.push(showerFix);
      }
    }
    // Non-essential items that don't fit: just skip them
  }

  return validated;
}

/**
 * Guaranteed placement: finds the maximum scale that fits at room center.
 * Only for truly critical items (toilet, kitchen counter, stove).
 */
function guaranteedPlace(
  itemId: string,
  room: GeneratedRoom,
  existing: PlacedFurniture[]
): PlacedFurniture | null {
  const item = getFurnitureById(itemId);
  if (!item) return null;

  const centroid = getRoomCentroid(room);

  // Try scales from 100% down to 25% in steps
  for (const scale of [1.0, 0.85, 0.7, 0.55, 0.4, 0.3, 0.25]) {
    for (const rot of [0, 90]) {
      const iw = (rot === 0 ? item.width : item.height) * scale;
      const ih = (rot === 0 ? item.height : item.width) * scale;

      if (isFurnitureInBounds(centroid.x, centroid.y, iw, ih, room) &&
          !collidesWithExisting(centroid.x, centroid.y, iw, ih, room.name, existing, itemId)) {
        return { itemId, room: room.name, x: centroid.x, y: centroid.y, rotation: rot as 0 | 90 | 180 | 270, scale };
      }
    }
  }

  // Absolute last resort: 20% scale
  const minScale = 0.2;
  return {
    itemId,
    room: room.name,
    x: centroid.x,
    y: centroid.y,
    rotation: 0,
    scale: minScale,
  };
}

/** Quick check: is a point inside a room's area (polygon or rectangle)? */
function pointInRoomBounds(px: number, py: number, room: GeneratedRoom): boolean {
  if (room.polygon && room.polygon.length >= 3) {
    let inside = false;
    const poly = room.polygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  return px >= room.x && px <= room.x + room.width &&
         py >= room.y && py <= room.y + room.height;
}
