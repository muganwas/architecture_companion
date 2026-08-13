/* ------------------------------------------------------------------ */
/*  Furniture Placer — intelligently places furniture in rooms         */
/*  Based on room type, size, and furniture dimensions                 */
/*                                                                     */
/*  WALL-PLACEMENT ORIENTATION CONTRACT:                               */
/*  For any object with its "back" at local y=0 (headboard, cistern,   */
/*  wardrobe back, etc.) placed against a wall:                        */
/*                                                                     */
/*    rot=0:   local y=0 → worldY = centerY + halfH   (TOP wall)       */
/*    rot=180: local y=0 → worldY = centerY - halfH   (BOTTOM wall)    */
/*    rot=270: local y=0 → worldX = centerX - halfH   (LEFT wall)      */
/*    rot=90:  local y=0 → worldX = centerX + halfH   (RIGHT wall)     */
/*                                                                     */
/*  Center position: wallEdge ± halfH ± margin                        */
/*    TOP:    centerY = room.y + room.height - halfH - margin           */
/*    BOTTOM: centerY = room.y + halfH + margin                         */
/*    LEFT:   centerX = room.x + halfH + margin                         */
/*    RIGHT:  centerX = room.x + room.width - halfH - margin            */
/*                                                                     */
/*  Tests in src/lib/__tests__/wallOrientation.ts enforce this.        */
/* ------------------------------------------------------------------ */

import { GeneratedRoom, Door, Window } from "./ai-client";
import { PlacedFurniture, FurnitureItem, FurnitureOrientation } from "./furniture";
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
 * Extra keep-clear margin added along the wall on each side of a door.
 * The enforcement zones must match the yellow/blue overlay rectangles
 * exactly (span = door width + 2 × DOOR_ALONG_MARGIN).
 */
const DOOR_ALONG_MARGIN = 0.2;

/**
 * Compute the obstruction zone for a door's swing path.
 * Swing side (inside door.room when swing="in"): 0.7m into the room;
 * swing="out" swaps the sides (0.3m inside). The along-wall span is the
 * door width plus DOOR_ALONG_MARGIN on each side — identical to the
 * yellow/blue clearance rectangles shown on the canvas.
 */
function getDoorZone(door: Door, room: GeneratedRoom): ObstructionZone | null {
  const depth = door.swing === "in" ? 0.7 : 0.3;
  const alongHalf = door.width / 2 + DOOR_ALONG_MARGIN;

  switch (door.wall) {
    case "bottom": {
      const doorLeft = room.x + door.offset - door.width / 2;
      return { x: doorLeft + door.width / 2, y: room.y + depth / 2, halfW: alongHalf, halfH: depth / 2 };
    }
    case "top": {
      const doorLeft = room.x + door.offset - door.width / 2;
      return { x: doorLeft + door.width / 2, y: room.y + room.height - depth / 2, halfW: alongHalf, halfH: depth / 2 };
    }
    case "left": {
      const doorTop = room.y + door.offset - door.width / 2;
      return { x: room.x + depth / 2, y: doorTop + door.width / 2, halfW: depth / 2, halfH: alongHalf };
    }
    case "right": {
      const doorTop = room.y + door.offset - door.width / 2;
      return { x: room.x + room.width - depth / 2, y: doorTop + door.width / 2, halfW: depth / 2, halfH: alongHalf };
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

/** A door clearance rectangle in world coordinates (for visualization). */
export interface DoorClearanceRect {
  room: string;
  /** Swing side (yellow) or opposite-side access strip (blue). */
  side: "swing" | "opposite";
  x: number;   // left edge (world)
  y: number;   // bottom edge (world)
  width: number;
  height: number;
}

/**
 * Visual door clearance rectangles.
 *  - Swing side: 0.7m into the room (the door's swing arc) — yellow dotted.
 *  - Opposite side: 0.3m access strip on the other side of the wall — blue dotted.
 *  (Swing="out" swaps the depths.) Width = door width + 0.2m on each side.
 */
export function getDoorClearanceRects(
  rooms: GeneratedRoom[],
  doors: Door[]
): DoorClearanceRect[] {
  const swingDepth = (door: Door) => (door.swing === "in" ? 0.7 : 0.3);
  const oppositeDepth = (door: Door) => (door.swing === "in" ? 0.3 : 0.7);
  const roomMap = new Map(rooms.map(r => [r.name, r]));
  const rects: DoorClearanceRect[] = [];

  for (const door of doors) {
    const room = roomMap.get(door.room);
    if (!room) continue;

    const span = door.width + DOOR_ALONG_MARGIN * 2;
    const dSwing = swingDepth(door);
    const dOpp = oppositeDepth(door);

    switch (door.wall) {
      case "bottom":
        rects.push(
          { room: room.name, side: "swing", x: room.x + door.offset - span / 2, y: room.y, width: span, height: dSwing },
          { room: room.name, side: "opposite", x: room.x + door.offset - span / 2, y: room.y - dOpp, width: span, height: dOpp },
        );
        break;
      case "top":
        rects.push(
          { room: room.name, side: "swing", x: room.x + door.offset - span / 2, y: room.y + room.height - dSwing, width: span, height: dSwing },
          { room: room.name, side: "opposite", x: room.x + door.offset - span / 2, y: room.y + room.height, width: span, height: dOpp },
        );
        break;
      case "left":
        rects.push(
          { room: room.name, side: "swing", x: room.x, y: room.y + door.offset - span / 2, width: dSwing, height: span },
          { room: room.name, side: "opposite", x: room.x - dOpp, y: room.y + door.offset - span / 2, width: dOpp, height: span },
        );
        break;
      case "right":
        rects.push(
          { room: room.name, side: "swing", x: room.x + room.width - dSwing, y: room.y + door.offset - span / 2, width: dSwing, height: span },
          { room: room.name, side: "opposite", x: room.x + room.width, y: room.y + door.offset - span / 2, width: dOpp, height: span },
        );
        break;
    }
  }
  return rects;
}

/**
 * Mirror a door/window wall segment into a room that shares that wall.
 * A door/window belongs to one room in the data model, but the opening it
 * creates is physical — the room on the other side of the shared wall must
 * also keep that opening clear (otherwise its furniture blocks the doorway).
 */
function mirrorWallSegment(
  owner: GeneratedRoom,
  other: GeneratedRoom,
  seg: { wall: Door["wall"]; offset: number; spanHalf: number; depthHalf: number }
): ObstructionZone | null {
  const WALL_TOL = 0.3; // wall-coincidence tolerance for float slop

  if (seg.wall === "bottom" || seg.wall === "top") {
    const ownerWallY = seg.wall === "bottom" ? owner.y : owner.y + owner.height;
    const centerX = owner.x + seg.offset;
    const along = centerX - other.x;
    // Opening span must intersect the other room's wall segment
    if (along - seg.spanHalf >= other.width || along + seg.spanHalf <= 0) return null;

    if (Math.abs(other.y + other.height - ownerWallY) < WALL_TOL) {
      // other is BELOW owner → opening sits on other's TOP wall
      return {
        x: other.x + along,
        y: other.y + other.height - seg.depthHalf,
        halfW: seg.spanHalf,
        halfH: seg.depthHalf,
      };
    }
    if (Math.abs(other.y - ownerWallY) < WALL_TOL) {
      // other is ABOVE owner → opening sits on other's BOTTOM wall
      return {
        x: other.x + along,
        y: other.y + seg.depthHalf,
        halfW: seg.spanHalf,
        halfH: seg.depthHalf,
      };
    }
    return null;
  }

  const ownerWallX = seg.wall === "left" ? owner.x : owner.x + owner.width;
  const centerY = owner.y + seg.offset;
  const along = centerY - other.y;
  if (along - seg.spanHalf >= other.height || along + seg.spanHalf <= 0) return null;

  if (Math.abs(other.x + other.width - ownerWallX) < WALL_TOL) {
    // other is LEFT of owner → opening sits on other's RIGHT wall
    return {
      x: other.x + other.width - seg.depthHalf,
      y: other.y + along,
      halfW: seg.depthHalf,
      halfH: seg.spanHalf,
    };
  }
  if (Math.abs(other.x - ownerWallX) < WALL_TOL) {
    // other is RIGHT of owner → opening sits on other's LEFT wall
    return {
      x: other.x + seg.depthHalf,
      y: other.y + along,
      halfW: seg.depthHalf,
      halfH: seg.spanHalf,
    };
  }
  return null;
}

/**
 * Add cross-room opening zones: for every door/window on a wall shared with
 * a neighboring room, mirror an obstruction zone into that neighbor so its
 * furniture cannot block the opening from the other side.
 */
function addCrossRoomOpeningZones(
  rooms: GeneratedRoom[],
  doors: Door[],
  windows: Window[],
  zonesByRoom: Map<string, ObstructionZone[]>
): void {
  const addMirrors = (
    owner: GeneratedRoom,
    wall: Door["wall"],
    offset: number,
    width: number,
    depthHalf: number
  ) => {
    for (const other of rooms) {
      if (other.name === owner.name) continue;
      const zone = mirrorWallSegment(owner, other, {
        wall,
        offset,
        spanHalf: width / 2,
        depthHalf,
      });
      if (zone) {
        const list = zonesByRoom.get(other.name) || [];
        list.push(zone);
        zonesByRoom.set(other.name, list);
      }
    }
  };

  for (const door of doors) {
    const owner = rooms.find(r => r.name === door.room);
    if (!owner) continue;
    // The mirrored zone is the OPPOSITE side of the door: a 0.3m access
    // strip (0.7m when the door swings out), with the same along-wall
    // margin as the visual rects.
    const oppDepthHalf = (door.swing === "in" ? 0.3 : 0.7) / 2;
    addMirrors(owner, door.wall, door.offset, door.width + DOOR_ALONG_MARGIN * 2, oppDepthHalf);
  }

  for (const win of windows) {
    const owner = rooms.find(r => r.name === win.room);
    if (!owner) continue;
    const zone = getWindowZone(win, owner);
    if (!zone) continue;
    const depthHalf = win.wall === "top" || win.wall === "bottom" ? zone.halfH : zone.halfW;
    addMirrors(owner, win.wall, win.offset, win.width, depthHalf);
  }
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
    // Use a tiny epsilon to prevent floating-point false positives at
    // exact threshold boundaries (e.g. 0.700 < 0.700 can be true in IEEE 754).
    const dx = Math.abs(itemX - zone.x) - (itemHalfW + zone.halfW + margin);
    const dy = Math.abs(itemY - zone.y) - (itemHalfH + zone.halfH + margin);
    if (dx < -1e-9 && dy < -1e-9) {
      return true;
    }
  }
  return false;
}

/**
 * Door clearance zones have BOTH half-dimensions > 0.14m (a window sill
 * zone has one half-dimension = 0.125m — the other is the window width/2).
 */
function isDoorZone(z: ObstructionZone): boolean {
  return Math.min(z.halfW, z.halfH) > 0.14;
}

/** Split combined obstruction zones into door zones and window zones. */
function splitZones(zones: ObstructionZone[]): {
  doorZones: ObstructionZone[];
  windowZones: ObstructionZone[];
} {
  return {
    doorZones: zones.filter(isDoorZone),
    windowZones: zones.filter(z => !isDoorZone(z)),
  };
}

/** Tall items that may NEVER stand in front of a window. */
function isTallWindowBlocker(itemId: string): boolean {
  return itemId === "wardrobe" || itemId === "bookshelf" || itemId === "wall-cabinet";
}

/** Items whose LONG side must sit on a wall (never float mid-room). */
function isWallCounter(itemId: string): boolean {
  return itemId === "kitchen-counter-straight" ||
    itemId === "kitchen-counter-small" ||
    itemId === "kitchen-counter-corner";
}

/**
 * Repair a bed that overlaps a door clearance zone: shrink in place, then
 * shift along its wall. Beds are a MUST — never removed, so the ORIGINAL
 * position is returned when nothing better fits.
 */
function repairBed(
  pf: PlacedFurniture,
  room: GeneratedRoom,
  item: FurnitureItem,
  doorZones: ObstructionZone[],
  existing: PlacedFurniture[]
): PlacedFurniture {
  const isRot = pf.rotation === 90 || pf.rotation === 270;
  const wAt = (s: number) => (isRot ? item.height : item.width) * s;
  const hAt = (s: number) => (isRot ? item.width : item.height) * s;
  const clear = (x: number, y: number, s: number) =>
    !overlapsObstruction(x, y, wAt(s) / 2, hAt(s) / 2, doorZones) &&
    isFurnitureInBounds(x, y, wAt(s), hAt(s), room) &&
    !collidesWithExisting(x, y, wAt(s), hAt(s), pf.room, existing, pf.itemId);

  // Shrink in place first.
  for (const s of [0.9, 0.8, 0.7]) {
    if (clear(pf.x, pf.y, s)) return { ...pf, scale: s };
  }
  // Then shift along the bed's wall.
  const bw = wAt(pf.scale);
  const bh = hAt(pf.scale);
  const alongCands = isRot
    ? [pf.y, room.y + bh / 2 + 0.3, room.y + room.height - bh / 2 - 0.3]
    : [pf.x, room.x + bw / 2 + 0.3, room.x + room.width - bw / 2 - 0.3];
  for (const a of alongCands) {
    const nx = isRot ? pf.x : a;
    const ny = isRot ? a : pf.y;
    if (clear(nx, ny, pf.scale)) return { ...pf, x: nx, y: ny };
  }
  // Never remove a bed — keep the original as the absolute last resort.
  return pf;
}

/**
 * Hard zones for an item: door clearance applies to EVERY object (hard NO),
 * window zones apply only to tall items (wardrobes, bookshelves, upper
 * cabinets). Low items may use window areas when no other spot fits.
 */
function hardZonesFor(itemId: string, zones: ObstructionZone[]): ObstructionZone[] {
  if (isTallWindowBlocker(itemId)) return zones;
  return zones.filter(isDoorZone);
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

  const tryWith = (blockZones: ObstructionZone[]): PlacedFurniture | null => {
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

        // Hard zones only: doors for every item, plus windows for tall items.
        if (blockZones.length > 0 && overlapsObstruction(pos.x, pos.y, iw / 2, ih / 2, blockZones)) {
          if (logLabel) console.log(`[place:${logLabel}] rot=${rot}° pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) scale=${pos.scale.toFixed(2)} → OBSTRUCTION (door/window)`);
          continue;
        }

        if (logLabel) console.log(`[place:${logLabel}] ✅ rot=${rot}° pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) scale=${pos.scale.toFixed(2)} w=${iw.toFixed(2)} h=${ih.toFixed(2)}`);
        return { itemId, room: room.name, x: pos.x, y: pos.y, rotation: rot as 0 | 90 | 180 | 270, scale: pos.scale };
      }
    }
    return null;
  };

  if (obstZones && obstZones.length > 0) {
    // Beds may sit close to windows — windows are NOT an issue for a bed,
    // only door clearance zones are hard.
    if (itemId.startsWith("bed-")) {
      const bedPass = tryWith(hardZonesFor(itemId, obstZones));
      if (bedPass) return bedPass;
      if (logLabel) console.log(`[place:${logLabel}] ❌ FAILED`);
      return null;
    }
    // Pass 1: avoid ALL zones (windows are preferred-avoid for low items).
    const first = tryWith(obstZones);
    if (first) return first;
    // Pass 2 (low items only): window areas become available, door zones
    // stay a hard NO.
    if (!isTallWindowBlocker(itemId)) {
      const second = tryWith(hardZonesFor(itemId, obstZones));
      if (second) return second;
    }
    if (logLabel) console.log(`[place:${logLabel}] ❌ FAILED`);
    return null;
  }

  return tryWith([]);
}

/**
 * Detect if a balcony room is attached to this room and return the shared wall.
 * Returns null if no balcony is attached.
 */
function detectBalconyWall(room: GeneratedRoom, allRooms: GeneratedRoom[]): "bottom" | "top" | "left" | "right" | null {
  const balcony = allRooms.find(r => /balcony/i.test(r.name));
  if (!balcony) return null;

  const TOL = 0.5; // generous tolerance for floating-point slop

  // Balcony is below the room → shared bottom wall
  if (Math.abs(room.y - (balcony.y + balcony.height)) < TOL &&
      balcony.x + balcony.width > room.x &&
      room.x + room.width > balcony.x) {
    console.log(`[balcony-detect] "${room.name}" shares BOTTOM wall with "${balcony.name}" (room.y=${room.y.toFixed(2)}, balcony.top=${(balcony.y + balcony.height).toFixed(2)})`);
    return "bottom";
  }

  // Balcony is above the room → shared top wall
  if (Math.abs(balcony.y - (room.y + room.height)) < TOL &&
      balcony.x + balcony.width > room.x &&
      room.x + room.width > balcony.x) {
    console.log(`[balcony-detect] "${room.name}" shares TOP wall with "${balcony.name}"`);
    return "top";
  }

  // Balcony is to the left → shared left wall
  if (Math.abs(room.x - (balcony.x + balcony.width)) < TOL &&
      balcony.y + balcony.height > room.y &&
      room.y + room.height > balcony.y) {
    console.log(`[balcony-detect] "${room.name}" shares LEFT wall with "${balcony.name}"`);
    return "left";
  }

  // Balcony is to the right → shared right wall
  if (Math.abs(balcony.x - (room.x + room.width)) < TOL &&
      balcony.y + balcony.height > room.y &&
      room.y + room.height > balcony.y) {
    console.log(`[balcony-detect] "${room.name}" shares RIGHT wall with "${balcony.name}"`);
    return "right";
  }

  console.log(`[balcony-detect] "${room.name}" (${room.x.toFixed(2)},${room.y.toFixed(2)} ${room.width.toFixed(2)}×${room.height.toFixed(2)}) vs "${balcony.name}" (${balcony.x.toFixed(2)},${balcony.y.toFixed(2)} ${balcony.width.toFixed(2)}×${balcony.height.toFixed(2)}) → NO MATCH`);
  return null;
}

