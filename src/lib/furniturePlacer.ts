/* ------------------------------------------------------------------ */
/*  Furniture Placer — intelligently places furniture in rooms         */
/*  Based on room type, size, and furniture dimensions                 */
/* ------------------------------------------------------------------ */

import { GeneratedRoom } from "./ai-client";
import { PlacedFurniture } from "./furniture";
import { getFurnitureForRoom, getFurnitureById } from "./furniture";

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

    /* ---- DINING ROOM — guaranteed table ---- */
    if (/dining/i.test(name)) {
      // Always place a dining table, scale down if room is small
      const tableId = roomArea >= 18 ? "dining-table-6" : "dining-table-4";
      const table = getFurnitureById(tableId);
      if (table) {
        const tableScale = roomArea < 10 ? 0.75 : 1.0;
        placed.push({
          itemId: tableId,
          room: room.name,
          x: cx,
          y: cy,
          rotation: rw > rh ? 0 : 90,
          scale: tableScale,
        });

        // Chairs around the table
        const chairCount = tableId === "dining-table-6" ? 6 : 4;
        const tw = table.width * tableScale;
        const th = table.height * tableScale;

        for (let i = 0; i < chairCount; i++) {
          const angle = (i / chairCount) * Math.PI * 2 - Math.PI / 2;
          const dist = Math.max(tw, th) * 0.55;
          placed.push({
            itemId: "dining-chair",
            room: room.name,
            x: cx + Math.cos(angle) * dist,
            y: cy + Math.sin(angle) * dist,
            rotation: 0,
            scale: tableScale,
          });
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

    /* ---- KITCHEN ---- */
    if (/kitchen/i.test(name)) {
      // Counters along walls
      placed.push({
        itemId: "kitchen-counter-straight",
        room: room.name,
        x: room.x + rw / 2,
        y: room.y + 0.35,
        rotation: 0,
        scale: 1.0,
      });

      if (rw >= 3.5 && rh >= 3) {
        placed.push({
          itemId: "kitchen-counter-straight",
          room: room.name,
          x: room.x + 0.35,
          y: cy,
          rotation: 90,
          scale: 1.0,
        });
      }

      // Stove
      placed.push({
        itemId: "stove-4-burner",
        room: room.name,
        x: room.x + rw * 0.75,
        y: room.y + 0.45,
        rotation: 0,
        scale: 1.0,
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
        placed.push({
          itemId: "dining-table-4",
          room: room.name,
          x: room.x + rw * 0.25,
          y: room.y + rh * 0.75,
          rotation: 0,
          scale: 1.0,
        });
        // 4 chairs
        const tableX = room.x + rw * 0.25;
        const tableY = room.y + rh * 0.75;
        for (let i = 0; i < 4; i++) {
          const angle = (i / 4) * Math.PI * 2 - Math.PI / 2;
          placed.push({
            itemId: "dining-chair",
            room: room.name,
            x: tableX + Math.cos(angle) * 0.55,
            y: tableY + Math.sin(angle) * 0.55,
            rotation: 0,
            scale: 1.0,
          });
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

  return placed;
}
