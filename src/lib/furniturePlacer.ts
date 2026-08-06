/* ------------------------------------------------------------------ */
/*  Furniture Placer — intelligently places furniture in rooms         */
/*  Based on room type, size, and furniture dimensions                 */
/* ------------------------------------------------------------------ */

import { GeneratedRoom } from "./ai-client";
import { PlacedFurniture } from "./furniture";
import { getFurnitureForRoom, getFurnitureById } from "./furniture";
import { isFurnitureInBounds } from "./layoutEngine";

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
  existingItems: PlacedFurniture[]
): PlacedFurniture | null {
  const item = getFurnitureById(itemId);
  if (!item) return null;

  // Compute polygon centroid if room has a polygon
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
      const iw = (rot === rotation ? item.width : item.height) * pos.scale;
      const ih = (rot === rotation ? item.height : item.width) * pos.scale;

      // Check bounds
      if (!isFurnitureInBounds(pos.x, pos.y, iw, ih, room)) continue;

      // Check collisions with existing items in same room (skip same-group items)
      if (collidesWithExisting(pos.x, pos.y, iw, ih, room.name, existingItems, itemId)) continue;

      return { itemId, room: room.name, x: pos.x, y: pos.y, rotation: rot as 0 | 90 | 180 | 270, scale: pos.scale };
    }
  }

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
  const kitchenItems = ["kitchen-counter", "stove", "refrigerator", "kitchen-sink", "kitchen-island"];
  const bathItems = ["toilet", "sink-bathroom", "bathtub", "shower"];
  const livingItems = ["sofa", "coffee-table", "tv-unit", "armchair", "side-table", "rug-large"];
  const bedItems = ["bed-", "side-table", "wardrobe", "rug-large"];

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
 */