/** Place an item against a wall — tries positions along each wall, never falls back to centroid */
function wallPlace(
  itemId: string,
  room: GeneratedRoom,
  rotation: number,
  scale: number,
  existingItems: PlacedFurniture[],
  obstZones?: ObstructionZone[],
  wallMargin?: number
): PlacedFurniture | null {
  const item = getFurnitureById(itemId);
  if (!item) return null;

  const rw = room.width, rh = room.height;
  const margin = wallMargin ?? 0.2; // default 0.2m, override for flush-fit items

  // Position templates: wall side + along-wall fraction. The distance from
  // the wall is computed per scale so the gap stays exactly `margin`.
  const templates: Array<{ wall: "bottom" | "top" | "left" | "right"; frac: number }> = [];
  // Center, thirds, and intermediate positions — enough granularity that a
  // door zone can be dodged by a small shift along the same wall.
  const offsets = [0.5, 0.25, 0.75, 0.125, 0.875, 0.375, 0.625];

  if (rotation === 0 || rotation === 180) {
    // Horizontal: top and bottom walls — try multiple positions along X
    for (const frac of offsets) {
      templates.push({ wall: "bottom", frac }, { wall: "top", frac });
    }
  } else if (rotation === 90 || rotation === 270) {
    // Vertical: left and right walls — try multiple positions along Y
    for (const frac of offsets) {
      templates.push({ wall: "left", frac }, { wall: "right", frac });
    }
  } else {
    // Unknown rotation — try both orientations at center only
    templates.push(
      { wall: "bottom", frac: 0.5 },
      { wall: "top", frac: 0.5 },
      { wall: "left", frac: 0.5 },
      { wall: "right", frac: 0.5 },
    );
  }

  // Discrete size tiers — items use intentional sizes (extra large, large,
  // medium, small) and never shrink down continuously to a sliver.
  const SIZE_TIERS = [1.25, 1.0, 0.85, 0.7];
  const scales = Array.from(new Set([scale, ...SIZE_TIERS])).sort((a, b) => b - a);

  const tryWith = (blockZones: ObstructionZone[]): PlacedFurniture | null => {
    for (const s of scales) {
      // Depth into the room is always the item's height dimension — the wall
      // gap is computed from the SCALED depth so the edge stays at `margin`.
      const halfDepth = (item.height * s) / 2;

      for (const t of templates) {
        let x: number, y: number, rot: number;
        if (t.wall === "bottom" || t.wall === "top") {
          x = room.x + rw * t.frac;
          y = t.wall === "bottom" ? room.y + margin + halfDepth : room.y + rh - margin - halfDepth;
          rot = 0;
        } else {
          y = room.y + rh * t.frac;
          x = t.wall === "left" ? room.x + margin + halfDepth : room.x + rw - margin - halfDepth;
          rot = 90;
        }

        const iw = (rot === 90 || rot === 270 ? item.height : item.width) * s;
        const ih = (rot === 90 || rot === 270 ? item.width : item.height) * s;

        if (!isFurnitureInBounds(x, y, iw, ih, room)) continue;
        if (collidesWithExisting(x, y, iw, ih, room.name, existingItems, itemId)) continue;
        // Hard zones only: doors for every item, plus windows for tall items.
        if (blockZones.length > 0 && overlapsObstruction(x, y, iw / 2, ih / 2, blockZones)) continue;

        return { itemId, room: room.name, x, y, rotation: rot as 0 | 90 | 180 | 270, scale: s };
      }
    }
    return null;
  };

  if (obstZones && obstZones.length > 0) {
    // Pass 1: avoid ALL zones (windows are preferred-avoid for low items).
    const first = tryWith(obstZones);
    if (first) return first;
    // Pass 2 (low items only): window areas become available, door zones
    // stay a hard NO.
    if (!isTallWindowBlocker(itemId)) {
      const second = tryWith(hardZonesFor(itemId, obstZones));
      if (second) return second;
    }
    return null;
  }

  return tryWith([]);
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
    // Debug wall markers (__wall_marker__ prefix) never collide
    if (pf.itemId.startsWith("__") && pf.itemId.includes("marker")) continue;
    // Don't collision-check against items in the same functional group
    // (kitchen items can be adjacent, bathroom items can be adjacent)
    if (sameGroup(myItemId, pf.itemId)) continue;

    const item = getFurnitureById(pf.itemId);
    // Virtual obstacle blocks the entire ensuite/bathroom area.
    // Beds CAN overlap an ensuite (ensuite is attached to master bedroom),
    // but MUST NOT overlap a standalone bathroom carved from a studio.
    if (!item && pf.itemId === "__ensuite_obstacle__") {
      if (myItemId.startsWith("bed-")) continue; // beds ignore ensuite obstacle (master bedroom)
      // pf.scale stores the bathroom's half-width.
      // Typical bathroom depth ≈ halfWidth * 1.5 (bathrooms are ~1.5:1 aspect ratio)
      const obsHalfW = (pf.scale || 0.9) + margin;
      const obsHalfH = (pf.scale || 0.9) * 1.5 + margin;
      if (Math.abs(x - pf.x) < halfW + obsHalfW && Math.abs(y - pf.y) < halfH + obsHalfH) {
        return true;
      }
      continue;
    }
    // Studio bathroom obstacle — blocks free-standing furniture from entering
    // the bathroom. Wall-mounted wardrobe against the bathroom's internal
    // partition wall is allowed through (it sits on the studio side).
    if (!item && pf.itemId === "__bathroom_obstacle__") {
      if (myItemId === "wardrobe") continue; // wardrobe against bathroom wall is fine
      const obsHalfW = (pf.scale || 0.9) + margin;
      const obsHalfH = (pf.scale || 0.9) * 1.5 + margin;
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

/** Items in the same functional group can be placed adjacent (no collision check between them).
 *  ONLY pre-grouped items that are DESIGNED to overlap/stack are allowed here:
 *  - Kitchen: counter + stove + sink (rendered as one unit)
 *  - Bed + rug: rug at foot of bed, bed on top
 *  - Coffee table + rug: table centered on rug
 *  - Dining: table + chairs (atomic set)
 *  - Desk: desk + office chair (atomic set)
 *  ALL other items MUST NOT overlap — they get normal collision checks.
 */
function sameGroup(id1: string, id2: string): boolean {
  // Kitchen counter complex: stove and sink are built into the counter rendering
  const kitchenSet = ["kitchen-counter", "stove", "kitchen-sink"];
  // Bed + rug: rug at foot of bed (opposite headboard), bed sits on rug
  const bedRugSet = ["bed-", "rug-large"];
  // Coffee table + rug: table centered on rug
  const coffeeRugSet = ["coffee-table", "rug-large"];
  // Atomic dining set: table + chairs
  const diningSet = ["dining-table", "dining-chair"];
  // Atomic desk set: desk + chair
  const deskSet = ["desk", "office-chair"];
  // Side table can be near bed (flanking headboard), not overlapping
  const bedsideSet = ["bed-", "side-table"];

  const groups = [kitchenSet, bedRugSet, coffeeRugSet, diningSet, deskSet, bedsideSet];
  for (const group of groups) {
    const m1 = group.some(prefix => id1.includes(prefix));
    const m2 = group.some(prefix => id2.includes(prefix));
    if (m1 && m2) return true;
  }
  return false;
}

/**
 * Place furniture into rooms based on room type and dimensions.
 * Returns an array of placed furniture items with world-space coordinates.
 * Doors are used to avoid placing furniture in door swing paths.
 */
/** Compute a room-size-appropriate furniture scale factor.
 *  Furniture in larger rooms scales up so it doesn't look lost;
 *  furniture in smaller rooms scales down to fit. */
function getRoomFurnitureScale(room: GeneratedRoom): number {
  const name = room.name.toLowerCase();
  let standardArea = 14; // default for bedrooms
  if (/master/i.test(name)) standardArea = 22;
  else if (/studio/i.test(name)) standardArea = 30;
  else if (/living|lounge|family/i.test(name)) standardArea = 28;
  else if (/kitchen|kitchenette|cooking/i.test(name)) standardArea = 14;
  else if (/bedroom/i.test(name)) standardArea = 14;
  else if (/bathroom|ensuite/i.test(name)) standardArea = 6;
  else if (/dining/i.test(name)) standardArea = 12;
  else if (/office|study/i.test(name)) standardArea = 10;

  const ratio = Math.sqrt(room.area / standardArea);
  return Math.max(0.8, Math.min(1.35, ratio));
}

/* ------------------------------------------------------------------ */
/*  Atomic dining set: table + chairs as a single unit                 */
/*  Scales table size AND chair count with room area.                  */
/*  If the full set doesn't fit, the next-smaller config is tried.     */
/*  If nothing fits, nothing is placed.                                */
/* ------------------------------------------------------------------ */

interface DiningConfig {
  tableId: string;
  chairCount: number;
  tableScale: number;
}

/** Build a priority-ordered list of dining configs for a room size.
 *  Larger rooms get bigger tables and more chairs.
 *  The ABSOLUTE MINIMUM is a 4-seat table + 2 chairs — always the final fallback. */
function getDiningConfigs(roomArea: number): DiningConfig[] {
  if (roomArea >= 35) return [
    { tableId: "dining-table-6", chairCount: 8, tableScale: 1.15 },
    { tableId: "dining-table-6", chairCount: 6, tableScale: 1.1 },
    { tableId: "dining-table-6", chairCount: 6, tableScale: 1.0 },
    { tableId: "dining-table-6", chairCount: 4, tableScale: 0.9 },
    { tableId: "dining-table-4", chairCount: 4, tableScale: 1.0 },
    { tableId: "dining-table-4", chairCount: 2, tableScale: 0.85 },
  ];
  if (roomArea >= 22) return [
    { tableId: "dining-table-6", chairCount: 6, tableScale: 1.1 },
    { tableId: "dining-table-6", chairCount: 6, tableScale: 1.0 },
    { tableId: "dining-table-6", chairCount: 4, tableScale: 0.9 },
    { tableId: "dining-table-4", chairCount: 4, tableScale: 1.0 },
    { tableId: "dining-table-4", chairCount: 2, tableScale: 0.85 },
  ];
  if (roomArea >= 14) return [
    { tableId: "dining-table-6", chairCount: 6, tableScale: 1.0 },
    { tableId: "dining-table-6", chairCount: 4, tableScale: 0.9 },
    { tableId: "dining-table-4", chairCount: 4, tableScale: 1.0 },
    { tableId: "dining-table-4", chairCount: 2, tableScale: 0.85 },
  ];
  if (roomArea >= 10) return [
    { tableId: "dining-table-4", chairCount: 4, tableScale: 0.95 },
    { tableId: "dining-table-4", chairCount: 2, tableScale: 0.85 },
  ];
  if (roomArea >= 7) return [
    { tableId: "dining-table-4", chairCount: 4, tableScale: 0.85 },
    { tableId: "dining-table-4", chairCount: 2, tableScale: 0.75 },
  ];
  // Absolute minimum for tiny dining nooks
  return [
    { tableId: "dining-table-4", chairCount: 2, tableScale: 0.7 },
  ];
}

/**
 * Try to place an entire dining set (table + all chairs) in the room.
 * Returns the placed items if the full set fits, null otherwise.
 * This is atomic: either everything fits or nothing is placed.
 */
function placeDiningSet(
  room: GeneratedRoom,
  config: DiningConfig,
  existingItems: PlacedFurniture[],
  obstZones: ObstructionZone[]
): PlacedFurniture[] | null {
  const table = getFurnitureById(config.tableId);
  const chair = getFurnitureById("dining-chair");
  if (!table || !chair) return null;

  const cx = room.x + room.width / 2;
  const cy = room.y + room.height / 2;
  const rot = room.width > room.height ? 0 : 90;

  const tw = table.width * config.tableScale;
  const th = table.height * config.tableScale;

  // 1. Table must fit in bounds
  if (!isFurnitureInBounds(cx, cy, tw, th, room)) return null;

  // 2. Table must not collide with existing furniture
  if (collidesWithExisting(cx, cy, tw, th, room.name, existingItems, config.tableId)) return null;

  // 3. Table must not overlap door/window zones
  if (overlapsObstruction(cx, cy, tw / 2, th / 2, obstZones)) return null;

  // 4. Pre-compute and validate ALL chair positions
  const cw = chair.width * config.tableScale;
  const ch = chair.height * config.tableScale;
  const dist = Math.max(tw, th) * 0.55;
  const chairPositions: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < config.chairCount; i++) {
    const angle = (i / config.chairCount) * Math.PI * 2 - Math.PI / 2;
    const chX = cx + Math.cos(angle) * dist;
    const chY = cy + Math.sin(angle) * dist;

    // Chair must be in room bounds
    if (!isFurnitureInBounds(chX, chY, cw, ch, room)) return null;
    // Chair must not overlap obstruction zones
    if (overlapsObstruction(chX, chY, cw / 2, ch / 2, obstZones)) return null;
    // Chair must not collide with existing furniture
    if (collidesWithExisting(chX, chY, cw, ch, room.name, existingItems, "dining-chair")) return null;

    chairPositions.push({ x: chX, y: chY });
  }

  // ── All checks passed — build the atomic result ──
  const result: PlacedFurniture[] = [
    {
      itemId: config.tableId,
      room: room.name,
      x: cx, y: cy,
      rotation: rot as 0 | 90 | 180 | 270,
      scale: config.tableScale,
    },
  ];

  for (const pos of chairPositions) {
    result.push({
      itemId: "dining-chair",
      room: room.name,
      x: pos.x, y: pos.y,
      rotation: 0,
      scale: config.tableScale,
    });
  }

  console.log(`[dining] "${room.name}" (${room.area.toFixed(0)}m²) → ${config.tableId} ×${config.tableScale.toFixed(2)} + ${config.chairCount} chairs ✅`);
  return result;
}

/* ------------------------------------------------------------------ */
/*  Atomic desk set: desk + chair as a single unit                     */
/*  If the desk fits but the chair doesn't, neither is placed.         */
/* ------------------------------------------------------------------ */

/**
 * Try to place a desk + chair against a wall. The chair sits in front
 * of the desk (offset 0.5m toward room center from the desk).
 * Returns both items if the full set fits, null otherwise.
 */
function placeDeskSet(
  room: GeneratedRoom,
  preferredX: number,
  preferredY: number,
  preferredRot: number,
  deskScale: number,
  existingItems: PlacedFurniture[],
  obstZones: ObstructionZone[]
): PlacedFurniture[] | null {
  const desk = getFurnitureById("desk");
  const chair = getFurnitureById("office-chair");
  if (!desk || !chair) return null;

  // Positions to try: preferred first, then alternatives
  const positions: Array<{ x: number; y: number; rot: number }> = [];
  const cx = room.x + room.width / 2;
  const cy = room.y + room.height / 2;

  // Add the preferred position first
  positions.push({ x: preferredX, y: preferredY, rot: preferredRot });

  // If preferred is near back wall, add symmetric alternatives
  const nearBackWall = Math.abs(preferredY - (room.y + room.height)) < 1.0;
  const nearFrontWall = Math.abs(preferredY - room.y) < 1.0;
  if (nearBackWall) {
    positions.push(
      { x: room.x + 0.9, y: room.y + room.height - 0.5, rot: 0 },
      { x: room.x + 0.5, y: room.y + 0.9, rot: 180 },
      { x: room.x + room.width - 0.5, y: room.y + 0.9, rot: 180 },
    );
  }

  for (const pos of positions) {
    const dw = desk.width * deskScale;
    const dh = desk.height * deskScale;

    // Desk must fit in bounds
    if (!isFurnitureInBounds(pos.x, pos.y, dw, dh, room)) continue;
    // Desk must not collide with existing
    if (collidesWithExisting(pos.x, pos.y, dw, dh, room.name, existingItems, "desk")) continue;
    // Desk must not overlap door/window zones
    if (overlapsObstruction(pos.x, pos.y, dw / 2, dh / 2, obstZones)) continue;

    // Chair position: in front of the desk (0.5m offset toward room center)
    // The desk's "front" depends on rotation — for rot=0, the front is at y - dh/2
    let chairX = pos.x;
    let chairY = pos.y;
    if (pos.rot === 0) chairY -= dh / 2 + 0.4;
    else if (pos.rot === 180) chairY += dh / 2 + 0.4;
    else if (pos.rot === 90) chairX -= dh / 2 + 0.4;
    else if (pos.rot === 270) chairX += dh / 2 + 0.4;

    const cw = chair.width;
    const ch = chair.height;

    // Chair must fit in bounds
    if (!isFurnitureInBounds(chairX, chairY, cw, ch, room)) continue;
    // Chair must not collide with existing
    if (collidesWithExisting(chairX, chairY, cw, ch, room.name, existingItems, "office-chair")) continue;
    // Chair must not overlap door/window zones
    if (overlapsObstruction(chairX, chairY, cw / 2, ch / 2, obstZones)) continue;

    // All checks passed — return atomic set
    return [
      { itemId: "desk", room: room.name, x: pos.x, y: pos.y, rotation: pos.rot as 0 | 90 | 180 | 270, scale: deskScale },
      { itemId: "office-chair", room: room.name, x: chairX, y: chairY, rotation: 0, scale: 1.0 },
    ];
  }

  return null;
}

export function suggestFurniture(rooms: GeneratedRoom[], doors: Door[] = [], windows: Window[] = []): PlacedFurniture[] {
  const placed: PlacedFurniture[] = [];

  // Pre-compute obstruction zones per room (doors + windows)
  const obstructionZonesByRoom = new Map<string, ObstructionZone[]>();
  for (const room of rooms) {
    obstructionZonesByRoom.set(room.name, getRoomObstructionZones(room, doors, windows));
  }
  // Doors/windows on a wall shared with a neighboring room are openings that
  // the neighbor must also keep clear — mirror those zones across the wall.
  addCrossRoomOpeningZones(rooms, doors, windows, obstructionZonesByRoom);

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
    const roomScale = getRoomFurnitureScale(room);

    const name = room.name.toLowerCase();

    /* ---- STUDIO — single open room with living, sleeping, and kitchen zones ---- */
    if (/studio/i.test(name)) {
      const obstZones = obstructionZonesByRoom.get(room.name) || [];

      // Detect balcony wall and add its sliding door as an obstruction zone
      // on the studio side so furniture cannot block access to the balcony.
      const balconyWall = detectBalconyWall(room, rooms);
      if (balconyWall) {
        const balcony = rooms.find(r => /balcony/i.test(r.name))!;
        // Find the actual balcony door dimensions (2m wide sliding door)
        const balconyDoor = doors.find(d => d.room === balcony.name);
        const doorWidth = balconyDoor?.width ?? 2.0;
        const doorClearance = 1.5; // 1.5m clearance required in front of sliding door

        // Create obstruction zone on the studio's side of the shared wall
        let zoneX: number, zoneY: number, zoneHalfW: number, zoneHalfH: number;
        const balCenter = balconyDoor
          ? (balconyDoor.wall === "left" || balconyDoor.wall === "right"
            ? balcony.y + balconyDoor.offset
            : balcony.x + balconyDoor.offset)
          : (balconyWall === "left" || balconyWall === "right"
            ? balcony.y + balcony.height / 2
            : balcony.x + balcony.width / 2);

        switch (balconyWall) {
          case "bottom":
            zoneX = balCenter;
            zoneY = room.y + doorClearance / 2;
            zoneHalfW = doorWidth / 2;
            zoneHalfH = doorClearance / 2;
            break;
          case "top":
            zoneX = balCenter;
            zoneY = room.y + room.height - doorClearance / 2;
            zoneHalfW = doorWidth / 2;
            zoneHalfH = doorClearance / 2;
            break;
          case "left":
            zoneX = room.x + doorClearance / 2;
            zoneY = balCenter;
            zoneHalfW = doorClearance / 2;
            zoneHalfH = doorWidth / 2;
            break;
          case "right":
            zoneX = room.x + room.width - doorClearance / 2;
            zoneY = balCenter;
            zoneHalfW = doorClearance / 2;
            zoneHalfH = doorWidth / 2;
            break;
        }
        obstZones.push({ x: zoneX!, y: zoneY!, halfW: zoneHalfW!, halfH: zoneHalfH! });
        console.log(`[balcony-zone] added 2m sliding door obstruction (${doorClearance}m clearance) on ${balconyWall} wall of "${room.name}"`);
      }

      // If bathroom is carved from the studio (bathroom is inside studio bounds),
      // block that area as an obstacle so furniture doesn't overlap the bathroom
      const bathroomRoom = rooms.find(r => /bathroom/i.test(r.name) && !/ensuite/i.test(r.name));
      if (bathroomRoom && bathroomRoom !== room) {
        // Only add obstacle if bathroom is actually inside the studio room
        const bInStudio =
          bathroomRoom.x >= room.x - 0.01 &&
          bathroomRoom.y >= room.y - 0.01 &&
          bathroomRoom.x + bathroomRoom.width <= room.x + room.width + 0.01 &&
          bathroomRoom.y + bathroomRoom.height <= room.y + room.height + 0.01;
        if (bInStudio) {
          // Store bathroom half-width in scale for accurate collision detection.
          // Use __bathroom_obstacle__ (NOT __ensuite_obstacle__) so that beds
          // do NOT ignore this obstacle — beds must stay out of the bathroom.
          const bathHalfW = bathroomRoom.width / 2;
          placed.push({
            itemId: "__bathroom_obstacle__",
            room: room.name,
            x: bathroomRoom.x + bathroomRoom.width / 2,
            y: bathroomRoom.y + bathroomRoom.height / 2,
            rotation: 0,
            scale: bathHalfW,
          });
        }
      }

      // Determine which walls have door obstructions (NOT windows — windows don't block TV).
      // Windows always have one dimension = sillDepth/2 ≈ 0.125m (the other = window width/2).
      // Door zones have BOTH dimensions > 0.14m (depth 0.7/0.3 vs window sill 0.125).
      const doorZones = splitZones(obstZones).doorZones;
      const hasBottomObst = doorZones.some(z => Math.abs(z.y - (room.y + z.halfH)) < 0.3);
      const hasTopObst = doorZones.some(z => Math.abs(z.y - (room.y + room.height - z.halfH)) < 0.3);
      const hasLeftObst = doorZones.some(z => Math.abs(z.x - (room.x + z.halfW)) < 0.3);
      const hasRightObst = doorZones.some(z => Math.abs(z.x - (room.x + room.width - z.halfW)) < 0.3);

      // Debug: enumerate each obstruction zone
      if (obstZones.length > 0) {
        console.log(`[tv-debug] "${room.name}" has ${obstZones.length} zone(s), ${doorZones.length} door zone(s):`);
        for (const z of obstZones) {
          const b = Math.abs(z.y - (room.y + z.halfH)) < 0.3;
          const t = Math.abs(z.y - (room.y + room.height - z.halfH)) < 0.3;
          const l = Math.abs(z.x - (room.x + z.halfW)) < 0.3;
          const r = Math.abs(z.x - (room.x + room.width - z.halfW)) < 0.3;
          const isDoor = isDoorZone(z);
          console.log(`[tv-debug]   ${isDoor ? "DOOR" : "window"} x=${z.x.toFixed(2)} y=${z.y.toFixed(2)} hw=${z.halfW.toFixed(3)} hh=${z.halfH.toFixed(3)} → bottom=${b} top=${t} left=${l} right=${r}`);
        }
      }

      // TV wall selection: skip walls that have doors, windows, or balcony doors
      const wallIsBlocked = (wall: string) => {
        if (wall === "bottom") return hasBottomObst;
        if (wall === "top") return hasTopObst;
        if (wall === "left") return hasLeftObst;
        if (wall === "right") return hasRightObst;
        return false;
      };

      // ── TV wall selection (avoid balcony wall and door walls) ──
      type WallName = "bottom" | "top" | "left" | "right";
      const wallOrder: WallName[] = ["bottom", "top", "left", "right"];
      let tvWall: WallName = "bottom";
      for (const w of wallOrder) {
        if (!wallIsBlocked(w)) { tvWall = w; break; }
      }
      console.log(`[tv-wall] "${room.name}" balcony=${balconyWall ?? "none"} chosen=${tvWall} (bottomBlocked=${wallIsBlocked("bottom")} topBlocked=${wallIsBlocked("top")} leftBlocked=${wallIsBlocked("left")} rightBlocked=${wallIsBlocked("right")})`);

      // ── 1. Bed zone FIRST (reserves wall space) ──
      // Bed placement priority: adjacent walls (same side as living zone) →
      // opposite wall (fallback). This keeps the bed near the sofa/TV/coffee area
      // rather than isolated on the far wall.
      const bedId = roomArea >= 18 ? "bed-double" : "bed-single";
      const bed = getFurnitureById(bedId);
      let bedPlacedY = room.y + room.height; // default: bed at top (for bottom-TV)
      // The bed is placed FIRST — its rectangle is recorded so the living
      // zone works AROUND it (the bed is never moved for the living set).
      let bedRect: { x: number; y: number; w: number; h: number } | null = null;
      if (bed) {
        let bedScale = roomArea < 14 ? 0.85 : 1.0;
        if (bed.width * bedScale > rw - 0.3) bedScale = (rw - 0.3) / bed.width;
        const bw = bed.width * bedScale;
        const bh = bed.height * bedScale;

        // Build a priority-ordered list of { wall, rotation, x, y } candidates.
        // Adjacent walls first (bed on same side as living zone), opposite last.
        interface BedCandidate { wall: string; rotation: 0 | 90 | 180 | 270; x: number; y: number; }
        const candidates: BedCandidate[] = [];

        // Door clearance is a HARD NO for the bed too — windows are NOT an
        // issue (a bed can sit close to a window). The balcony sliding-door
        // zone is included in the door zones.
        const studioBedDoorZones = splitZones(obstZones).doorZones;

        // Helper: add candidate for a given wall
        const addBedCandidate = (wall: string, rot: 0 | 90 | 180 | 270, bx: number, by: number) => {
          // Check that bed doesn't overlap bathroom obstacle before adding
          const isVRot = rot === 90 || rot === 270;
          const bedHalfW = (isVRot ? bh : bw) / 2;
          const bedHalfH = (isVRot ? bw : bh) / 2;
          // Quick bathroom overlap check
          if (bathroomRoom && bathroomRoom !== room) {
            const bInStudio =
              bathroomRoom.x >= room.x - 0.01 &&
              bathroomRoom.y >= room.y - 0.01 &&
              bathroomRoom.x + bathroomRoom.width <= room.x + room.width + 0.01 &&
              bathroomRoom.y + bathroomRoom.height <= room.y + room.height + 0.01;
            if (bInStudio) {
              const bHalfW = bathroomRoom.width / 2 + 0.1;
              const bHalfH = bathroomRoom.height / 2 + 0.1;
              const bCx = bathroomRoom.x + bathroomRoom.width / 2;
              const bCy = bathroomRoom.y + bathroomRoom.height / 2;
              if (Math.abs(bx - bCx) < bedHalfW + bHalfW && Math.abs(by - bCy) < bedHalfH + bHalfH) {
                return; // overlaps bathroom, skip this candidate
              }
            }
          }
          // Skip candidates on the balcony wall — the bed must not block
          // the sliding door. Beds on adjacent walls (left/right of a bottom
          // balcony) are fine since they don't obstruct the door opening.
          if (balconyWall && wall === balconyWall) {
            return; // bed would be on the balcony wall, skip
          }
          // Door clearance — no doorway may be blocked (balcony sliding door
          // included). Window zones are ignored.
          if (overlapsObstruction(bx, by, bedHalfW, bedHalfH, studioBedDoorZones)) {
            return; // bed would block a door zone, skip
          }
          candidates.push({ wall, rotation: rot, x: bx, y: by });
        };

        if (tvWall === "bottom") {
          // TV bottom → priority: right wall, left wall (adjacent, same side), then top (opposite)
          addBedCandidate("right", 90, room.x + room.width - bh / 2 - 0.15, room.y + room.height - bw / 2 - 0.3);
          addBedCandidate("left", 270, room.x + bh / 2 + 0.15, room.y + room.height - bw / 2 - 0.3);
          addBedCandidate("top", 0, room.x + rw - bw / 2 - 0.3, room.y + room.height - bh / 2 - 0.15);
          addBedCandidate("top-left", 0, room.x + bw / 2 + 0.3, room.y + room.height - bh / 2 - 0.15);
        } else if (tvWall === "top") {
          // TV top → bed on right/left walls (adjacent to TV zone), then bottom (opposite)
          addBedCandidate("right", 90, room.x + room.width - bh / 2 - 0.15, room.y + bw / 2 + 0.3);
          addBedCandidate("left", 270, room.x + bh / 2 + 0.15, room.y + bw / 2 + 0.3);
          addBedCandidate("bottom", 180, room.x + rw - bw / 2 - 0.3, room.y + bh / 2 + 0.15);
          addBedCandidate("bottom-left", 180, room.x + bw / 2 + 0.3, room.y + bh / 2 + 0.15);
        } else if (tvWall === "left") {
          // TV left → priority: top wall, bottom wall (adjacent), then right (opposite)
          addBedCandidate("top", 0, room.x + room.width - bw / 2 - 0.3, room.y + room.height - bh / 2 - 0.15);
          addBedCandidate("bottom", 180, room.x + room.width - bw / 2 - 0.3, room.y + bh / 2 + 0.15);
          addBedCandidate("right", 90, room.x + room.width - bh / 2 - 0.15, room.y + room.height - bw / 2 - 0.3);
        } else {
          // TV right → priority: top wall, bottom wall (adjacent), then left (opposite)
          addBedCandidate("top", 0, room.x + bw / 2 + 0.3, room.y + room.height - bh / 2 - 0.15);
          addBedCandidate("bottom", 180, room.x + bw / 2 + 0.3, room.y + bh / 2 + 0.15);
          addBedCandidate("left", 270, room.x + bh / 2 + 0.15, room.y + room.height - bw / 2 - 0.3);
        }

        // Generic wall sweep: the bed has NO fixed position — any clear wall
        // spot works. Ends of the walls are tried FIRST because the living
        // zone uses the wall center (TV side), so corner positions leave it
        // free.
        for (const frac of [0.25, 0.75, 0.125, 0.875, 0.5, 0.375, 0.625]) {
          addBedCandidate("top", 0, room.x + rw * frac, room.y + room.height - bh / 2 - 0.15);
          addBedCandidate("bottom", 180, room.x + rw * frac, room.y + bh / 2 + 0.15);
          addBedCandidate("left", 270, room.x + bh / 2 + 0.15, room.y + rh * frac);
          addBedCandidate("right", 90, room.x + rw - bh / 2 - 0.15, room.y + rh * frac);
        }

        // Pick the first candidate that fits within room bounds
        let bestCandidate: BedCandidate | null = null;
        for (const c of candidates) {
          const isVRot = c.rotation === 90 || c.rotation === 270;
          const cw = isVRot ? bh : bw;
          const ch = isVRot ? bw : bh;
          if (isFurnitureInBounds(c.x, c.y, cw, ch, room)) {
            bestCandidate = c;
            break;
          }
        }

        if (bestCandidate) {
          const { x: bedX, y: bedY, rotation: bedRotation } = bestCandidate;
          const wall = bestCandidate.wall;

          placed.push({ itemId: bedId, room: room.name, x: bedX, y: bedY, rotation: bedRotation, scale: bedScale });

          // Record the bed rectangle so the living zone avoids it.
          const bedIsVRot = bedRotation === 90 || bedRotation === 270;
          bedRect = {
            x: bedX,
            y: bedY,
            w: bedIsVRot ? bh : bw,
            h: bedIsVRot ? bw : bh,
          };

          // Set bedPlacedY for living zone spacing
          if (bedRotation === 0) {
            bedPlacedY = bedY - bh / 2; // bottom edge
          } else if (bedRotation === 180) {
            bedPlacedY = bedY + bh / 2; // top edge
          } else {
            bedPlacedY = bedY; // side-wall bed, use center Y
          }

          // Side table next to bed (only for horizontal beds on top/bottom
          // walls) — skipped if it would land in a door clearance zone.
          if (bedRotation === 0 || bedRotation === 180) {
            const bedOnRight = bedX > room.x + rw / 2;
            const stX = bedOnRight ? bedX - bw / 2 - 0.3 : bedX + bw / 2 + 0.3;
            const stY = bedRotation === 0 ? room.y + room.height - 0.3 : room.y + 0.3;
            if (stX - 0.25 >= room.x && stX + 0.25 <= room.x + rw &&
                !overlapsObstruction(stX, stY, 0.3, 0.3, studioBedDoorZones)) {
              placed.push({ itemId: "side-table", room: room.name, x: stX, y: stY, rotation: bedRotation, scale: bedScale });
            }
          }
        } else {
          // Absolute fallback: place against top wall
          const bedX = room.x + rw - bw / 2 - 0.3;
          const bedY = room.y + room.height - bh / 2 - 0.15;
          placed.push({ itemId: bedId, room: room.name, x: bedX, y: bedY, rotation: 0, scale: bedScale });
          bedPlacedY = bedY - bh / 2;
          bedRect = { x: bedX, y: bedY, w: bw, h: bh };
        }
      }

      // ── 2. Compact living zone: TV → coffee table → sofa ──
      // All three share the same X position (offset away from bathroom).
      // TV: tight against bottom wall (0.1m gap), sofa faces it, coffee between them.
      // Total TV→sofa distance ≈ 1.1m, fitting comfortably even in small studios.

      // Offset sofaX away from bathroom if one is carved into the studio
      let sofaX = cx; // default: center
      if (bathroomRoom && bathroomRoom !== room) {
        const bInStudio =
          bathroomRoom.x >= room.x - 0.01 &&
          bathroomRoom.y >= room.y - 0.01 &&
          bathroomRoom.x + bathroomRoom.width <= room.x + room.width + 0.01 &&
          bathroomRoom.y + bathroomRoom.height <= room.y + room.height + 0.01;
        if (bInStudio) {
          const bathRight = bathroomRoom.x + bathroomRoom.width;
          const bathLeft = bathroomRoom.x;
          if (bathLeft < room.x + rw * 0.3) {
            sofaX = room.x + bathRight + (room.x + rw - bathRight) / 2;
          } else {
            sofaX = room.x + (bathLeft - room.x) / 2;
          }
        }
      }
      const tvItem = getFurnitureById("tv-unit");
      const tvHalfH = tvItem ? tvItem.height / 2 : 0.2;

      let tvY: number, sofaY: number, coffeeY: number;
      if (tvWall === "bottom") {
        tvY = room.y + 0.1 + tvHalfH;           // 0.1m off wall (center at ~0.3m)
        coffeeY = tvY + tvHalfH + 0.55;          // ~0.55m gap from TV top
        sofaY = coffeeY + 0.5 + 0.5;             // ~1m from coffee (0.5 gap + 0.5 sofa halfH)
      } else if (tvWall === "top") {
        tvY = room.y + rh - 0.1 - tvHalfH;
        coffeeY = tvY - tvHalfH - 0.5;
        sofaY = coffeeY - 0.45 - 0.5;
      } else {
        // Side walls: use room center for TV/sofa, coffee between them
        tvY = cy;
        sofaY = cy;
        coffeeY = cy;
      }

      // Ensure sofa doesn't crowd the bed zone
      if (tvWall === "bottom" && sofaY + 0.6 > bedPlacedY) {
        sofaY = bedPlacedY - 0.6;
        coffeeY = (tvY + sofaY) / 2;
      } else if (tvWall === "top" && sofaY - 0.6 < bedPlacedY) {
        sofaY = bedPlacedY + 0.6;
        coffeeY = (tvY + sofaY) / 2;
      }

      // The bed was placed FIRST — shift the living set along the wall until
      // sofa, TV and coffee all clear the bed (and stay in bounds).
      const bedOverlaps = (x: number, y: number, w: number, h: number): boolean => {
        if (!bedRect) return false;
        return Math.abs(x - bedRect.x) < w / 2 + bedRect.w / 2 + 0.05 &&
               Math.abs(y - bedRect.y) < h / 2 + bedRect.h / 2 + 0.05;
      };
      const sofa = getFurnitureById("sofa-3-seater");
      const sofaZone = sofa && rw >= sofa.width * roomScale + 0.3
        ? { item: sofa, scale: roomScale }
        : { item: getFurnitureById("sofa-2-seater"), scale: 0.9 };
      const sofaIt = sofaZone.item;
      const sofaS = sofaZone.scale;

      if ((tvWall === "bottom" || tvWall === "top") && sofaIt) {
        const sW = sofaIt.width * sofaS;
        const sH = sofaIt.height * sofaS;
        const tW = tvItem ? tvItem.width * roomScale : 1.4;
        const tH = tvItem ? tvItem.height * roomScale : 0.4;
        const cW = 1.1 * 0.9;
        const cH = 0.6 * 0.9;
        const livingClear = (sx: number) =>
          !bedOverlaps(sx, sofaY, sW, sH) &&
          !bedOverlaps(sx, tvY, tW, tH) &&
          !bedOverlaps(sx, coffeeY, cW, cH) &&
          isFurnitureInBounds(sx, sofaY, sW, sH, room) &&
          isFurnitureInBounds(sx, tvY, tW, tH, room) &&
          isFurnitureInBounds(sx, coffeeY, cW, cH, room);
        const xCands = [
          sofaX,
          room.x + rw * 0.5,
          room.x + rw * 0.75,
          room.x + rw * 0.25,
          room.x + rw * 0.65,
          room.x + rw * 0.35,
          room.x + rw * 0.85,
          room.x + rw * 0.15,
        ];
        const chosenX = xCands.find(livingClear);
        if (chosenX !== undefined) sofaX = chosenX;
      }

      if (sofaIt) {
        if (tvWall === "bottom" || tvWall === "top") {
          placed.push({ itemId: sofaIt.id, room: room.name, x: sofaX, y: sofaY, rotation: tvWall === "bottom" ? 0 : 180, scale: sofaS });
        } else if (tvWall === "left") {
          placed.push({ itemId: sofaIt.id, room: room.name, x: room.x + rw * 0.75, y: sofaY, rotation: 90, scale: sofaS });
        } else {
          placed.push({ itemId: sofaIt.id, room: room.name, x: room.x + rw * 0.25, y: sofaY, rotation: 270, scale: sofaS });
        }
      }

      // TV unit — tight against the wall, facing sofa
      if (tvItem && (rw >= 1.5 || rh >= 1.5)) {
        placed.push({ itemId: "tv-unit", room: room.name, x: sofaX, y: tvY, rotation: 0, scale: roomScale });
      }

      // Coffee table + rug — directly between sofa and TV, same center
      if (roomArea >= 14) {
        placed.push({
          itemId: "coffee-table",
          room: room.name,
          x: sofaX,
          y: coffeeY,
          // Long side parallel to the sofa (vertical for side-wall TVs).
          rotation: tvWall === "left" || tvWall === "right" ? 90 : 0,
          scale: 0.9,
        });
      }
      // Rug under coffee table — anchors the living zone visually
      if (roomArea >= 18) {
        placed.push({ itemId: "rug-large", room: room.name, x: sofaX, y: coffeeY, rotation: 0, scale: 0.55 });
      }

      // ── 3. Bed rug — STRICTLY at the FOOT of the bed ──
      // The rug sits at the foot edge of the bed (0.35m underlap) and is
      // never placed independently — always coupled to the bed.
      if (roomArea >= 18) {
        const bedForRug = placed.find(pf => pf.itemId.startsWith("bed-") && pf.room === room.name);
        if (bedForRug) {
          const bedRugItem = getFurnitureById(bedForRug.itemId);
          if (bedRugItem) {
            const isRot = bedForRug.rotation === 90 || bedForRug.rotation === 270;
            const bRugW = (isRot ? bedRugItem.height : bedRugItem.width) * bedForRug.scale;
            const bRugH = (isRot ? bedRugItem.width : bedRugItem.height) * bedForRug.scale;
            const rugScale = 0.55;
            const rugW = 2.0 * rugScale;
            const rugH = 1.4 * rugScale;
            let rugX = bedForRug.x;
            let rugY = bedForRug.y;
            if (bedForRug.rotation === 0) rugY = bedForRug.y - bRugH / 2 - rugH / 2 + 0.35;
            else if (bedForRug.rotation === 180) rugY = bedForRug.y + bRugH / 2 + rugH / 2 - 0.35;
            else if (bedForRug.rotation === 90) rugX = bedForRug.x - bRugW / 2 - rugW / 2 + 0.35;
            else if (bedForRug.rotation === 270) rugX = bedForRug.x + bRugW / 2 + rugW / 2 - 0.35;
            placed.push({ itemId: "rug-large", room: room.name, x: rugX, y: rugY, rotation: 0, scale: rugScale });
          }
        }
      }

      // ── 4. Wardrobe — on bathroom wall (natural divider), opposite bed ──
      // The bathroom wall is the ideal wardrobe location: it separates
      // functional zones and is naturally opposite the sleeping area.
      let bedWall: string | null = null;
      const bedForWardrobe = placed.find(pf => pf.itemId.startsWith("bed-") && pf.room === room.name);
      if (bedForWardrobe) {
        if (bedForWardrobe.rotation === 0) bedWall = "top";
        else if (bedForWardrobe.rotation === 180) bedWall = "bottom";
        else if (bedForWardrobe.rotation === 90) bedWall = "right";
        else if (bedForWardrobe.rotation === 270) bedWall = "left";
      }

      // Helper: get the opposite wall name
      const getOppositeWall = (w: string): string => {
        if (w === "top") return "bottom";
        if (w === "bottom") return "top";
        if (w === "left") return "right";
        return "left";
      };

      // Detect the bathroom's INTERNAL wall — the partition wall that faces
      // into the studio (NOT the exterior wall). This is the wall the wardrobe
      // should go against, since it's opposite the sleeping zone.
      let bathroomWall: string | null = null;
      if (bathroomRoom && bathroomRoom !== room) {
        const TOL = 0.3;
        const bRight = bathroomRoom.x + bathroomRoom.width;
        const bTop = bathroomRoom.y + bathroomRoom.height;
        const rRight = room.x + room.width;
        const rTop = room.y + room.height;

        // First: is the bathroom inside the studio bounds?
        const bInStudio =
          bathroomRoom.x >= room.x - TOL &&
          bathroomRoom.y >= room.y - TOL &&
          bRight <= rRight + TOL &&
          bTop <= rTop + TOL;

        if (bInStudio) {
          // For each bathroom wall, check if it's on the studio's exterior boundary.
          // External walls: flush with studio perimeter → NOT the wardrobe wall.
          // Internal walls: inset from perimeter → THESE are the partition walls.
          const extRight  = Math.abs(bRight - rRight) < TOL;
          const extLeft   = Math.abs(bathroomRoom.x - room.x) < TOL;
          const extTop    = Math.abs(bTop - rTop) < TOL;
          const extBottom = Math.abs(bathroomRoom.y - room.y) < TOL;

          // Internal (partition) walls are the ones NOT on the exterior.
          const internalWalls: string[] = [];
          if (!extRight)  internalWalls.push("right");
          if (!extLeft)   internalWalls.push("left");
          if (!extTop)    internalWalls.push("top");
          if (!extBottom) internalWalls.push("bottom");

          // Detect which internal wall has the bathroom door so the
          // wardrobe can avoid it. The wardrobe on the door wall blocks
          // bathroom access.
          let doorWall: string | null = null;
          const bathDoor = doors.find(d => d.room === bathroomRoom.name);
          if (bathDoor) {
            doorWall = bathDoor.wall;
          }

          // Filter out the door wall unless it's the ONLY internal wall
          const viableWalls = internalWalls.filter(w => w !== doorWall);
          const candidates = viableWalls.length > 0 ? viableWalls : internalWalls;

          // Pick the internal wall farthest from the bed for visual balance
          if (candidates.length === 1) {
            bathroomWall = candidates[0];
          } else if (candidates.length > 1) {
            // Prefer the wall opposite the bed wall
            if (bedWall && candidates.includes(getOppositeWall(bedWall))) {
              bathroomWall = getOppositeWall(bedWall);
            } else {
              bathroomWall = candidates[0];
            }
          }

        }
      }
      // ═══════════════════════════════════════════════════════════════
      //  Wardrobe — directly on the internal bathroom wall (yellow line)
      // ═══════════════════════════════════════════════════════════════
      // We already know the exact position of the internal bathroom wall
      // from the yellow marker. Place the wardrobe there directly.
      let wardResult: PlacedFurniture | null = null;
      const wardrobeItem = getFurnitureById("wardrobe");

      if (bathroomWall && wardrobeItem) {
        // Use the SAME wall geometry as the yellow marker
        const bRight = bathroomRoom!.x + bathroomRoom!.width;
        const bTop = bathroomRoom!.y + bathroomRoom!.height;
        const wardScale = 0.8;
        const wardHalfW = (wardrobeItem.width * wardScale) / 2;
        const wardHalfH = (wardrobeItem.height * wardScale) / 2;

        let wx: number, wy: number, wRot: 0 | 90 | 180 | 270;

        if (bathroomWall === "left") {
          wx = bathroomRoom!.x - wardHalfH - 0.03;
          wy = bathroomRoom!.y + bathroomRoom!.height / 2;
          wRot = 90;
        } else if (bathroomWall === "right") {
          wx = bRight + wardHalfH + 0.03;
          wy = bathroomRoom!.y + bathroomRoom!.height / 2;
          wRot = 90;
        } else if (bathroomWall === "top") {
          wx = bathroomRoom!.x + bathroomRoom!.width / 2;
          wy = bTop + wardHalfH + 0.03;
          wRot = 0;
        } else {
          // bottom
          wx = bathroomRoom!.x + bathroomRoom!.width / 2;
          wy = bathroomRoom!.y - wardHalfH - 0.03;
          wRot = 0;
        }

        // Check: in bounds, no collision, and doesn't block bathroom door
        const wRotNum = wRot as number;
        const isVRot = wRotNum === 90 || wRotNum === 270;
        const ww = isVRot ? wardrobeItem.height * wardScale : wardrobeItem.width * wardScale;
        const wh = isVRot ? wardrobeItem.width * wardScale : wardrobeItem.height * wardScale;

        // Also check bathroom obstruction zones so the wardrobe doesn't
        // block the bathroom door clearance.
        const bathObstZones = obstructionZonesByRoom.get(bathroomRoom!.name) || [];
        const blocksBathDoor = overlapsObstruction(wx, wy, ww / 2, wh / 2, bathObstZones);

        if (isFurnitureInBounds(wx, wy, ww, wh, room) &&
            !collidesWithExisting(wx, wy, ww, wh, room.name, placed, "wardrobe") &&
            !blocksBathDoor) {
          wardResult = { itemId: "wardrobe", room: room.name, x: wx, y: wy, rotation: wRot, scale: wardScale };
        }
      }

      // Fallback: try wallPlace with bathroom wall priority if direct placement failed
      if (!wardResult) {
        const wardRotations: Array<{ rot: 0 | 90 | 180 | 270; label: string }> = [];

        const addWardPriority = (rot: 0 | 90 | 180 | 270, label: string) => {
          if (!wardRotations.some(w => w.rot === rot)) wardRotations.push({ rot, label });
        };

        if (bathroomWall === "right") addWardPriority(90, "bathroom wall (right)");
        else if (bathroomWall === "left") addWardPriority(270, "bathroom wall (left)");
        else if (bathroomWall === "top") addWardPriority(0, "bathroom wall (top)");
        else if (bathroomWall === "bottom") addWardPriority(180, "bathroom wall (bottom)");

        if (bedWall === "top") addWardPriority(180, "opposite bed (bottom)");
        else if (bedWall === "bottom") addWardPriority(0, "opposite bed (top)");
        else if (bedWall === "left") addWardPriority(90, "opposite bed (right)");
        else if (bedWall === "right") addWardPriority(270, "opposite bed (left)");

        for (const r of [0, 90, 180, 270] as const) addWardPriority(r, `fallback rot=${r}`);

        for (const { rot } of wardRotations) {
          wardResult = wallPlace("wardrobe", room, rot, 0.8, placed, obstZones, 0.04);
          if (wardResult) break;
        }
        if (!wardResult) {
          for (const scale of [0.7, 0.6, 0.5]) {
            for (const { rot } of wardRotations) {
              wardResult = wallPlace("wardrobe", room, rot, scale, placed, obstZones, 0.04);
              if (wardResult) break;
            }
            if (wardResult) break;
          }
        }
      }

      if (wardResult) placed.push(wardResult);

      // ═══════════════════════════════════════════════════════════════
      //  ZONE 3: KITCHEN — counter + fridge on dedicated kitchen wall
      // ═══════════════════════════════════════════════════════════════
      // Determine the kitchen zone wall: the wall NOT used by TV, NOT
      // used by bed, and NOT the bathroom wall. In a well-zoned studio
      // this is typically the wall opposite the living zone.
      if (roomArea >= 18) {
        // Build set of walls already claimed by other zones
        const claimedWalls = new Set<string>();
        if (tvWall) claimedWalls.add(tvWall);
        if (bedWall) claimedWalls.add(bedWall);
        if (bathroomWall) claimedWalls.add(bathroomWall);

        // Kitchen wall priority: unclaimed walls first, then walls shared
        // with bathroom (natural pairing: kitchen near plumbing)
        type KW = { wall: string; rot: 0 | 90 | 180 | 270 };
        const kitchenWallCandidates: KW[] = [];

        // Preferred: bathroom wall (plumbing makes sense for kitchen)
        if (bathroomWall === "right") kitchenWallCandidates.push({ wall: "right", rot: 90 });
        else if (bathroomWall === "left") kitchenWallCandidates.push({ wall: "left", rot: 270 });
        else if (bathroomWall === "top") kitchenWallCandidates.push({ wall: "top", rot: 0 });
        else if (bathroomWall === "bottom") kitchenWallCandidates.push({ wall: "bottom", rot: 180 });

        // Fallback: any unclaimed wall
        const allWalls: KW[] = [
          { wall: "right", rot: 90 },
          { wall: "left", rot: 270 },
          { wall: "top", rot: 0 },
          { wall: "bottom", rot: 180 },
        ];
        for (const kw of allWalls) {
          if (!kitchenWallCandidates.some(k => k.wall === kw.wall)) {
            kitchenWallCandidates.push(kw);
          }
        }

        // Place counter on the best available kitchen wall — FLUSH against
        // the wall (0.04m), same as wall cabinets.
        const counterId = roomArea < 24 ? "kitchen-counter-small" : "kitchen-counter-straight";
        let counterResult: PlacedFurniture | null = null;
        for (const kw of kitchenWallCandidates) {
          counterResult = wallPlace(counterId, room, kw.rot, 0.85, placed, obstZones, 0.04);
          if (counterResult) {
            console.log(`[kitchen-zone] counter on ${kw.wall} wall ✅`);
            break;
          }
        }
        // If no kitchen wall works, try any wall as last resort
        if (!counterResult) {
          counterResult = wallPlace(counterId, room, 0, 0.85, placed, obstZones, 0.04);
          if (!counterResult) {
            counterResult = wallPlace(counterId, room, 90, 0.85, placed, obstZones, 0.04);
          }
        }
        if (counterResult) placed.push(counterResult);

        // Fridge: wall-place on the counter's wall, or an adjacent wall.
        // NEVER the opposite wall — the fridge stays with the cooking area.
        if (counterResult) {
          // Determine the counter's wall from its rotation and position
          const cRot = counterResult.rotation;
          let fridgeWallRot: 0 | 90 | 180 | 270;
          if (cRot === 0 || cRot === 180) {
            // Counter horizontal (top/bottom wall) — fridge on same wall
            fridgeWallRot = cRot as 0 | 180;
          } else {
            // Counter vertical (left/right wall) — fridge on same wall
            fridgeWallRot = cRot as 90 | 270;
          }

          // Try wallPlace on the counter's wall
          let fridgeResult = wallPlace("refrigerator", room, fridgeWallRot, 1.0, placed, obstZones);
          if (!fridgeResult) {
            // Try smaller scale on same wall
            fridgeResult = wallPlace("refrigerator", room, fridgeWallRot, 0.85, placed, obstZones);
          }
          if (!fridgeResult) {
            // Try adjacent wall (perpendicular to counter wall)
            const adjRot = (fridgeWallRot + 90) % 360 as 0 | 90 | 180 | 270;
            fridgeResult = wallPlace("refrigerator", room, adjRot, 0.9, placed, obstZones);
          }

          if (fridgeResult) {
            placed.push(fridgeResult);
          } else {
            console.log(`[kitchen-zone] fridge ❌ no wall position fits — skipped (never float to center)`);
          }
        }
      }

      // ── Dining set (if large enough) ──
      if (roomArea >= 22 && rw >= 3.5 && rh >= 4) {
        const diningConfigs = getDiningConfigs(roomArea);
        let diningPlaced = false;
        for (const config of diningConfigs) {
          const result = placeDiningSet(room, config, placed, obstZones);
          if (result) { for (const pf of result) placed.push(pf); diningPlaced = true; break; }
        }
        if (!diningPlaced) console.log(`[studio dining] "${room.name}" ❌ no config fits`);
      }

      // ── Plant ──
      if (minDim >= 2.5) {
        placed.push({ itemId: "plant-indoor", room: room.name, x: room.x + 0.3, y: room.y + 0.3, rotation: 0, scale: 1.0 });
      }
    }

    /* ---- LIVING ROOM (door-aware) ---- */
    if (/living|lounge|family|media/i.test(name) && !/studio/i.test(name)) {
      const obstZones = obstructionZonesByRoom.get(room.name) || [];

      // Door zones carry the full clearance (swing side 0.7m, opposite side
      // 0.3m, +0.2m along-wall margin matching the overlay rects) — the
      // living set keeps no extra distance beyond the zone itself.
      const TV_DOOR_CLEARANCE = 0;

      // Split zones: doors are HARD blockers for the TV wall (the TV must be
      // placed on a different wall), windows are soft blockers (avoided when
      // possible, but a wall with a window is still acceptable for the TV).
      const { doorZones, windowZones } = splitZones(obstZones);

      const zoneOnWall = (wall: string, z: ObstructionZone): boolean => {
        switch (wall) {
          case "bottom": return Math.abs(z.y - (room.y + z.halfH)) < 0.3;
          case "top": return Math.abs(z.y - (room.y + room.height - z.halfH)) < 0.3;
          case "left": return Math.abs(z.x - (room.x + z.halfW)) < 0.3;
          case "right": return Math.abs(z.x - (room.x + room.width - z.halfW)) < 0.3;
          default: return false;
        }
      };
      const wallHasDoor = (wall: string) => doorZones.some(z => zoneOnWall(wall, z));
      const wallHasWindow = (wall: string) => windowZones.some(z => zoneOnWall(wall, z));

      // Axis-aware door clearance: `clearance` applies on the approach axis
      // (perpendicular to the door's wall, i.e. "in front of" the door).
      // The zones already carry the 0.2m along-wall margin (same as the
      // yellow/blue overlay rects); the 0.05m overlap margin is identical to
      // overlapsObstruction so placement and validation always agree.
      const doorClearanceBlocks = (
        x: number, y: number,
        hw: number, hh: number,
        clearance: number
      ): boolean => {
        for (const z of doorZones) {
          const onBottom = Math.abs(z.y - (room.y + z.halfH)) < 0.3;
          const onTop = Math.abs(z.y - (room.y + room.height - z.halfH)) < 0.3;
          const onLeft = Math.abs(z.x - (room.x + z.halfW)) < 0.3;
          const onRight = Math.abs(z.x - (room.x + room.width - z.halfW)) < 0.3;
          if (onBottom || onTop) {
            if (Math.abs(y - z.y) < hh + z.halfH + clearance + 0.05 &&
                Math.abs(x - z.x) < hw + z.halfW + 0.05) return true;
          } else if (onLeft || onRight) {
            if (Math.abs(x - z.x) < hw + z.halfW + clearance + 0.05 &&
                Math.abs(y - z.y) < hh + z.halfH + 0.05) return true;
          } else {
            // Unknown orientation — conservative check on both axes.
            if (Math.abs(x - z.x) < hw + z.halfW + clearance + 0.05 &&
                Math.abs(y - z.y) < hh + z.halfH + clearance + 0.05) return true;
          }
        }
        return false;
      };

      // ── TV wall selection — STRICT rule: never a wall with a door. ──
      // Walls are tried in order: door-free without windows → door-free with
      // windows (a window is a soft last resort) → all-doors fallback wall.
      const wallOrder: Array<"bottom" | "top" | "left" | "right"> = ["bottom", "top", "left", "right"];
      const doorFreeWalls = wallOrder.filter(w => !wallHasDoor(w));
      const wallsToTry: Array<"bottom" | "top" | "left" | "right"> = [
        ...doorFreeWalls.filter(w => !wallHasWindow(w)),
        ...doorFreeWalls.filter(w => wallHasWindow(w)),
      ];

      let fallbackWall: "bottom" | "top" | "left" | "right" = "bottom";
      if (wallsToTry.length === 0) {
        // Every wall has a door — last resort: pick the wall whose nearest
        // door is farthest from the wall center (best corner shot).
        let bestScore = -Infinity;
        for (const w of wallOrder) {
          const isHorizontal = w === "bottom" || w === "top";
          const mid = isHorizontal ? room.x + rw / 2 : room.y + rh / 2;
          const score = doorZones.filter(z => zoneOnWall(w, z)).reduce((min, z) => {
            const along = isHorizontal ? z.x : z.y;
            const halfSpan = isHorizontal ? z.halfW : z.halfH;
            return Math.min(min, Math.abs(along - mid) - halfSpan);
          }, Infinity);
          if (score > bestScore) { bestScore = score; fallbackWall = w; }
        }
        wallsToTry.push(fallbackWall);
      }

      const tvItem = getFurnitureById("tv-unit");
      const tvWorldW = tvItem ? tvItem.width : 1.4;   // along-wall extent at rot 0/180
      const tvWorldH = tvItem ? tvItem.height : 0.4;  // depth into the room at rot 0/180
      const tvHalfH = tvWorldH / 2;
      const sofa3 = getFurnitureById("sofa-3-seater");
      const sofa2 = getFurnitureById("sofa-2-seater");
      const coffeeItem = getFurnitureById("coffee-table");
      const coffeeDims = coffeeItem
        ? { w: coffeeItem.width, h: coffeeItem.height }
        : { w: 1.1, h: 0.6 };
      const sofaDepthHalf = ((sofa3?.height ?? 0.9) * roomScale) / 2;
      const coffeeDepthHalf = (coffeeDims.h * roomScale) / 2;

      // Spacing profiles: standard (generous) for larger rooms and compact
      // (tight) for small rooms. The group fit tries standard first and falls
      // back to compact when the room can't fit the generous arrangement.
      const spacingProfiles = (wall: "bottom" | "top" | "left" | "right") => {
        if (wall !== "bottom" && wall !== "top") {
          return [{ tvY: cy, coffeeY: cy, sofaY: cy }];
        }
        const isBottom = wall === "bottom";
        const sign = isBottom ? 1 : -1;
        const stdTvY = isBottom ? room.y + rh * 0.12 : room.y + rh * 0.88;
        const stdCoffeeY = isBottom ? room.y + rh * 0.45 : room.y + rh * 0.55;
        const stdSofaY = isBottom ? room.y + rh * 0.72 : room.y + rh * 0.28;
        const compactTvY = isBottom ? room.y + 0.1 + tvHalfH : room.y + rh - 0.1 - tvHalfH;
        const compactCoffeeY = compactTvY + sign * (tvHalfH + 0.4 + coffeeDepthHalf);
        const compactSofaY = compactCoffeeY + sign * (coffeeDepthHalf + 0.5 + sofaDepthHalf);
        return [
          { tvY: stdTvY, coffeeY: stdCoffeeY, sofaY: stdSofaY },
          { tvY: compactTvY, coffeeY: compactCoffeeY, sofaY: compactSofaY },
        ];
      };

      interface WallGroup {
        wall: "bottom" | "top" | "left" | "right";
        sofaId: string;
        withCoffee: boolean;
        tvX: number; tvY: number; tvRot: 0 | 90 | 180 | 270;
        sofaX: number; sofaY: number; sofaRot: 0 | 90 | 180 | 270;
      }

      // Fit the sofa (+ coffee + TV) group on a wall. The shared along-wall
      // position is constrained by the SOFA (longer than the TV) so the sofa
      // always stays fully inside the room — orientation is never broken.
      // `includeCoffee` false drops the coffee table (first component to go).
      const tryWallGroupFit = (
        wall: "bottom" | "top" | "left" | "right",
        sofaItem: FurnitureItem,
        includeCoffee: boolean
      ): WallGroup | null => {
        const isHorizontal = wall === "bottom" || wall === "top";
        const roomLen = isHorizontal ? rw : rh;
        const roomStart = isHorizontal ? room.x : room.y;
        const mid = isHorizontal ? cx : cy;

        const sofaHalf = (sofaItem.width * roomScale) / 2;
        const tvHalf = tvWorldW / 2;
        const half = Math.max(sofaHalf, tvHalf);
        const lo = roomStart + half;
        const hi = roomStart + roomLen - half;
        if (hi < lo) return null; // sofa cannot fit along this wall at all

        const cands = [mid, lo + 0.15, hi - 0.15, roomStart + roomLen * 0.3, roomStart + roomLen * 0.7]
          .filter(v => v >= lo && v <= hi)
          .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));

        for (const profile of spacingProfiles(wall)) {
          for (const cand of cands) {
            const isVert = wall === "left" || wall === "right";
            const tvX = isVert ? (wall === "left" ? room.x + rw * 0.12 : room.x + rw * 0.88) : cand;
            const tvPosY = isVert ? cand : profile.tvY;
            const tvRot: 0 | 90 | 180 | 270 = isVert ? (wall === "left" ? 90 : 270) : 0;
            const tw = isVert ? tvWorldH : tvWorldW;
            const th = isVert ? tvWorldW : tvWorldH;

            if (!isFurnitureInBounds(tvX, tvPosY, tw, th, room)) continue;

            if (doorClearanceBlocks(tvX, tvPosY, tw / 2, th / 2, TV_DOOR_CLEARANCE)) continue;
            // Windows are SOFT for the TV (a low item): a window wall is only
            // used as a last resort (wall selection prefers window-free
            // walls) and the spacing profiles already keep the TV ~0.1m off
            // the wall — a little clearance in front of the window.

            // Sofa directly across from the TV. For side walls the sofa may
            // float inward (off a wall that carries a door zone) — the
            // orientation is preserved because it stays on the same axis.
            const sofaFracs = isVert
              ? (wall === "left" ? [0.85, 0.7, 0.55, 0.4] : [0.15, 0.3, 0.45, 0.6])
              : [cand];
            for (const sofaXFrac of sofaFracs) {
              const sofaX = isVert ? room.x + rw * sofaXFrac : sofaXFrac;
              const sofaPosY = isVert ? cand : profile.sofaY;
              const sofaRot: 0 | 90 | 180 | 270 = isVert
                ? (wall === "left" ? 90 : 270)
                : (wall === "bottom" ? 0 : 180);
              const sofaW = isVert ? sofaItem.height * roomScale : sofaItem.width * roomScale;
              const sofaH = isVert ? sofaItem.width * roomScale : sofaItem.height * roomScale;
              if (!isFurnitureInBounds(sofaX, sofaPosY, sofaW, sofaH, room)) continue;

              if (doorClearanceBlocks(sofaX, sofaPosY, sofaW / 2, sofaH / 2, TV_DOOR_CLEARANCE)) continue;

              // Member-vs-member collision check — the set must survive
              // validation (same 0.05m margin) so it is never placed and
              // then broken apart into collision drops.
              const memberOverlap = (
                ax: number, ay: number, ahw: number, ahh: number,
                bx: number, by: number, bhw: number, bhh: number
              ) =>
                Math.abs(ax - bx) < ahw + bhw + 0.05 &&
                Math.abs(ay - by) < ahh + bhh + 0.05;

              if (memberOverlap(tvX, tvPosY, tw / 2, th / 2, sofaX, sofaPosY, sofaW / 2, sofaH / 2)) continue;

              if (includeCoffee) {
                // Coffee table on the axis between TV and sofa — same
                // clearance. Position matches the one actually pushed
                // (midpoint for horizontal walls).
                const coffeeX = isVert ? (sofaX + tvX) / 2 : cand;
                const coffeePosY = isVert ? cand : (tvPosY + sofaPosY) / 2;
                const coffeeW = (isVert ? coffeeDims.h : coffeeDims.w) * roomScale;
                const coffeeH = (isVert ? coffeeDims.w : coffeeDims.h) * roomScale;
                if (doorClearanceBlocks(coffeeX, coffeePosY, coffeeW / 2, coffeeH / 2, TV_DOOR_CLEARANCE)) continue;
                if (memberOverlap(coffeeX, coffeePosY, coffeeW / 2, coffeeH / 2, tvX, tvPosY, tw / 2, th / 2)) continue;
                if (memberOverlap(coffeeX, coffeePosY, coffeeW / 2, coffeeH / 2, sofaX, sofaPosY, sofaW / 2, sofaH / 2)) continue;
              }

              return {
                wall,
                sofaId: sofaItem.id,
                withCoffee: includeCoffee,
                tvX, tvY: tvPosY, tvRot,
                sofaX, sofaY: sofaPosY, sofaRot,
              };
            }
          }
        }
        return null;
      };

      // ── Last resort: diagonal corner arrangement ──
      // TV in one corner (back against the two walls, triangle behind it),
      // sofa in the opposite corner, coffee table at the midpoint — all three
      // running on the diagonal line between the two corners.
      interface DiagGroup {
        sofaId: string;
        withCoffee: boolean;
        tvX: number; tvY: number; tvRot: FurnitureOrientation;
        sofaX: number; sofaY: number; sofaRot: FurnitureOrientation;
        coffeeX: number; coffeeY: number; coffeeRot: FurnitureOrientation;
      }
      const tryDiagonalFit = (includeCoffee: boolean): DiagGroup | null => {
        const diagHalf = (w: number, h: number, s: number) =>
          (Math.abs(w * Math.SQRT1_2) + Math.abs(h * Math.SQRT1_2)) / 2 * s;
        const sofaChoices = [sofa3, sofa2].filter((s): s is FurnitureItem => !!s);
        const diagonals: Array<{
          tvFromLeft: boolean; tvFromBottom: boolean;
          tvRot: FurnitureOrientation; sofaRot: FurnitureOrientation;
        }> = [
          // TV at bottom-left corner (225°) ↔ sofa at top-right corner (45°)
          { tvFromLeft: true, tvFromBottom: true, tvRot: 225, sofaRot: 45 },
          // TV at top-left corner (45°) ↔ sofa at bottom-right corner (315°)
          { tvFromLeft: true, tvFromBottom: false, tvRot: 45, sofaRot: 315 },
        ];

        for (const d of diagonals) {
          for (const sofaItem of sofaChoices) {
            const tvHalf = diagHalf(tvWorldW, tvWorldH, 1.0);
            const sofaHalf = diagHalf(sofaItem.width, sofaItem.height, roomScale);
            const coffeeHalf = diagHalf(coffeeDims.w, coffeeDims.h, roomScale);

            const tvX = d.tvFromLeft ? room.x + tvHalf + 0.15 : room.x + rw - tvHalf - 0.15;
            const tvY = d.tvFromBottom ? room.y + tvHalf + 0.15 : room.y + rh - tvHalf - 0.15;
            const sofaX = d.tvFromLeft ? room.x + rw - sofaHalf - 0.15 : room.x + sofaHalf + 0.15;
            const sofaY = d.tvFromBottom ? room.y + rh - sofaHalf - 0.15 : room.y + sofaHalf + 0.15;
            const coffeeX = (tvX + sofaX) / 2;
            const coffeeY = (tvY + sofaY) / 2;

            const inBounds = (x: number, y: number, half: number) =>
              x - half >= room.x - 1e-9 && x + half <= room.x + rw + 1e-9 &&
              y - half >= room.y - 1e-9 && y + half <= room.y + rh + 1e-9;
            if (!inBounds(tvX, tvY, tvHalf)) continue;
            if (!inBounds(sofaX, sofaY, sofaHalf)) continue;
            if (includeCoffee && !inBounds(coffeeX, coffeeY, coffeeHalf)) continue;

            // Standard door clearance for the whole set.
            const tvBlocksDoor = doorClearanceBlocks(tvX, tvY, tvHalf, tvHalf, TV_DOOR_CLEARANCE);
            const sofaBlocksDoor = doorClearanceBlocks(sofaX, sofaY, sofaHalf, sofaHalf, TV_DOOR_CLEARANCE);
            const coffeeBlocksDoor = includeCoffee &&
              doorClearanceBlocks(coffeeX, coffeeY, coffeeHalf, coffeeHalf, TV_DOOR_CLEARANCE);
            if (tvBlocksDoor || sofaBlocksDoor || coffeeBlocksDoor) continue;

            // Member-vs-member overlap (same 0.05m margin as validation).
            const pairOverlap = (
              ax: number, ay: number, ah: number,
              bx: number, by: number, bh: number
            ) =>
              Math.abs(ax - bx) < ah + bh + 0.05 &&
              Math.abs(ay - by) < ah + bh + 0.05;
            if (pairOverlap(tvX, tvY, tvHalf, sofaX, sofaY, sofaHalf)) continue;
            if (includeCoffee &&
                (pairOverlap(coffeeX, coffeeY, coffeeHalf, tvX, tvY, tvHalf) ||
                 pairOverlap(coffeeX, coffeeY, coffeeHalf, sofaX, sofaY, sofaHalf))) continue;

            return {
              sofaId: sofaItem.id,
              withCoffee: includeCoffee,
              tvX, tvY, tvRot: d.tvRot,
              sofaX, sofaY, sofaRot: d.sofaRot,
              coffeeX, coffeeY, coffeeRot: d.sofaRot,
            };
          }
        }
        return null;
      };

      // ── Fit chain ──
      // Full set on walls (standard then compact) → full set on the diagonal
      // → drop the coffee table → drop TV → sofa last. Compact spacing is
      // tried inside every wall fit BEFORE any component is removed.
      let group: WallGroup | null = null;
      for (const wall of wallsToTry) {
        if (sofa3) { group = tryWallGroupFit(wall, sofa3, true); if (group) break; }
        if (sofa2) { group = tryWallGroupFit(wall, sofa2, true); if (group) break; }
      }
      let diag: DiagGroup | null = group ? null : tryDiagonalFit(true);

      if (!group && !diag) {
        // First to go: coffee table + rug.
        for (const wall of wallsToTry) {
          if (sofa3) { group = tryWallGroupFit(wall, sofa3, false); if (group) break; }
          if (sofa2) { group = tryWallGroupFit(wall, sofa2, false); if (group) break; }
        }
        if (!group) diag = tryDiagonalFit(false);
      }

      // ── Place sofa + coffee + TV (orientation always preserved) ──
      let coffeePos: { x: number; y: number; rot: FurnitureOrientation } | null = null;

      if (group) {
        placed.push({
          itemId: group.sofaId, room: room.name,
          x: group.sofaX, y: group.sofaY, rotation: group.sofaRot, scale: roomScale,
        });
        if (group.withCoffee && roomArea >= 15 && coffeeItem) {
          const isVert = group.wall === "left" || group.wall === "right";
          coffeePos = {
            x: isVert ? (group.sofaX + group.tvX) / 2 : group.tvX,
            y: isVert ? group.tvY : (group.sofaY + group.tvY) / 2,
            rot: isVert ? 90 : 0,
          };
          placed.push({
            itemId: "coffee-table", room: room.name,
            x: coffeePos.x, y: coffeePos.y, rotation: coffeePos.rot, scale: roomScale,
          });
        }
        if (tvItem && (rw >= 1.5 || rh >= 1.5)) {
          placed.push({
            itemId: "tv-unit", room: room.name,
            x: group.tvX, y: group.tvY, rotation: group.tvRot, scale: 1.0,
          });
        }
      } else if (diag) {
        placed.push({
          itemId: diag.sofaId, room: room.name,
          x: diag.sofaX, y: diag.sofaY, rotation: diag.sofaRot, scale: roomScale,
        });
        if (diag.withCoffee && roomArea >= 15 && coffeeItem) {
          coffeePos = { x: diag.coffeeX, y: diag.coffeeY, rot: diag.coffeeRot };
          placed.push({
            itemId: "coffee-table", room: room.name,
            x: coffeePos.x, y: coffeePos.y, rotation: coffeePos.rot, scale: roomScale,
          });
        }
        if (tvItem && (rw >= 1.5 || rh >= 1.5)) {
          placed.push({
            itemId: "tv-unit", room: room.name,
            x: diag.tvX, y: diag.tvY, rotation: diag.tvRot, scale: 1.0,
          });
        }
      } else {
        // Last resort: sofa alone — coffee table and TV are gone (the rug
        // stays, anchored under the sofa). The sofa is the last component to
        // go and only disappears if no spot keeps the door clearance.
        const sofaItem = sofa3 ?? sofa2;
        if (sofaItem) {
          const sofaW = sofaItem.width * roomScale;
          const sofaH = sofaItem.height * roomScale;
          for (const y of [cy, room.y + rh * 0.35, room.y + rh * 0.65, room.y + rh * 0.8, room.y + rh * 0.2]) {
            const blocksDoor = doorClearanceBlocks(cx, y, sofaW / 2, sofaH / 2, TV_DOOR_CLEARANCE);
            if (!blocksDoor && isFurnitureInBounds(cx, y, sofaW, sofaH, room) &&
                !collidesWithExisting(cx, y, sofaW, sofaH, room.name, placed, sofaItem.id)) {
              placed.push({ itemId: sofaItem.id, room: room.name, x: cx, y, rotation: 0, scale: roomScale });
              break;
            }
          }
        }
      }

      // Armchairs for larger rooms (only for the classic wall-aligned group)
      if (!room.hasKitchenZone && roomArea >= 25 && group && (group.wall === "bottom" || group.wall === "top")) {
        const pushArmchair = (ax: number, ay: number, rot: 90 | 270) => {
          if (!collidesWithExisting(ax, ay, 0.8, 0.8, room.name, placed, "armchair")) {
            placed.push({ itemId: "armchair", room: room.name, x: ax, y: ay, rotation: rot, scale: 1.0 });
          }
        };
        pushArmchair(room.x + rw * 0.15, room.y + rh * 0.45, 270);
        pushArmchair(room.x + rw * 0.85, room.y + rh * 0.45, 90);
      }

      // Rug — STRICTLY anchored: only under the coffee table (or at the foot
      // of a bed in studios). No coffee table → no rug. Never a floating rug.
      if (coffeePos) {
        placed.push({
          itemId: "rug-large",
          room: room.name,
          x: coffeePos.x,
          y: coffeePos.y,
          rotation: 0,
          scale: roomScale,
        });
      }

      // Side tables — near sofa (only for the classic wall-aligned group),
      // skipped if they would collide.
      if (rw >= 3 && group && (group.wall === "bottom" || group.wall === "top")) {
        const sofaSide = group.wall === "bottom" ? rh * 0.7 : rh * 0.3;
        const pushSideTable = (stx: number) => {
          if (!collidesWithExisting(stx, room.y + sofaSide, 0.5, 0.5, room.name, placed, "side-table")) {
            placed.push({
              itemId: "side-table",
              room: room.name,
              x: stx,
              y: room.y + sofaSide,
              rotation: 0,
              scale: 1.0,
            });
          }
        };
        pushSideTable(room.x + rw * 0.12);
        pushSideTable(room.x + rw * 0.88);
      }

      // ── Kitchen zone in living room (open-plan, studio-style) ──
      // Kitchen appliances belong to a dedicated kitchen/cooking room when
      // one exists — never scatter them across the living room.
      const hasDedicatedKitchen = rooms.some(r =>
        r.name !== room.name && /kitchen|kitchenette|cooking|pantry/i.test(r.name)
      );
      if (room.hasKitchenZone && roomArea >= 18 && !hasDedicatedKitchen) {
        const counterId = roomArea < 24 ? "kitchen-counter-small" : "kitchen-counter-straight";
        // The counter's LONG side must sit on a wall (plumbing + space use),
        // FLUSH against it (0.04m). Prefer the wall OPPOSITE the TV
        // arrangement; window walls are fine (counters are low — windows are
        // soft for them).
        const tvOnSideWall = group !== null && (group.wall === "left" || group.wall === "right");
        const counterRot = tvOnSideWall ? 0 : 90;
        let counterResult = wallPlace(counterId, room, counterRot, 0.85, placed, obstZones, 0.04);
        if (!counterResult) {
          counterResult = wallPlace(counterId, room, counterRot === 0 ? 90 : 0, 0.85, placed, obstZones, 0.04);
        }
        if (!counterResult) {
          for (const rot of [0, 90, 180, 270]) {
            counterResult = wallPlace(counterId, room, rot, 0.85, placed, obstZones, 0.04);
            if (counterResult) break;
          }
        }
        if (counterResult) placed.push(counterResult);

        // Fridge: wall-place on same wall as counter, or an adjacent wall —
        // never the opposite wall (the fridge stays with the cooking area).
        if (counterResult) {
          const cRot = counterResult.rotation;
          const fridgeWallRot: 0 | 90 | 180 | 270 = cRot as 0 | 90 | 180 | 270;
          let fridgeResult = wallPlace("refrigerator", room, fridgeWallRot, 1.0, placed, obstZones);
          if (!fridgeResult) {
            fridgeResult = wallPlace("refrigerator", room, fridgeWallRot, 0.85, placed, obstZones);
          }
          if (!fridgeResult) {
            const adjRot = (fridgeWallRot + 90) % 360 as 0 | 90 | 180 | 270;
            fridgeResult = wallPlace("refrigerator", room, adjRot, 0.9, placed, obstZones);
          }
          if (fridgeResult) placed.push(fridgeResult);
        }

        // UPPER wall cabinets near the counter — tall, strictly forbidden in
        // front of windows (windows stay hard for them in wallPlace).
        const cabObstZones = obstructionZonesByRoom.get(room.name) || [];
        for (const cabRot of [0, 90, 270, 180] as const) {
          const cabResult = wallPlace("wall-cabinet", room, cabRot, 1.0, placed, cabObstZones, 0.04);
          if (cabResult) { placed.push(cabResult); break; }
        }
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
        // First corner that avoids door/window zones AND existing furniture.
        const bestCorner = plantCorners.find(c =>
          !overlapsObstruction(c.x, c.y, plantHalf, plantHalf, obstZones) &&
          !collidesWithExisting(c.x, c.y, plantHalf * 2, plantHalf * 2, room.name, placed, "plant-indoor")
        );

        if (bestCorner) {
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
    }

    /* ---- DINING ROOM — atomic table + chairs set ---- */
    if (/dining/i.test(name)) {
      const diningObstZones = obstructionZonesByRoom.get(room.name) || [];
      const configs = getDiningConfigs(roomArea);

      let diningPlaced = false;
      for (const config of configs) {
        const result = placeDiningSet(room, config, placed, diningObstZones);
        if (result) {
          for (const pf of result) placed.push(pf);
          diningPlaced = true;
          break;
        }
      }
      if (!diningPlaced) {
        console.log(`[dining] "${room.name}" (${roomArea.toFixed(0)}m²) ❌ no config fits`);
      }
    }

    /* ---- BEDROOM — guaranteed bed + wardrobe ---- */
    if (/bedroom|master|guest|kids/i.test(name) && !/bathroom|ensuite|studio/i.test(name)) {
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

      // ALWAYS horizontal (rot=0). Headboard against the BACK wall.
      // If the bed is too wide for the room, scale down to fit.
      // No rotation — eliminates all headboard-placement complexity.
      let bedY = cy;
      let bedX = cx;
      let bedWorldH = 0;
      let bedWorldW = 0;
      if (bed) {
        let bedScale = (roomArea < 9 ? 0.85 : 1.0);
        // Scale down if bed is wider than room
        if (bed.width * bedScale > rw - 0.3) {
          bedScale = (rw - 0.3) / bed.width;
        }
        bedWorldW = bed.width * bedScale;
        bedWorldH = bed.height * bedScale;

        // Headboard (local y=0) maps to world y = bedY + bedWorldH/2 (due to Y-flip in toCanvas)
        // Place against BACK wall: bedY + bedWorldH/2 = room.y + room.height - 0.15
        bedY = room.y + room.height - bedWorldH / 2 - 0.15;
        bedX = cx;
        // Door clearance is a HARD NO — the bed must never overlap a door
        // zone. Shift along the headboard wall, then shrink, until it clears.
        const bedObstZones = obstructionZonesByRoom.get(room.name) || [];
        const bedDoorZones = splitZones(bedObstZones).doorZones;
        const bedClear = (bx: number, s: number) =>
          !overlapsObstruction(bx, bedY, (bedWorldW * s) / 2, (bedWorldH * s) / 2, bedDoorZones) &&
          isFurnitureInBounds(bx, bedY, bedWorldW * s, bedWorldH * s, room);
        const bedShiftCands = [
          cx,
          room.x + bedWorldW / 2 + 0.3,
          room.x + rw - bedWorldW / 2 - 0.3,
          room.x + rw * 0.25,
          room.x + rw * 0.75,
        ];
        let bedClearFound = false;
        for (const bx of bedShiftCands) {
          if (bedClear(bx, 1)) { bedX = bx; bedClearFound = true; break; }
        }
        if (!bedClearFound) {
          for (const s of [0.9, 0.8, 0.7]) {
            for (const bx of bedShiftCands) {
              if (bedClear(bx, s)) {
                bedX = bx;
                bedScale = s;
                bedClearFound = true;
                break;
              }
            }
            if (bedClearFound) break;
          }
        }
        bedWorldW = bed.width * bedScale;
        bedWorldH = bed.height * bedScale;

        console.log(`[bed] "${bedId}" in "${room.name}" rot=0 wh=(${bedWorldW.toFixed(2)},${bedWorldH.toFixed(2)}) center=(${bedX.toFixed(2)},${bedY.toFixed(2)}) room=${rw.toFixed(1)}×${rh.toFixed(1)}`);

        placed.push({
          itemId: bedId,
          room: room.name,
          x: bedX,
          y: bedY,
          rotation: 0,
          scale: bedScale,
        });

        // Side tables flanking the headboard along the back wall — skipped
        // if they would land inside a door clearance zone.
        const stX1 = bedX - bedWorldW / 2 - 0.3;
        const stX2 = bedX + bedWorldW / 2 + 0.3;
        const stY = room.y + room.height - 0.3;
        const pushSideTable = (stX: number) => {
          if (!overlapsObstruction(stX, stY, 0.3, 0.3, bedDoorZones)) {
            placed.push({ itemId: "side-table", room: room.name, x: stX, y: stY, rotation: 0, scale: bedScale });
          }
        };
        pushSideTable(stX1);
        if (roomArea >= 12) pushSideTable(stX2);
      }

      // Wardrobe — always flush against a plain wall, avoiding doors/windows.
      // Gap from the wall must be < 0.05m; if no wall position fits at any
      // scale, the wardrobe is left out entirely (never placed mid-room).
      const wardScale = minDim >= 3 ? 1.0 : 0.8;
      const wardObstZones = obstructionZonesByRoom.get(room.name) || [];
      let wardResult: PlacedFurniture | null = null;
      const wardRotations = [90, 270, 0, 180];
      for (const wr of wardRotations) {
        wardResult = wallPlace("wardrobe", room, wr as 0 | 90 | 180 | 270, wardScale, placed, wardObstZones, 0.04);
        if (wardResult) break;
      }
      // Try smaller scales
      if (!wardResult) {
        for (const scale of [0.75, 0.65, 0.55]) {
          for (const wr of wardRotations) {
            wardResult = wallPlace("wardrobe", room, wr as 0 | 90 | 180 | 270, scale, placed, wardObstZones, 0.04);
            if (wardResult) break;
          }
          if (wardResult) break;
        }
      }
      if (wardResult) placed.push(wardResult);

      // Desk for master or larger bedrooms — atomic desk + chair set
      if (roomArea >= 14 && rw >= 2 && rh >= 2.5) {
        const bedObstZones = obstructionZonesByRoom.get(room.name) || [];
        const deskSet = placeDeskSet(
          room, room.x + rw - 0.9, room.y + rh - 0.5, 0, 0.9,
          placed, bedObstZones
        );
        if (deskSet) {
          for (const pf of deskSet) placed.push(pf);
        }
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

    /* ---- KITCHEN / KITCHENETTE / COOKING AREA — counter on wall ---- */
    if (/kitchen|kitchenette|cooking/i.test(name) && !/studio/i.test(name)) {
      const roomDoors = doors.filter(d => d.room === room.name);
      const livingRoomDoor = roomDoors.find(d => d.width >= 0.8);
      const passageWall: Door["wall"] | null = livingRoomDoor?.wall ?? null;

      // Counter wall: opposite the passage, or bottom by default
      const counterWall: Door["wall"] = passageWall === "bottom" ? "top"
        : passageWall === "top" ? "bottom"
        : passageWall === "left" ? "right"
        : passageWall === "right" ? "left"
        : "bottom";

      // Rotation family: horizontal counters on top/bottom walls, vertical
      // on left/right walls. wallPlace keeps the LONG side along the wall.
      const cRot = counterWall === "bottom" || counterWall === "top" ? 0 : 90;

      const counterId = roomArea < 8 ? "kitchen-counter-small" : "kitchen-counter-straight";
      const counterScale = roomArea < 8 ? 0.85 : 0.9;
      // The counter's LONG side must sit on a wall (plumbing + space use) —
      // FLUSH against it (0.04m), never float to the room center. Window
      // walls are fine (low item).
      const kitchenObstZones = obstructionZonesByRoom.get(room.name) || [];
      let cResult = wallPlace(counterId, room, cRot, counterScale, placed, kitchenObstZones, 0.04);
      if (!cResult) {
        for (const rot of [0, 90, 180, 270]) {
          cResult = wallPlace(counterId, room, rot, counterScale, placed, kitchenObstZones, 0.04);
          if (cResult) break;
        }
      }

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

      // Refrigerator — against a wall (never floating), preferring the wall
      // family opposite the counter.
      if (rw >= 2 && rh >= 2) {
        const fridgeRot = cRot === 0 ? 90 : 0;
        let fResult = wallPlace("refrigerator", room, fridgeRot, 1.0, placed, kitchenObstZones);
        if (!fResult) {
          for (const rot of [0, 90, 180, 270]) {
            fResult = wallPlace("refrigerator", room, rot, 1.0, placed, kitchenObstZones);
            if (fResult) break;
          }
        }
        if (fResult) placed.push(fResult);
      }

      // Island for larger kitchens — only if wall counter was placed (not island fallback)
      if (cResult && roomArea >= 14 && rw >= 3 && rh >= 3) {
        const extraIsland = smartPlace("kitchen-island", room, cx, cy, rw > rh ? 0 : 90, 0.85, placed,
          obstructionZonesByRoom.get(room.name), "extra-island");
        if (extraIsland) placed.push(extraIsland);
      }

      // UPPER wall cabinets — above/beside the counter, tall and strictly
      // forbidden in front of windows (avoiding doors/windows at placement).
      if (cResult && rw >= 2.5) {
        const cabObstZones = obstructionZonesByRoom.get(room.name) || [];
        // Try walls adjacent to the counter wall first
        const cabWalls: Door["wall"][] = counterWall === "bottom" || counterWall === "top"
          ? ["left", "right", counterWall]
          : ["top", "bottom", counterWall];
        for (const cabWall of cabWalls) {
          const cabRot = cabWall === "bottom" ? 0 : cabWall === "top" ? 180 : cabWall === "left" ? 90 : 270;
          const cabResult = wallPlace("wall-cabinet", room, cabRot as 0 | 90 | 180 | 270, 1.0, placed, cabObstZones, 0.04);
          if (cabResult) { placed.push(cabResult); break; }
        }
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
      const bathDoors = doors.filter((d) => d.room === room.name);
      const mainDoor = bathDoors.find((d) => d.width >= 0.6) ?? bathDoors[0];
      const doorWall: Door["wall"] = mainDoor?.wall ?? "bottom";
      const bathObstZones = obstructionZonesByRoom.get(room.name) || [];
      // Door clearance is a HARD NO for every fixture — split once and reuse.
      const bathDoorZones = splitZones(bathObstZones).doorZones;

      // ── Toilet: cistern against a wall, seat into room ──
      // Same pattern as bed headboard (bedY = backWall - halfH - margin).
      // local y=0 (cistern) → world position by rotation:
      //   rot=0:   worldY = centerY + halfH  → for TOP wall
      //   rot=180: worldY = centerY - halfH  → for BOTTOM wall
      //   rot=90:  worldX = centerX + halfH  → for RIGHT wall
      //   rot=270: worldX = centerX - halfH  → for LEFT wall
      const toiletItem = getFurnitureById("toilet");
      const tHalf = toiletItem ? toiletItem.height / 2 : 0.35;
      const tMargin = 0.05;

      // Try all 4 walls — prefer opposite door, then any that fits
      const wallPriority: Array<{ wall: Door["wall"]; rot: number; cx: number; cy: number }> = [];
      const oppWall = doorWall === "bottom" ? "top" : doorWall === "top" ? "bottom"
        : doorWall === "left" ? "right" : "left";

      const wallConfigs: Array<{ wall: Door["wall"]; rot: number }> = [
        { wall: "top",    rot: 0 },
        { wall: "bottom", rot: 180 },
        { wall: "left",   rot: 270 },   // cistern at centerX - halfH → toward left wall
        { wall: "right",  rot: 90 },    // cistern at centerX + halfH → toward right wall
      ];

      // Put opposite-door wall first
      const oppIdx = wallConfigs.findIndex(c => c.wall === oppWall);
      if (oppIdx > 0) {
        const [opp] = wallConfigs.splice(oppIdx, 1);
        wallConfigs.unshift(opp);
      }

      let toiletPlaced = false;
      for (const { wall, rot } of wallConfigs) {
        let tx: number, ty: number;
        switch (wall) {
          case "top":    tx = room.x + rw * 0.35; ty = room.y + rh - tHalf - tMargin; break;
          case "bottom": tx = room.x + rw * 0.35; ty = room.y + tHalf + tMargin; break;
          case "left":   tx = room.x + tHalf + tMargin; ty = room.y + rh * 0.55; break;
          case "right":  tx = room.x + rw - tHalf - tMargin; ty = room.y + rh * 0.55; break;
          default: continue;
        }

        const isTRot = rot === 90 || rot === 270;
        const tiw = isTRot ? (toiletItem?.height ?? 0.7) : (toiletItem?.width ?? 0.45);
        const tih = isTRot ? (toiletItem?.width ?? 0.45) : (toiletItem?.height ?? 0.7);

        if (isFurnitureInBounds(tx, ty, tiw, tih, room) &&
            !collidesWithExisting(tx, ty, tiw, tih, room.name, placed, "toilet") &&
            !overlapsObstruction(tx, ty, tiw / 2, tih / 2, bathDoorZones)) {
          placed.push({ itemId: "toilet", room: room.name, x: tx, y: ty, rotation: rot as 0 | 90 | 180 | 270, scale: 1.0 });
          toiletPlaced = true;
          break;
        }
      }
      // Absolute fallback — still must clear the door zone (final sweep enforces).
      if (!toiletPlaced) {
        const fallback = smartPlace("toilet", room, room.x + rw * 0.22, room.y + rh * 0.22, 0, 1.0, placed, bathObstZones)
          ?? smartPlace("toilet", room, room.x + rw * 0.5, room.y + rh * 0.5, 0, 0.8, placed, bathDoorZones);
        if (fallback) placed.push(fallback);
      }

      // ── Sink: closest to the door, but not overlapping the door swing ──
      // Place on same wall as door; if the sink can't fit on that wall
      // without overlapping the door zone, try adjacent walls.
      const sinkItem = getFurnitureById("sink-bathroom");
      const sinkHalfAlong = sinkItem ? sinkItem.width / 2 + 0.1 : 0.4;

      let sinkPlaced = false;
      // Try door wall first, then adjacent walls
      const sinkWallOrder: Door["wall"][] = [doorWall];
      if (doorWall === "bottom" || doorWall === "top") {
        sinkWallOrder.push("left", "right");
      } else {
        sinkWallOrder.push("bottom", "top");
      }

      for (const tryWall of sinkWallOrder) {
        let sx: number, sy: number, sr: number;
        const alongDim = (tryWall === "top" || tryWall === "bottom") ? rw : rh;
        const doorAlong = (mainDoor && mainDoor.wall === tryWall) ? mainDoor.offset : alongDim * 0.5;
        const doorHalf = (tryWall === mainDoor?.wall ? (mainDoor.width / 2 + 0.2) : 0.25);

        // Compute free spaces on either side of door.
        // "Left" = towards 0 along the wall, "Right" = towards alongDim.
        // Check if the sink CENTER can fit on each side of the door zone.
        const minGap = 0.02;
        const sinkSpan = sinkHalfAlong * 2; // total space sink occupies along the wall
        const doorZoneStart = doorAlong - doorHalf;
        const doorZoneEnd = doorAlong + doorHalf;

        // Sink on the "left" side (towards 0): center at doorZoneStart - sinkHalfAlong - minGap
        const leftCenter = doorZoneStart - sinkHalfAlong - minGap;
        const leftFits = leftCenter - sinkHalfAlong >= 0;

        // Sink on the "right" side (towards alongDim): center at doorZoneEnd + sinkHalfAlong + minGap
        const rightCenter = doorZoneEnd + sinkHalfAlong + minGap;
        const rightFits = rightCenter + sinkHalfAlong <= alongDim;

        let along: number;
        if (leftFits) {
          along = leftCenter;
        } else if (rightFits) {
          along = rightCenter;
        } else if (tryWall === mainDoor?.wall) {
          // Door wall is too tight — skip to adjacent wall
          continue;
        } else {
          // Non-door wall: place at the far end from room center
          along = doorAlong < alongDim / 2 ? alongDim - sinkHalfAlong - 0.05 : sinkHalfAlong + 0.05;
        }
        along = Math.max(sinkHalfAlong + 0.05, Math.min(alongDim - sinkHalfAlong - 0.05, along));

        switch (tryWall) {
          case "bottom": sx = room.x + along; sy = room.y + 0.3; sr = 0; break;
          case "top":    sx = room.x + along; sy = room.y + rh - 0.3; sr = 180; break;
          case "left":   sx = room.x + 0.3; sy = room.y + along; sr = 90; break;
          default:       sx = room.x + rw - 0.3; sy = room.y + along; sr = 270; break;
        }

        const isRot = sr === 90 || sr === 270;
        const siw = isRot ? (sinkItem?.height ?? 0.5) : (sinkItem?.width ?? 0.6);
        const sih = isRot ? (sinkItem?.width ?? 0.6) : (sinkItem?.height ?? 0.5);

        if (isFurnitureInBounds(sx, sy, siw, sih, room) &&
            !collidesWithExisting(sx, sy, siw, sih, room.name, placed, "sink-bathroom") &&
            !overlapsObstruction(sx, sy, siw / 2, sih / 2, bathDoorZones)) {
          placed.push({ itemId: "sink-bathroom", room: room.name, x: sx, y: sy, rotation: sr as 0 | 90 | 180 | 270, scale: 1.0 });
          sinkPlaced = true;
          break;
        }
      }
      if (!sinkPlaced) {
        const fallback = smartPlace("sink-bathroom", room, room.x + rw * 0.5, room.y + rh * 0.5, 0, 1.0, placed, bathObstZones)
          ?? smartPlace("sink-bathroom", room, room.x + rw * 0.5, room.y + rh * 0.5, 0, 0.7, placed, bathDoorZones);
        if (fallback) placed.push(fallback);
      }

      // ── Bathtub or shower ──
      // Bathtub (0.75×1.7m) parallel to room's LONGER side.
      // Try multiple positions along the long walls — don't hardcode one spot.
      const bathtub = getFurnitureById("bathtub");
      const roomLongDim = Math.max(rw, rh);
      const bathtubLength = bathtub ? bathtub.height * 0.9 : 1.53;
      const canFitBathtub = roomLongDim >= bathtubLength + 0.3 && roomArea >= 6;

      let tubOrShowerPlaced = false;

      if (canFitBathtub && bathtub) {
        // Try preferred rotation first, then alternate if door zone blocks it
        const prefRot = rw >= rh ? (90 as const) : (0 as const);
        const altRot = prefRot === 90 ? (0 as const) : (90 as const);
        const bScale = 0.9;

        for (const tryRot of [prefRot, altRot]) {
          const btw = tryRot === 90 ? bathtub.height : bathtub.width;
          const bth = tryRot === 90 ? bathtub.width : bathtub.height;

          const positions: Array<{ x: number; y: number }> = [];
          if (tryRot === 90) {
            for (const yFrac of [0.25, 0.5, 0.7]) {
              positions.push(
                { x: room.x + rw * 0.2, y: room.y + rh * yFrac },
                { x: room.x + rw * 0.8, y: room.y + rh * yFrac },
              );
            }
            positions.push({ x: room.x + rw * 0.5, y: room.y + rh * 0.5 });
          } else {
            for (const xFrac of [0.25, 0.5, 0.7]) {
              positions.push(
                { x: room.x + rw * xFrac, y: room.y + rh * 0.2 },
                { x: room.x + rw * xFrac, y: room.y + rh * 0.8 },
              );
            }
            positions.push({ x: room.x + rw * 0.5, y: room.y + rh * 0.5 });
          }

          for (const pos of positions) {
            if (isFurnitureInBounds(pos.x, pos.y, btw * bScale, bth * bScale, room) &&
                !collidesWithExisting(pos.x, pos.y, btw * bScale, bth * bScale, room.name, placed, "bathtub") &&
                !overlapsObstruction(pos.x, pos.y, (btw * bScale) / 2, (bth * bScale) / 2, bathDoorZones)) {
              placed.push({ itemId: "bathtub", room: room.name, x: pos.x, y: pos.y, rotation: tryRot as 0 | 90 | 180 | 270, scale: bScale });
              tubOrShowerPlaced = true;
              break;
            }
          }
          if (tubOrShowerPlaced) break;

          for (const s of [0.85, 0.75]) {
            const btResult = smartPlace("bathtub", room, room.x + rw * 0.5, room.y + rh * 0.5, tryRot, s, placed, bathObstZones);
            if (btResult) { placed.push(btResult); tubOrShowerPlaced = true; break; }
          }
          if (tubOrShowerPlaced) break;
        }
      }

      // Fallback: shower if bathtub didn't fit (or room too small)
      if (!tubOrShowerPlaced) {
        // Try smartPlace at multiple positions before failing
        const showerPositions = [
          { x: room.x + rw * 0.25, y: room.y + rh * 0.3 },
          { x: room.x + rw * 0.75, y: room.y + rh * 0.3 },
          { x: room.x + rw * 0.25, y: room.y + rh * 0.7 },
          { x: room.x + rw * 0.75, y: room.y + rh * 0.7 },
          { x: room.x + rw * 0.5,  y: room.y + rh * 0.5 },
          // Corners
          { x: room.x + 0.5, y: room.y + 0.5 },
          { x: room.x + rw - 0.5, y: room.y + 0.5 },
          { x: room.x + 0.5, y: room.y + rh - 0.5 },
          { x: room.x + rw - 0.5, y: room.y + rh - 0.5 },
        ];

        let shResult: PlacedFurniture | null = null;
        for (const pos of showerPositions) {
          for (const s of [0.85, 0.7, 0.6, 0.5]) {
            shResult = smartPlace("shower", room, pos.x, pos.y, 0, s, placed, bathObstZones);
            if (shResult) break;
          }
          if (shResult) break;
        }

        if (shResult) {
          placed.push(shResult);
        } else {
          // Never force a shower into the door clearance — try once more with
          // door-only zones; the final sweep enforces the hard NO as backstop.
          const lastTry = smartPlace("shower", room, room.x + rw * 0.5, room.y + rh * 0.5, 0, 0.5, placed, bathDoorZones);
          if (lastTry) placed.push(lastTry);
        }
      }
    }

    /* ---- OFFICE / STUDY ---- */
    if (/office|study/i.test(name)) {
      const officeObstZones = obstructionZonesByRoom.get(room.name) || [];

      // Atomic desk + chair set — if it doesn't all fit, nothing is placed
      const deskSet = placeDeskSet(
        room, cx, room.y + rh * 0.35, 0, 1.0,
        placed, officeObstZones
      );
      if (deskSet) {
        for (const pf of deskSet) placed.push(pf);
      }

      // Bookshelf — wall-mounted, avoid windows/doors. Try all rotations.
      if (rw >= 2) {
        let shelfResult: PlacedFurniture | null = null;
        for (const rot of [90, 270, 0, 180]) {
          shelfResult = wallPlace("bookshelf", room, rot as 0 | 90 | 180 | 270, 1.0, placed, officeObstZones, 0.04);
          if (shelfResult) break;
        }
        if (!shelfResult) {
          for (const s of [0.85, 0.7]) {
            for (const rot of [90, 270, 0, 180]) {
              shelfResult = wallPlace("bookshelf", room, rot as 0 | 90 | 180 | 270, s, placed, officeObstZones, 0.04);
              if (shelfResult) break;
            }
            if (shelfResult) break;
          }
        }
        // Bookshelf must stay on a plain wall — no free wall space means no bookshelf.
        if (shelfResult) placed.push(shelfResult);
      }
      if (minDim >= 2) {
        // Plant in a corner without a window/door
        const plantItem = getFurnitureById("plant-indoor");
        const plantHalf = plantItem ? plantItem.width / 2 : 0.2;
        const plantCorners = [
          { x: room.x + 0.3, y: room.y + 0.3 },
          { x: room.x + rw - 0.3, y: room.y + 0.3 },
          { x: room.x + 0.3, y: room.y + rh - 0.3 },
          { x: room.x + rw - 0.3, y: room.y + rh - 0.3 },
        ];
        const bestCorner = plantCorners.find(c =>
          !overlapsObstruction(c.x, c.y, plantHalf, plantHalf, officeObstZones)
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

    /* ---- HALLWAY / CORRIDOR ---- */
    if (/hallway|corridor|foyer/i.test(name)) {
      const hallObstZones = obstructionZonesByRoom.get(room.name) || [];
      if (minDim >= 1.2 && roomArea >= 4) {
        const plantItem = getFurnitureById("plant-indoor");
        const plantHalf = plantItem ? plantItem.width / 2 : 0.2;
        const plantCorners = [
          { x: rw > rh ? room.x + rw * 0.85 : cx, y: rw > rh ? cy : room.y + rh * 0.1 },
          { x: rw > rh ? room.x + rw * 0.15 : cx, y: rw > rh ? cy : room.y + rh * 0.9 },
        ];
        const bestCorner = plantCorners.find(c =>
          !overlapsObstruction(c.x, c.y, plantHalf, plantHalf, hallObstZones)
        ) || plantCorners[0];
        placed.push({
          itemId: "plant-indoor",
          room: room.name,
          x: bestCorner.x,
          y: bestCorner.y,
          rotation: 0,
          scale: 0.8,
        });
      }
      // Cabinet — wall-mounted, avoid windows/doors
      if (rw >= 1.5 || rh >= 1.5) {
        let cabResult: PlacedFurniture | null = null;
        const cabRot = rw > rh ? 0 : 90;
        for (const rot of [cabRot, (cabRot + 90) % 360, (cabRot + 180) % 360, (cabRot + 270) % 360]) {
          cabResult = wallPlace("cabinet", room, rot as 0 | 90 | 180 | 270, 0.7, placed, hallObstZones, 0.04);
          if (cabResult) break;
        }
        // Cabinet must stay on a plain wall — no free wall space means no cabinet.
        if (cabResult) placed.push(cabResult);
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
      const laundryObstZones = obstructionZonesByRoom.get(room.name) || [];
      // Counter flush against a wall (long side along it), avoiding door zones.
      const laundryCounter =
        wallPlace("kitchen-counter-straight", room, 0, 0.7, placed, laundryObstZones, 0.04) ??
        wallPlace("kitchen-counter-straight", room, 90, 0.7, placed, laundryObstZones, 0.04);
      if (laundryCounter) placed.push(laundryCounter);
      // LOW base cabinet — allowed near windows, but never in a door zone.
      const laundryCab =
        wallPlace("cabinet", room, 0, 0.8, placed, laundryObstZones, 0.04) ??
        wallPlace("cabinet", room, 90, 0.8, placed, laundryObstZones, 0.04);
      if (laundryCab) placed.push(laundryCab);
    }
  }

  // ── Post-validation: keep essentials, try to fix out-of-bounds items ──
  const roomMap = new Map(rooms.map(r => [r.name, r]));
  const essentialIds = new Set([
    "bed-single", "bed-double", "bed-queen", "bed-king",
    "dining-table-4", "dining-table-6",
    "toilet", "sink-bathroom", "shower", "bathtub",
    "stove-4-burner", "refrigerator", "kitchen-sink",
    "kitchen-counter-straight", "kitchen-counter-small", "kitchen-counter-corner", "kitchen-island",
    "desk",
    // Living room core: sofa + coffee table + TV (NOT rug — rugs are decorative,
    // only placed when anchored to bed or coffee table; never force-placed)
    "sofa-3-seater", "sofa-2-seater", "tv-unit", "coffee-table",
  ]);

  // Items that MUST appear — if smartPlace fails, compute fitting scale
  const forceItems = new Set([
    // NOTE: kitchen counters are NOT force items — their long side must sit
    // on a wall, so they are never floated into the room center.
    "stove-4-burner",
    "toilet", "sink-bathroom", "kitchen-sink", "kitchen-island",
    // Living room core items always appear (NOT rug — decorative, anchored only)
    "sofa-3-seater", "sofa-2-seater", "tv-unit", "coffee-table",
    // Bathroom essentials: shower and bathtub MUST be placed if attempted
    "shower", "bathtub",
  ]);

  const validated: PlacedFurniture[] = [];

  for (const pf of placed) {
    // Debug markers (__ prefix) pass through validation unchanged
    if (pf.itemId.startsWith("__")) {
      validated.push(pf);
      continue;
    }

    const room = roomMap.get(pf.room);
    if (!room) continue;
    const item = getFurnitureById(pf.itemId);
    // Allow virtual obstacles to pass through for collision blocking
    if (!item && (pf.itemId === "__ensuite_obstacle__" || pf.itemId === "__bathroom_obstacle__")) {
      validated.push(pf);
      continue;
    }
    if (!item) continue;

    // Rugs are flat and always fit — no bounds, collision, or door checks.
    if (pf.itemId.startsWith("rug-")) {
      validated.push(pf);
      continue;
    }

    // Axis-aligned bounding extents — exact for 90° increments and a safe
    // bounding box for 45° diagonal placements (diagonal sofa/coffee/TV group).
    const rad = (pf.rotation * Math.PI) / 180;
    const iw = (Math.abs(item.width * Math.cos(rad)) + Math.abs(item.height * Math.sin(rad))) * pf.scale;
    const ih = (Math.abs(item.width * Math.sin(rad)) + Math.abs(item.height * Math.cos(rad))) * pf.scale;
    const fits = isFurnitureInBounds(pf.x, pf.y, iw, ih, room);
    const collides = fits && collidesWithExisting(pf.x, pf.y, iw, ih, pf.room, validated, pf.itemId);
    // Door zones vs window zones: door clearance applies to ALL objects —
    // nothing may block a doorway. Windows are soft blockers.
    const roomObstZones = obstructionZonesByRoom.get(pf.room) || [];
    // Door clearance is a HARD NO for every object; window zones are hard
    // only for tall items and soft for everything else.
    const doorZonesInRoom = splitZones(roomObstZones).doorZones;
    const inDoorZone = fits && !collides &&
      overlapsObstruction(pf.x, pf.y, iw / 2, ih / 2, doorZonesInRoom);
    const inObstZone = fits && !collides &&
      overlapsObstruction(pf.x, pf.y, iw / 2, ih / 2, roomObstZones);

    if (fits && !collides && !inObstZone) {
      if (pf.itemId.startsWith("bed-")) console.log(`[validate] bed in "${pf.room}" ✅ kept at wall pos (${pf.x.toFixed(2)},${pf.y.toFixed(2)}) rot=${pf.rotation}°`);
      validated.push(pf);
      continue;
    }

    // Log rejection reason
    if (!fits) console.log(`[validate] ${pf.itemId} in "${pf.room}" → OUT OF BOUNDS (pos=${pf.x.toFixed(1)},${pf.y.toFixed(1)} rot=${pf.rotation}° scale=${pf.scale.toFixed(2)})`);
    else if (collides) console.log(`[validate] ${pf.itemId} in "${pf.room}" → COLLISION with existing`);

    // STRICT: no object may block a door — beds are shrunk/shifted but
    // NEVER removed (they are a MUST); essentials move; the rest drop.
    if (inDoorZone && fits && !collides) {
      if (pf.itemId.startsWith("bed-")) {
        const fixed = repairBed(pf, room, item, doorZonesInRoom, validated);
        if (fixed !== pf) {
          console.log(`[validate] bed in "${pf.room}" → moved out of door clearance`);
        } else {
          console.log(`[validate] bed in "${pf.room}" ⚠️ kept — bed is a MUST (no clear spot)`);
        }
        validated.push(fixed);
        continue;
      }
      if (essentialIds.has(pf.itemId)) {
        // Counters keep the long side on a wall, flush — never float.
        const fixed = isWallCounter(pf.itemId)
          ? wallPlace(pf.itemId, room, pf.rotation, pf.scale, validated, roomObstZones, 0.04)
          : smartPlace(pf.itemId, room, pf.x, pf.y, pf.rotation, pf.scale, validated, roomObstZones);
        if (fixed) {
          validated.push(fixed);
          continue;
        }
      }
      console.log(`[validate] ${pf.itemId} in "${pf.room}" → DROPPED (blocks doorway)`);
      continue;
    }

    // Window zone (soft) but fits otherwise. Tall items (wardrobe, bookshelf,
    // upper cabinets) are STRICTLY forbidden in front of windows; low items
    // may use window areas freely.
    if (inObstZone && fits && !collides) {
      if (isTallWindowBlocker(pf.itemId)) {
        console.log(`[validate] ${pf.itemId} in "${pf.room}" → DROPPED (tall item blocks window)`);
        continue;
      }
      console.log(`[validate] ${pf.itemId} in "${pf.room}" → window zone (soft for low items) — kept`);
      validated.push(pf);
      continue;
    }

    // Doesn't fit — for beds, keep the wall position at reduced scale.
    // NEVER move a bed to a different wall or to room center.
    if (pf.itemId.startsWith("bed-")) {
      // Try reduced scale at the same position first
      for (const s of [pf.scale * 0.9, pf.scale * 0.8, pf.scale * 0.7, pf.scale * 0.6]) {
        const isRot = pf.rotation === 90 || pf.rotation === 270;
        const iw2 = (isRot ? item.height : item.width) * s;
        const ih2 = (isRot ? item.width : item.height) * s;
        if (isFurnitureInBounds(pf.x, pf.y, iw2, ih2, room) &&
            !collidesWithExisting(pf.x, pf.y, iw2, ih2, pf.room, validated, pf.itemId)) {
          console.log(`[validate] bed in "${pf.room}" ⚠️ scaled to ${s.toFixed(2)} at wall pos (${pf.x.toFixed(2)},${pf.y.toFixed(2)})`);
          validated.push({ ...pf, scale: s });
          break;
        }
      }
      // If even reduced fails, push it anyway — bed against wall > no bed
      if (!validated.some(v => v.itemId === pf.itemId && v.room === pf.room)) {
        console.log(`[validate] bed in "${pf.room}" ⚠️ forcing wall pos despite issues`);
        validated.push(pf);
      }
      continue;
    }

    if (essentialIds.has(pf.itemId)) {
      // Counters keep the long side on a wall, flush — repair never floats.
      const fixed = isWallCounter(pf.itemId)
        ? wallPlace(pf.itemId, room, pf.rotation, pf.scale, validated, roomObstZones, 0.04)
        : smartPlace(pf.itemId, room, pf.x, pf.y, pf.rotation, pf.scale, validated, roomObstZones);
      if (fixed) {
        validated.push(fixed);
      } else if (forceItems.has(pf.itemId)) {
        // MUST appear: compute the max scale that fits at room center —
        // door zones stay a HARD NO (guaranteedPlace respects them).
        const guaranteed = guaranteedPlace(pf.itemId, room, validated, undefined, roomObstZones);
        if (guaranteed) validated.push(guaranteed);
      } else if (isWallCounter(pf.itemId)) {
        console.log(`[validate] ${pf.itemId} in "${pf.room}" → DROPPED (no wall space for counter)`);
      }
    }
    // Non-essential items that don't fit: just skip them
  }

  // ── Bathroom invariant: every bathroom/ensuite/powder/WC MUST have ──
  //    toilet + sink + (shower OR bathtub). These are non-negotiable.
  //    Force-place any missing fixture. Warn if undersized but never strip.
  const BATH_MIN_SCALE = 0.4; // smallest functional fixture (34cm shower)
  const bathroomFixtureIds = new Set(["toilet", "sink-bathroom", "shower", "bathtub"]);
  const bathroomRoomNames = new Set(
    rooms.filter(r => /bathroom|ensuite|powder|wc/i.test(r.name)).map(r => r.name)
  );

  for (const roomName of bathroomRoomNames) {
    const room = roomMap.get(roomName);
    if (!room) continue;

    const roomFixtures = validated.filter(
      pf => pf.room === roomName && bathroomFixtureIds.has(pf.itemId)
    );
    let hasToilet = roomFixtures.some(pf => pf.itemId === "toilet");
    let hasSink = roomFixtures.some(pf => pf.itemId === "sink-bathroom");
    let tubOrShower = roomFixtures.find(pf => pf.itemId === "shower" || pf.itemId === "bathtub");
    let hasTubOrShower = !!tubOrShower;

    const roomObstZones = obstructionZonesByRoom.get(roomName) || [];

    // Force-place any missing mandatory fixture at minimum viable scale
    if (!hasToilet) {
      const forced = guaranteedPlace("toilet", room, validated, BATH_MIN_SCALE, roomObstZones);
      if (forced) { validated.push(forced); hasToilet = true; }
    }
    if (!hasSink) {
      const forced = guaranteedPlace("sink-bathroom", room, validated, BATH_MIN_SCALE, roomObstZones);
      if (forced) { validated.push(forced); hasSink = true; }
    }
    if (!hasTubOrShower) {
      const forced = guaranteedPlace("shower", room, validated, BATH_MIN_SCALE, roomObstZones)
                  ?? guaranteedPlace("bathtub", room, validated, BATH_MIN_SCALE, roomObstZones);
      if (forced) { validated.push(forced); hasTubOrShower = true; tubOrShower = forced; }
    }

    // Replace undersized shower/tub — smartPlace may have shrunk it below minimum
    tubOrShower = validated.find(pf =>
      pf.room === roomName && (pf.itemId === "shower" || pf.itemId === "bathtub")
    );
    if (tubOrShower && tubOrShower.scale < BATH_MIN_SCALE) {
      // Remove the tiny one and force-place at proper minimum
      const idx = validated.indexOf(tubOrShower);
      if (idx >= 0) validated.splice(idx, 1);
      const forced = guaranteedPlace("shower", room, validated, BATH_MIN_SCALE, roomObstZones)
                  ?? guaranteedPlace("bathtub", room, validated, BATH_MIN_SCALE, roomObstZones);
      if (forced) { validated.push(forced); tubOrShower = forced; }
    }
  }

  // ── Studio invariant: the BED is a MUST (top priority) ──
  // Priority order in studios: bed → sofa + coffee table → TV → kitchenette.
  // The bed is re-placed here if validation dropped it for any reason.
  for (const roomName of rooms.filter(r => /studio/i.test(r.name)).map(r => r.name)) {
    const room = roomMap.get(roomName);
    if (!room) continue;
    if (validated.some(pf => pf.room === roomName && pf.itemId.startsWith("bed-"))) continue;

    const bedId = room.area >= 18 ? "bed-double" : "bed-single";
    const bedItem = getFurnitureById(bedId);
    if (!bedItem) continue;

    const studioZones = obstructionZonesByRoom.get(roomName) || [];
    const studioDoorZones = splitZones(studioZones).doorZones;
    const rw = room.width, rh = room.height;
    let scale = room.area < 14 ? 0.85 : 1.0;
    if (bedItem.width * scale > rw - 0.3) scale = (rw - 0.3) / bedItem.width;

    const bedFits = (x: number, y: number, rot: 0 | 90 | 180 | 270, s: number): boolean => {
      const isRot = rot === 90 || rot === 270;
      const w2 = (isRot ? bedItem.height : bedItem.width) * s;
      const h2 = (isRot ? bedItem.width : bedItem.height) * s;
      return !overlapsObstruction(x, y, w2 / 2, h2 / 2, studioDoorZones) &&
        isFurnitureInBounds(x, y, w2, h2, room) &&
        !collidesWithExisting(x, y, w2, h2, roomName, validated, bedId);
    };

    // Wall-based candidates: the bed belongs against a wall, never floating.
    // Windows are NOT an issue — only door clearance zones are checked.
    let placedBed: PlacedFurniture | null = null;
    outer:
    for (const s of [scale, 0.9, 0.8, 0.7]) {
      const h2 = bedItem.height * s;
      // Top and bottom walls (horizontal bed, rot 0 / 180).
      for (const frac of [0.5, 0.25, 0.75, 0.125, 0.875]) {
        const bx = room.x + rw * frac;
        const topY = room.y + rh - h2 / 2 - 0.15;
        const bottomY = room.y + h2 / 2 + 0.15;
        if (bedFits(bx, topY, 0, s)) {
          placedBed = { itemId: bedId, room: roomName, x: bx, y: topY, rotation: 0, scale: s };
          break outer;
        }
        if (bedFits(bx, bottomY, 180, s)) {
          placedBed = { itemId: bedId, room: roomName, x: bx, y: bottomY, rotation: 180, scale: s };
          break outer;
        }
      }
      // Left and right walls (vertical bed, rot 270 / 90).
      const vw2 = bedItem.height * s;
      for (const frac of [0.5, 0.25, 0.75, 0.125, 0.875]) {
        const by = room.y + rh * frac;
        const leftX = room.x + vw2 / 2 + 0.15;
        const rightX = room.x + rw - vw2 / 2 - 0.15;
        if (bedFits(leftX, by, 270, s)) {
          placedBed = { itemId: bedId, room: roomName, x: leftX, y: by, rotation: 270, scale: s };
          break outer;
        }
        if (bedFits(rightX, by, 90, s)) {
          placedBed = { itemId: bedId, room: roomName, x: rightX, y: by, rotation: 90, scale: s };
          break outer;
        }
      }
    }
    if (placedBed) {
      validated.push(placedBed);
      console.log(`[studio-bed] forced bed in "${roomName}" — the bed is a MUST`);
    } else {
      // Absolute last resort: the bed MUST exist — place it at the back wall
      // even if it touches a zone. The final sweep may repair it, but never
      // removes it.
      const lastResort: PlacedFurniture = {
        itemId: bedId,
        room: roomName,
        x: room.x + rw / 2,
        y: room.y + rh - (bedItem.height * 0.7) / 2 - 0.15,
        rotation: 0,
        scale: 0.7,
      };
      validated.push(lastResort);
      console.log(`[studio-bed] ⚠️ bed in "${roomName}" placed at back wall — bed is a MUST`);
    }
  }

  // ── FINAL DOOR-CLEARANCE ENFORCEMENT — HARD NO for every object ──
  // Runs after every placement and invariant so nothing can slip through.
  // Any object still overlapping a door clearance zone is repaired or
  // removed; tall items (wardrobe, bookshelf, upper cabinets) are also
  // removed from window zones.
  for (const pf of [...validated]) {
    if (pf.itemId.startsWith("__") || pf.itemId.startsWith("rug-")) continue;
    const room = roomMap.get(pf.room);
    if (!room) continue;
    const item = getFurnitureById(pf.itemId);
    if (!item) continue;

    const rad = (pf.rotation * Math.PI) / 180;
    const iw = (Math.abs(item.width * Math.cos(rad)) + Math.abs(item.height * Math.sin(rad))) * pf.scale;
    const ih = (Math.abs(item.width * Math.sin(rad)) + Math.abs(item.height * Math.cos(rad))) * pf.scale;

    const roomZones = obstructionZonesByRoom.get(pf.room) || [];
    const { doorZones, windowZones } = splitZones(roomZones);

    // Tall items may never block windows either — hard NO.
    if (isTallWindowBlocker(pf.itemId) &&
        overlapsObstruction(pf.x, pf.y, iw / 2, ih / 2, windowZones)) {
      const idx = validated.indexOf(pf);
      if (idx >= 0) validated.splice(idx, 1);
      console.log(`[enforce] ${pf.itemId} in "${pf.room}" → REMOVED (tall item blocks window)`);
      continue;
    }
    if (doorZones.length === 0) continue;
    if (!overlapsObstruction(pf.x, pf.y, iw / 2, ih / 2, doorZones)) continue;

    // Door zone violation — repair or remove. Beds are a MUST: they are
    // repaired (shrunk/shifted) but NEVER removed.
    const others = validated.filter(v => v !== pf);
    let fixed: PlacedFurniture | null = null;
    if (pf.itemId.startsWith("bed-")) {
      fixed = repairBed(pf, room, item, doorZones, others);
      if (fixed === pf) {
        console.log(`[enforce] bed in "${pf.room}" ⚠️ kept — bed is a MUST (no clear spot)`);
      }
    } else if (isWallCounter(pf.itemId) || isTallWindowBlocker(pf.itemId) || pf.itemId === "cabinet") {
      // Wall-mounted / counter items: relocate along a wall, never float.
      fixed = wallPlace(pf.itemId, room, pf.rotation, pf.scale, others, roomZones, 0.04);
      if (!fixed) {
        for (const rot of [0, 90, 180, 270]) {
          fixed = wallPlace(pf.itemId, room, rot, pf.scale, others, roomZones, 0.04);
          if (fixed) break;
        }
      }
    } else if (essentialIds.has(pf.itemId)) {
      fixed = smartPlace(pf.itemId, room, pf.x, pf.y, pf.rotation, pf.scale, others, roomZones);
    }
    if (fixed) {
      const idx = validated.indexOf(pf);
      validated[idx] = fixed;
      if (fixed !== pf) {
        console.log(`[enforce] ${pf.itemId} in "${pf.room}" → MOVED out of door clearance`);
      }
    } else {
      const idx = validated.indexOf(pf);
      if (idx >= 0) validated.splice(idx, 1);
      console.log(`[enforce] ${pf.itemId} in "${pf.room}" → REMOVED (blocks door clearance — hard NO)`);
    }
  }

  // ── Living set integrity: TV → coffee table → sofa must stay aligned ──
  // Strict post-check after placement AND validation. If a component is
  // missing or misaligned, repair following the removal priority: coffee
  // table first, then TV, sofa last. The rug is never removed.
  const livingRoomNames = new Set(
    rooms.filter(r => /living|lounge|family|media|studio/i.test(r.name)).map(r => r.name)
  );
  for (const roomName of livingRoomNames) {
    const inRoom = (id: string) =>
      validated.find(pf => pf.room === roomName && pf.itemId === id);
    const sofa = inRoom("sofa-3-seater") ?? inRoom("sofa-2-seater");
    const tv = inRoom("tv-unit");
    const coffee = inRoom("coffee-table");

    // The sofa's front direction (away from its back), per its rotation.
    const frontDir = (pf: PlacedFurniture): { dx: number; dy: number } => {
      switch (pf.rotation) {
        case 0: return { dx: 0, dy: -1 };
        case 180: return { dx: 0, dy: 1 };
        case 90: return { dx: -1, dy: 0 };
        case 270: return { dx: 1, dy: 0 };
        case 45: return { dx: -1, dy: -1 };
        case 225: return { dx: 1, dy: 1 };
        case 315: return { dx: 1, dy: -1 };
        case 135: return { dx: -1, dy: 1 };
        default: return { dx: 0, dy: -1 };
      }
    };

    let removeIds: string[] = [];
    if (!sofa) {
      // Sofa is the last to go — if it is absent, TV and coffee must be too.
      removeIds = ["tv-unit", "coffee-table"];
    } else if (!tv) {
      // No TV → the coffee table has nothing to anchor the facing axis.
      removeIds = ["coffee-table"];
    } else {
      const dir = frontDir(sofa);
      const isDiagonal = dir.dx !== 0 && dir.dy !== 0;
      const axisAligned = (a: PlacedFurniture, b: PlacedFurniture, tol: number) =>
        Math.abs(a.x - b.x) < tol || Math.abs(a.y - b.y) < tol;
      const dxInFront = dir.dx > 0 ? tv.x > sofa.x : tv.x < sofa.x;
      const dyInFront = dir.dy > 0 ? tv.y > sofa.y : tv.y < sofa.y;

      if (isDiagonal) {
        // Diagonal: TV diagonally opposite the sofa, coffee at the midpoint.
        if (!(dxInFront && dyInFront)) {
          removeIds.push("coffee-table", "tv-unit");
        } else if (coffee) {
          const midX = (sofa.x + tv.x) / 2, midY = (sofa.y + tv.y) / 2;
          if (Math.abs(coffee.x - midX) > 1.0 || Math.abs(coffee.y - midY) > 1.0) {
            removeIds.push("coffee-table");
          }
        }
      } else {
        // Axis arrangement: TV in front of the sofa on the same axis.
        const tvOK = (dir.dx !== 0
          ? Math.abs(sofa.y - tv.y) < 0.6 && dxInFront
          : Math.abs(sofa.x - tv.x) < 0.6 && dyInFront);
        if (!tvOK) {
          removeIds.push("coffee-table");
          if (!axisAligned(sofa, tv, 0.6)) removeIds.push("tv-unit");
        } else if (coffee) {
          const between = dir.dy !== 0
            ? (dir.dy > 0 ? coffee.y > sofa.y && coffee.y < tv.y : coffee.y < sofa.y && coffee.y > tv.y)
            : (dir.dx > 0 ? coffee.x > sofa.x && coffee.x < tv.x : coffee.x < sofa.x && coffee.x > tv.x);
          if (!between || !axisAligned(coffee, sofa, 0.6)) {
            removeIds.push("coffee-table");
          }
        }
      }
    }

    for (const id of removeIds) {
      const idx = validated.findIndex(pf => pf.room === roomName && pf.itemId === id);
      if (idx >= 0) validated.splice(idx, 1);
    }

    // Rugs are STRICTLY anchored: under a coffee table or at the foot of a
    // bed. If the coffee table is gone, remove every rug in this room that
    // is not at the foot of a bed (studios keep their bed rug).
    if (!inRoom("coffee-table")) {
      const rugIds = ["rug-large", "rug-small"];
      for (const rug of [...validated].filter(pf =>
        pf.room === roomName && rugIds.includes(pf.itemId)
      )) {
        const nearBedFoot = validated.some(pf => {
          if (pf.room !== roomName || !pf.itemId.startsWith("bed-")) return false;
          const bitem = getFurnitureById(pf.itemId);
          if (!bitem) return false;
          const isRot = pf.rotation === 90 || pf.rotation === 270;
          const bw = (isRot ? bitem.height : bitem.width) * pf.scale;
          const bh = (isRot ? bitem.width : bitem.height) * pf.scale;
          // Foot of the bed (opposite the headboard).
          let fx = pf.x, fy = pf.y;
          if (pf.rotation === 0) fy -= bh / 2;
          else if (pf.rotation === 180) fy += bh / 2;
          else if (pf.rotation === 90) fx -= bw / 2;
          else if (pf.rotation === 270) fx += bw / 2;
          return Math.abs(rug.x - fx) < 1.2 && Math.abs(rug.y - fy) < 1.2;
        });
        if (!nearBedFoot) validated.splice(validated.indexOf(rug), 1);
      }
    }
  }

  return validated;
}

/**
 * Guaranteed placement: finds the maximum scale that fits at room center,
 * then tries corners and wall-edge positions as fallback.
 * Only for truly critical items (toilet, kitchen counter, stove, shower).
 */
function guaranteedPlace(
  itemId: string,
  room: GeneratedRoom,
  existing: PlacedFurniture[],
  minScale?: number,
  obstZones?: ObstructionZone[]
): PlacedFurniture | null {
  const item = getFurnitureById(itemId);
  if (!item) return null;

  const isBathFixture = ["toilet", "sink-bathroom", "shower", "bathtub"].includes(itemId);
  // Bathroom fixtures: floor 0.4 (34cm) — recognizable minimum.
  // Other critical items: floor 0.2 as absolute last resort.
  const floor = minScale ?? (isBathFixture ? 0.4 : 0.2);

  // Hard zones: door clearance for every item, plus windows for tall items.
  const hardZones = obstZones ? hardZonesFor(itemId, obstZones) : [];
  const clearZones = (x: number, y: number, w: number, h: number) =>
    hardZones.length === 0 || !overlapsObstruction(x, y, w / 2, h / 2, hardZones);

  const centroid = getRoomCentroid(room);

  // Try centroid first, then corners, then wall-edge positions
  const positions = [
    { x: centroid.x, y: centroid.y },
    // Corners
    { x: room.x + 0.5, y: room.y + 0.5 },
    { x: room.x + room.width - 0.5, y: room.y + 0.5 },
    { x: room.x + 0.5, y: room.y + room.height - 0.5 },
    { x: room.x + room.width - 0.5, y: room.y + room.height - 0.5 },
    // Mid-wall positions
    { x: room.x + room.width * 0.5, y: room.y + 0.5 },
    { x: room.x + 0.5, y: room.y + room.height * 0.5 },
    { x: room.x + room.width - 0.5, y: room.y + room.height * 0.5 },
    { x: room.x + room.width * 0.5, y: room.y + room.height - 0.5 },
  ];

  // Build scale ladder from 1.0 down to floor
  const scales: number[] = [];
  for (const s of [1.0, 0.85, 0.7, 0.55, 0.4, 0.3, 0.25, 0.2]) {
    if (s >= floor - 0.001) scales.push(s);
  }
  if (scales.length === 0 || scales[scales.length - 1] > floor) {
    scales.push(floor);
  }

  for (const scale of scales) {
    for (const rot of [0, 90]) {
      const iw = (rot === 0 ? item.width : item.height) * scale;
      const ih = (rot === 0 ? item.height : item.width) * scale;

      for (const pos of positions) {
        if (isFurnitureInBounds(pos.x, pos.y, iw, ih, room) &&
            !collidesWithExisting(pos.x, pos.y, iw, ih, room.name, existing, itemId) &&
            clearZones(pos.x, pos.y, iw, ih)) {
          return { itemId, room: room.name, x: pos.x, y: pos.y, rotation: rot as 0 | 90 | 180 | 270, scale };
        }
      }
    }
    // For scales <= 0.5, also try all 4 rotations
    if (scale <= 0.5) {
      for (const rot of [180, 270]) {
        const iw = (rot === 90 || rot === 270 ? item.height : item.width) * scale;
        const ih = (rot === 90 || rot === 270 ? item.width : item.height) * scale;
        for (const pos of positions) {
          if (isFurnitureInBounds(pos.x, pos.y, iw, ih, room) &&
              !collidesWithExisting(pos.x, pos.y, iw, ih, room.name, existing, itemId) &&
              clearZones(pos.x, pos.y, iw, ih)) {
            return { itemId, room: room.name, x: pos.x, y: pos.y, rotation: rot as 0 | 90 | 180 | 270, scale };
          }
        }
      }
    }
  }

  // Last resort: floor scale, nudged around the centroid — but NEVER inside
  // a door clearance zone. Better absent than blocking a doorway. When there
  // are no hard zones to protect (e.g. tiny door-less bathrooms), the plain
  // centroid push is kept so mandatory fixtures still appear.
  if (hardZones.length === 0) {
    return { itemId, room: room.name, x: centroid.x, y: centroid.y, rotation: 0, scale: floor };
  }
  const lw = item.width * floor;
  const lh = item.height * floor;
  const nudges = [
    { x: centroid.x, y: centroid.y },
    { x: centroid.x + 0.3, y: centroid.y },
    { x: centroid.x - 0.3, y: centroid.y },
    { x: centroid.x, y: centroid.y + 0.3 },
    { x: centroid.x, y: centroid.y - 0.3 },
    { x: centroid.x + 0.3, y: centroid.y + 0.3 },
    { x: centroid.x - 0.3, y: centroid.y - 0.3 },
    { x: centroid.x + 0.3, y: centroid.y - 0.3 },
    { x: centroid.x - 0.3, y: centroid.y + 0.3 },
  ];
  for (const n of nudges) {
    if (isFurnitureInBounds(n.x, n.y, lw, lh, room) &&
        !collidesWithExisting(n.x, n.y, lw, lh, room.name, existing, itemId) &&
        clearZones(n.x, n.y, lw, lh)) {
      return { itemId, room: room.name, x: n.x, y: n.y, rotation: 0, scale: floor };
    }
  }
  console.log(`[guaranteed] ${itemId} in "${room.name}" → NO position clears the hard zones`);
  return null;
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