export function suggestFurniture(rooms: GeneratedRoom[]): PlacedFurniture[] {
  const placed: PlacedFurniture[] = [];

  for (const room of rooms) {
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

    /* ---- LIVING ROOM ---- */
    if (/living|lounge|family|media/i.test(name)) {
      // Sofa along the long wall
      const sofa = getFurnitureById("sofa-3-seater");
      if (sofa && rw >= sofa.width + 0.3) {
        placed.push({
          itemId: "sofa-3-seater",
          room: room.name,
          x: cx,
          y: room.y + rh * 0.72,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Coffee table in front of sofa
      if (roomArea >= 15) {
        placed.push({
          itemId: "coffee-table",
          room: room.name,
          x: cx,
          y: room.y + rh * 0.45,
          rotation: 0,
          scale: 1.0,
        });
      }

      // TV unit opposite sofa
      if (rw >= 1.5) {
        placed.push({
          itemId: "tv-unit",
          room: room.name,
          x: cx,
          y: room.y + rh * 0.12,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Armchairs for larger rooms
      if (roomArea >= 25) {
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

      // Rug under coffee table for larger rooms
      if (roomArea >= 22) {
        placed.push({
          itemId: "rug-large",
          room: room.name,
          x: cx,
          y: room.y + rh * 0.48,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Side tables
      if (rw >= 3) {
        placed.push({
          itemId: "side-table",
          room: room.name,
          x: room.x + rw * 0.12,
          y: room.y + rh * 0.7,
          rotation: 0,
          scale: 1.0,
        });
        placed.push({
          itemId: "side-table",
          room: room.name,
          x: room.x + rw * 0.88,
          y: room.y + rh * 0.7,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Plant
      if (roomArea >= 20 && rw >= 3) {
        placed.push({
          itemId: "plant-indoor",
          room: room.name,
          x: room.x + rw * 0.08,
          y: room.y + rh * 0.12,
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

        // Side table next to bed (only 1 for small rooms)
        const bedW = (rw > rh ? bed.width : bed.height) * bedScale;
        placed.push({
          itemId: "side-table",
          room: room.name,
          x: bedX - bedW / 2 - 0.3,
          y: bedY + bedH * 0.25,
          rotation: 0,
          scale: bedScale,
        });
        if (roomArea >= 12) {
          placed.push({
            itemId: "side-table",
            room: room.name,
            x: bedX + bedW / 2 + 0.3,
            y: bedY + bedH * 0.25,
            rotation: 0,
            scale: bedScale,
          });
        }
      }

      // Always place a wardrobe in every bedroom
      placed.push({
        itemId: "wardrobe",
        room: room.name,
        x: room.x + rw - 0.65,
        y: room.y + rh - 0.4,
        rotation: 0,
        scale: minDim >= 3 ? 1.0 : 0.8,
      });

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

    /* ---- KITCHEN — single counter via smartPlace ---- */
    if (/kitchen/i.test(name)) {
      const counterId = roomArea < 8 ? "kitchen-counter-small" : "kitchen-counter-straight";
      // ONE counter along top wall — use smartPlace for proper bounds & collision
      const counterResult = smartPlace(counterId, room, room.x + rw / 2, room.y + 0.5, 0, roomArea < 8 ? 0.85 : 0.9, placed);
      if (counterResult) placed.push(counterResult);

      // Stove
      placed.push({
        itemId: "stove-4-burner",
        room: room.name,
        x: room.x + rw * 0.75,
        y: room.y + 0.45,
        rotation: 0,
        scale: roomArea < 6 ? 0.8 : 1.0,
      });

      // Refrigerator
      if (rw >= 2 && rh >= 2) {
        placed.push({
          itemId: "refrigerator",
          room: room.name,
          x: room.x + rw - 0.5,
          y: room.y + rh - 0.5,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Sink
      placed.push({
        itemId: "kitchen-sink",
        room: room.name,
        x: room.x + rw * 0.35,
        y: room.y + 0.3,
        rotation: 0,
        scale: 1.0,
      });

      // Island for larger kitchens
      if (roomArea >= 14 && rw >= 3 && rh >= 3) {
        placed.push({
          itemId: "kitchen-island",
          room: room.name,
          x: cx,
          y: cy + 0.4,
          rotation: 0,
          scale: 1.0,
        });
      }

      // Dining nook if kitchen is large enough and no separate dining
      if (roomArea >= 16 && rw >= 3 && rh >= 3.5) {
        const nookX = room.x + rw * 0.25;
        const nookY = room.y + rh * 0.75;
        placed.push({
          itemId: "dining-table-4",
          room: room.name,
          x: nookX,
          y: nookY,
          rotation: 0,
          scale: 0.85,
        });
        // Chairs — only those that fit
        for (let i = 0; i < 4; i++) {
          const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
          const cx2 = nookX + Math.cos(angle) * 0.5;
          const cy2 = nookY + Math.sin(angle) * 0.5;
          if (pointInRoomBounds(cx2, cy2, room)) {
            placed.push({
              itemId: "dining-chair",
              room: room.name,
              x: cx2,
              y: cy2,
              rotation: 0,
              scale: 0.85,
            });
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
  ]);
  // Note: "bathtub" NOT in essentialIds — it gets full bounds check;
  // if it doesn't fit even after smartPlace, shower is substituted below

  // Items that MUST appear — if smartPlace fails, compute fitting scale
  const forceItems = new Set([
    "kitchen-counter-straight", "kitchen-counter-small", "stove-4-burner",
    "toilet", "kitchen-sink",
  ]);

  const validated: PlacedFurniture[] = [];

  for (const pf of placed) {
    const room = roomMap.get(pf.room);
    if (!room) continue;
    const item = getFurnitureById(pf.itemId);
    if (!item) continue;

    // Check current placement — swap w/h for 90°/270° rotation
    const isRotated = pf.rotation === 90 || pf.rotation === 270;
    const iw = (isRotated ? item.height : item.width) * pf.scale;
    const ih = (isRotated ? item.width : item.height) * pf.scale;
    const fits = isFurnitureInBounds(pf.x, pf.y, iw, ih, room);

    if (fits) {
      validated.push(pf);
      continue;
    }

    // Doesn't fit — try smartPlace for essentials (tries smaller scales too)
    if (essentialIds.has(pf.itemId)) {
      const fixed = smartPlace(pf.itemId, room, pf.x, pf.y, pf.rotation, pf.scale, validated);
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
