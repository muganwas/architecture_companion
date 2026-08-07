import { GeneratedRoom, Door, Window } from "./ai-client";

/* ------------------------------------------------------------------ */
/*  Abstract plan — what the LLM outputs                               */
/* ------------------------------------------------------------------ */

export interface AbstractPlan {
  totalArea: number;                    // m²
  hallwayWidth: number;                 // meters (1.0–1.5)
  hallwaySide: "center" | "left" | "right";
  zones: {
    frontLeft?: string[];               // room names
    leftMiddle?: string[];
    backLeft?: string[];
    frontRight?: string[];
    rightMiddle?: string[];
    backRight?: string[];
  };
  roomRatios: Record<string, number>;   // roomName → fraction of total area
  exteriorExtensions: Record<string, "front" | "back" | "left" | "right">;
  /** Optional creative shape hints */
  roomShapes?: Record<string, "rectangle" | "l-shape" | "bay-window" | "angled-corner">;
}

export interface LayoutResult {
  rooms: GeneratedRoom[];
  doors: Door[];
  windows: Window[];
  /** Building perimeter polygon (world coords, meters) */
  buildingPolygon?: Array<{ x: number; y: number }>;
}

/* ------------------------------------------------------------------ */
/*  Layout engine                                                      */
/* ------------------------------------------------------------------ */

export function computeLayout(plan: AbstractPlan): LayoutResult {
  let { totalArea, hallwaySide, zones, roomRatios, exteriorExtensions } = plan;

  // Sanity: minimum total area is 60m², maximum 500m²
  if (totalArea < 60) {
    console.warn(`Layout engine: totalArea ${totalArea}m² too small, defaulting to 100m²`);
    totalArea = 100;
  }
  if (totalArea > 500) {
    console.warn(`Layout engine: totalArea ${totalArea}m² too large, capping at 500m²`);
    totalArea = 500;
  }

  // ── Step 0: Fixed column widths — rooms fill columns completely ──
  // Building shape is determined by rooms, not vice versa
  const hallwayWidth = 1.2;
  const colWidth = 5.5; // fixed column width for consistent room sizing
  const buildingW = colWidth * 2 + hallwayWidth; // ~12.2m
  const buildingH = totalArea / buildingW;
  const polyBounds = { x: 0, y: 0, w: buildingW, h: buildingH };

  // Normalize ratios to sum to 1.0 (exclude hallway, porch, balcony from ratio calc)
  const interiorRatios: Record<string, number> = {};
  let ratioSum = 0;
  for (const [name, ratio] of Object.entries(roomRatios)) {
    if (/hallway|porch|balcony/i.test(name)) continue;
    interiorRatios[name] = ratio;
    ratioSum += ratio;
  }
  if (ratioSum > 0) {
    for (const name of Object.keys(interiorRatios)) {
      interiorRatios[name] /= ratioSum;
    }
  }

  // Step 1: Place hallway between the two fixed-width columns
  let hallwayX: number;
  if (hallwaySide === "left") hallwayX = polyBounds.x;
  else if (hallwaySide === "right") hallwayX = polyBounds.x + colWidth * 2 + hallwayWidth - hallwayWidth;
  else hallwayX = polyBounds.x + colWidth; // center: between the two columns

  const hallway: GeneratedRoom = {
    name: "Hallway",
    x: hallwayX,
    y: polyBounds.y,
    width: hallwayWidth,
    height: buildingH,
    area: hallwayWidth * buildingH,
  };

  // Step 2: Fixed column zones — rooms span full column width, touching hallway
  const leftZoneX = polyBounds.x;
  const leftZoneWidth = colWidth;
  const rightZoneX = polyBounds.x + colWidth + hallwayWidth;
  const rightZoneWidth = colWidth;

  const rooms: GeneratedRoom[] = [hallway];

  // Step 3: Place rooms in columns with balanced proportions
  const minRoomWidth = 2.2; // minimum room width in meters (fits a bed)

  /**
   * Returns a priority score for room size ordering.
   * Low score = small rooms placed first (bathroom, laundry, office, ensuite).
   * High score = large rooms placed last (master, living, kitchen, garage, dining).
   * Large rooms get the column's remaining space benefit.
   */
  function roomSizePriority(name: string): number {
    const n = name.toLowerCase();
    if (/bathroom|ensuite|wc|toilet|powder/i.test(n) && !/master/i.test(n)) return 0;
    if (/laundry|utility|pantry|closet/i.test(n)) return 1;
    if (/office|study|den/i.test(n)) return 2;
    if (/bedroom/i.test(n) && !/master/i.test(n)) return 3;
    if (/hallway|corridor/i.test(n)) return 4;
    if (/dining/i.test(n)) return 5;
    if (/kitchen/i.test(n)) return 6;
    if (/living|lounge|family/i.test(n)) return 7;
    if (/garage/i.test(n)) return 8;
    if (/master/i.test(n)) return 9;
    return 5; // default mid-priority
  }

  function placeColumnBalanced(
    names: string[],
    x: number,
    colWidth: number,
    startY: number,
    endY: number
  ): number {
    let colRoomNames = names.filter(n => !/hallway|porch|balcony/i.test(n));
    if (colRoomNames.length === 0) return startY;

    // ── Merge ensuite into master bedroom ──
    // An ensuite is a bathroom attached to the master, not a standalone room.
    // Fold its ratio into the master; we'll carve it out in post-processing.
    const hasMaster = colRoomNames.some(n => /master/i.test(n));
    const hasEnsuite = colRoomNames.some(n => /ensuite/i.test(n));
    if (hasMaster && hasEnsuite) {
      const ensuiteName = colRoomNames.find(n => /ensuite/i.test(n))!;
      const masterName = colRoomNames.find(n => /master/i.test(n))!;
      // Transfer ensuite ratio to master bedroom
      interiorRatios[masterName] = (interiorRatios[masterName] || 0) + (interiorRatios[ensuiteName] || 0);
      // Remove ensuite from column — it will be carved from master later
      colRoomNames = colRoomNames.filter(n => !/ensuite/i.test(n));
    }

    // Zone order (back→middle→front) determines placement — no priority sort.
    // Back rooms (bedrooms) go at top, front rooms (garage) at bottom.

    const colRatioSum = colRoomNames.reduce((s, n) => s + (interiorRatios[n] || 0), 0);
    if (colRatioSum === 0) return startY;

    const colHeight = endY - startY;
    let currentY = startY;

    for (let idx = 0; idx < colRoomNames.length; idx++) {
      const name = colRoomNames[idx];
      const ratio = (interiorRatios[name] || 0) / colRatioSum;
      let roomH = ratio * colHeight;
      let roomW = colWidth;

      // Enforce balanced proportions: max aspect ratio 2:1
      // Only cap HEIGHT (too tall) — never reduce WIDTH (creates gaps to hallway)
      if (roomH > roomW * 2.0) {
        roomH = roomW * 2.0;
      }
      // If too wide, increase height instead of reducing width
      if (roomW > roomH * 2.0) {
        roomH = Math.max(roomH, roomW / 2.0);
      }

      // ── Minimum room sizes by type ──
      const minArea = getMinRoomArea(name);
      const minW = getMinRoomWidth(name);
      roomW = Math.max(roomW, minW, minRoomWidth);
      roomH = Math.max(roomH, 2.0);

      // Don't exceed column bounds
      const remainingH = endY - currentY;
      const isLast = idx === colRoomNames.length - 1;
      if (isLast) {
        // Last room: take remaining space, but cap at its max area
        const maxArea = getMaxRoomArea(name);
        const maxH = maxArea / roomW;
        roomH = Math.min(remainingH, maxH);
      } else {
        roomH = Math.min(roomH, remainingH - 1.5);
      }
      roomH = Math.max(roomH, 2.0);

      // Ensure minimum area by adjusting height if needed
      const roomArea = roomW * roomH;
      if (roomArea < minArea) {
        roomH = Math.max(roomH, minArea / roomW);
        if (!isLast) {
          roomH = Math.min(roomH, remainingH - 1.5);
        }
      }

      // ── Maximum room size caps ── (now applies to ALL rooms including last)
      const maxArea = getMaxRoomArea(name);
      if (roomW * roomH > maxArea) {
        roomH = Math.max(1.5, maxArea / roomW);
      }

      rooms.push({
        name,
        x,
        y: currentY,
        width: roomW,
        height: roomH,
        area: parseFloat((roomW * roomH).toFixed(1)),
      });

      currentY += roomH;
    }

    return currentY;
  }

  // ── Deduplicate: never allow duplicate room names (two "Bathroom"s) ──
  const seenNames = new Set<string>();
  for (const zoneKey of ["frontLeft","leftMiddle","backLeft","frontRight","rightMiddle","backRight"]) {
    const arr = (zones as Record<string, string[]>)[zoneKey];
    if (!arr) continue;
    for (let i = arr.length - 1; i >= 0; i--) {
      const lower = arr[i].toLowerCase();
      if (seenNames.has(lower)) {
        console.warn("[dedupe] removing duplicate \"" + arr[i] + "\" from " + zoneKey);
        arr.splice(i, 1);
      } else {
        seenNames.add(lower);
      }
    }
  }

  // ── Enforce garage always in a front zone ──
  for (const zoneKey of ["backLeft","leftMiddle","backRight","rightMiddle","frontLeft","frontRight"]) {
    const arr = (zones as Record<string, string[]>)[zoneKey];
    if (!arr) continue;
    const gIdx = arr.findIndex(n => /garage/i.test(n));
    if (gIdx >= 0 && !zoneKey.startsWith("front")) {
      const side = zoneKey.includes("Left") ? "frontLeft" : "frontRight";
      if (!(zones as Record<string, string[]>)[side]) (zones as Record<string, string[]>)[side] = [];
      (zones as Record<string, string[]>)[side]!.push("Garage");
      arr.splice(gIdx, 1);
      console.log("[garage-front] moved garage from " + zoneKey + " to " + side);
    }
  }

  // ── Enforce living room always in a front zone ──
  // The living room is the face of the house — always faces the front.
  for (const zoneKey of ["backLeft","leftMiddle","backRight","rightMiddle"]) {
    const arr = (zones as Record<string, string[]>)[zoneKey];
    if (!arr) continue;
    const lrIdx = arr.findIndex(n => /living|lounge|family/i.test(n));
    if (lrIdx >= 0) {
      const side = zoneKey.includes("Left") ? "frontLeft" : "frontRight";
      if (!(zones as Record<string, string[]>)[side]) (zones as Record<string, string[]>)[side] = [];
      const frontZone = (zones as Record<string, string[]>)[side]!;
      // Swap: living room → front zone, whatever was in front → living's old spot
      const displaced = frontZone.length > 0 ? frontZone.shift()! : null;
      frontZone.push(arr[lrIdx]);
      arr.splice(lrIdx, 1);
      if (displaced) arr.push(displaced);
      console.log("[living-front] moved Living Room to " + side + (displaced ? ", swapped with " + displaced : ""));
      break;
    }
  }

  // Place left column rooms — front→back: front rooms at bottom (y=0), back rooms at top
  // Porch and Balcony are exterior extensions only, never regular rooms
  const isNotExtension = (n: string) => !/porch|balcony/i.test(n);
  const leftRooms = [
    ...(zones.frontLeft || []).filter(isNotExtension),
    ...(zones.leftMiddle || []).filter(isNotExtension),
    ...(zones.backLeft || []).filter(isNotExtension),
  ];
  let leftEndY = polyBounds.y;
  if (leftRooms.length > 0 && leftZoneWidth >= minRoomWidth) {
    leftEndY = placeColumnBalanced(leftRooms, leftZoneX, leftZoneWidth, polyBounds.y, polyBounds.y + buildingH);
  }

  // Place right column rooms — front→back: front rooms at bottom (y=0), back rooms at top
  const rightRooms = [
    ...(zones.frontRight || []).filter(isNotExtension),
    ...(zones.rightMiddle || []).filter(isNotExtension),
    ...(zones.backRight || []).filter(isNotExtension),
  ];
  let rightEndY = polyBounds.y;
  if (rightRooms.length > 0 && rightZoneWidth >= minRoomWidth) {
    rightEndY = placeColumnBalanced(rightRooms, rightZoneX, rightZoneWidth, polyBounds.y, polyBounds.y + buildingH);
  }

  // ── Cap hallway height to the tallest column ── (no wasted hallway past last room)
  const maxEndY = Math.max(leftEndY, rightEndY);
  hallway.height = maxEndY - polyBounds.y;
  hallway.area = parseFloat((hallway.width * hallway.height).toFixed(1));

  // ── Post-processing: carve ensuite from master bedroom FIRST ──
  // (must happen before dominance check so master's final size is used)
  carveEnsuiteFromMaster(rooms, hallway);

  // ── Post-processing: enforce master bedroom dominance ──
  enforceMasterDominance(rooms);

  // ── Post-processing: enforce zero-gap adjacency ──
  // Every column room must span full column width and stack flush
  enforceZeroGapAdjacency(rooms, leftZoneX, leftZoneWidth, polyBounds.y, leftEndY);
  enforceZeroGapAdjacency(rooms, rightZoneX, rightZoneWidth, polyBounds.y, rightEndY);

  // Step 4: Building polygon is decorative outline only — do NOT clip rooms.
  // Clipping destroys usable room area and creates gaps between rooms.
  // The polygon is rendered as a subtle dashed outline for visual interest.

  // Step 5: Add exterior extensions (porch, balcony) attached to appropriate rooms.
  // Multiple balconies get different hosts (living room first, then master bedroom, etc.)
  const usedHosts = new Set<string>();
  for (const [roomName, side] of Object.entries(exteriorExtensions)) {
    const extRoom = createSmartExtension(roomName, side, rooms, [], usedHosts);
    if (extRoom) rooms.push(extRoom);
  }

  // Step 6: Generate main entrance first, then internal doors, balcony doors, then windows.
  // All doors must be known before windows so windows can avoid overlapping any door.
  const mainEntranceDoors = generateMainEntrance(rooms);
  const doors = generateDoors(rooms);
  for (const d of mainEntranceDoors) doors.push(d);
  const balconyDoors = generateBalconyDoors(rooms);
  for (const d of balconyDoors) doors.push(d);
  const windows = generateWindows(rooms, buildingW, buildingH, doors);

  // Step 7: Apply creative shapes post-processing (interior shapes only)
  applyCreativeShapes(rooms, plan.roomShapes || {}, buildingW, buildingH);

  // Build perimeter polygon from room extents (rooms define the house, not vice versa)
  const extents = rooms.reduce((acc, r) => {
    const rx = r.x, ry = r.y, rw = r.width, rh = r.height;
    if (rx < acc.minX) acc.minX = rx;
    if (ry < acc.minY) acc.minY = ry;
    if (rx + rw > acc.maxX) acc.maxX = rx + rw;
    if (ry + rh > acc.maxY) acc.maxY = ry + rh;
    return acc;
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const buildingPoly = [
    { x: extents.minX, y: extents.minY },
    { x: extents.maxX, y: extents.minY },
    { x: extents.maxX, y: extents.maxY },
    { x: extents.minX, y: extents.maxY },
  ];

  return { rooms, doors, windows, buildingPolygon: buildingPoly };
}

/* ------------------------------------------------------------------ */
/*  Creative shape post-processing                                     */
/* ------------------------------------------------------------------ */

/**
 * Applies creative room shapes (L-shape, bay window, angled corners)
 * to make the floor plan more interesting and space-efficient.
 */
function applyCreativeShapes(
  rooms: GeneratedRoom[],
  shapeHints: Record<string, "rectangle" | "l-shape" | "bay-window" | "angled-corner">,
  buildingW: number,
  buildingH: number
): void {
  const TOL = 0.15;

  for (const room of rooms) {
    // Skip hallway, extensions, very small rooms
    if (/hallway|corridor|foyer|porch|balcony/i.test(room.name)) continue;
    if (room.width < 2 || room.height < 2 || room.area < 6) continue;

    const hint = shapeHints[room.name.toLowerCase()];

    // Determine shape based on hint or room characteristics
    const shape = hint || inferShape(room, buildingW, buildingH);

    switch (shape) {
      case "l-shape":
        applyLShape(room);
        break;
      case "bay-window":
        applyBayWindow(room, buildingW, buildingH);
        break;
      case "angled-corner":
        applyAngledCorner(room, buildingW, buildingH);
        break;
      // rectangle: no transform needed
    }
  }
}

/** Infer the best creative shape for a room based on its position */
function inferShape(
  room: GeneratedRoom,
  buildingW: number,
  buildingH: number
): "rectangle" | "l-shape" | "bay-window" | "angled-corner" {
  const TOL = 0.1;
  const name = room.name.toLowerCase();

  // Living rooms get bay windows on exterior walls
  if (/living|lounge|family/i.test(name)) {
    if (Math.abs(room.y) < TOL) return "bay-window";
    return "rectangle";
  }

  // Master bedrooms can get angled corners
  if (/master/i.test(name) && room.area > 14) {
    return "angled-corner";
  }

  // Dining rooms next to kitchen: L-shape for open-plan feel
  if (/dining/i.test(name) && room.area > 10) {
    return "l-shape";
  }

  // Kitchens and bathrooms must stay rectangular for proper furniture fitting
  if (/kitchen|bathroom|ensuite/i.test(name)) {
    return "rectangle";
  }

  return "rectangle";
}

/** Convert a rectangular room to an L-shaped room */
function applyLShape(room: GeneratedRoom): void {
  const { x, y, width, height } = room;
  if (width < 2.5 || height < 2.5) return;

  // Create an L-shape by carving out a corner
  // The "leg" takes 40% of the width and 40% of the height in one corner
  const legW = width * 0.4;
  const legH = height * 0.4;

  // L-shape: main rect + leg extending from bottom-right corner
  room.shape = "l-shape";
  room.polygon = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + legH },
    { x: x + width - legW, y: y + legH },
    { x: x + width - legW, y: y + height },
    { x, y: y + height },
  ];

  // The effective area remains approximately the same
  // (slightly reduced due to the notch, but visually interesting)
  const polyArea = polygonArea(room.polygon);
  room.area = parseFloat(polyArea.toFixed(1));
}

/** Add a bay window protrusion to an exterior wall */
function applyBayWindow(
  room: GeneratedRoom,
  buildingW: number,
  buildingH: number
): void {
  const { x, y, width, height } = room;
  const TOL = 0.1;
  const bayDepth = 0.6; // meters
  const bayWidth = Math.min(width * 0.4, 2.0); // bay window width

  // Find which wall is exterior
  let wall: "top" | "bottom" | "left" | "right" | null = null;

  if (Math.abs(y) < TOL) wall = "bottom";
  else if (Math.abs(y + height - buildingH) < TOL) wall = "top";
  else if (Math.abs(x) < TOL) wall = "left";
  else if (Math.abs(x + width - buildingW) < TOL) wall = "right";

  if (!wall || width < 3) return;

  const bayStart = (width - bayWidth) / 2;
  const bayEnd = bayStart + bayWidth;

  room.shape = "bay-window";
  const corners: Array<{ x: number; y: number }> = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];

  // Insert bay window points into the polygon
  if (wall === "bottom") {
    room.polygon = [
      corners[0],
      { x: x + bayStart, y },
      { x: x + bayStart + bayWidth * 0.2, y: y - bayDepth },
      { x: x + bayStart + bayWidth * 0.5, y: y - bayDepth * 1.1 },
      { x: x + bayStart + bayWidth * 0.8, y: y - bayDepth },
      { x: x + bayEnd, y },
      corners[1], corners[2], corners[3],
    ];
  } else if (wall === "top") {
    room.polygon = [
      corners[0], corners[1],
      { x: x + bayEnd, y: y + height },
      { x: x + bayStart + bayWidth * 0.8, y: y + height + bayDepth },
      { x: x + bayStart + bayWidth * 0.5, y: y + height + bayDepth * 1.1 },
      { x: x + bayStart + bayWidth * 0.2, y: y + height + bayDepth },
      { x: x + bayStart, y: y + height },
      corners[3],
    ];
  } else if (wall === "left") {
    room.polygon = [
      corners[0],
      { x, y: y + bayStart + bayWidth * 0.2 },
      { x: x - bayDepth, y: y + bayStart + bayWidth * 0.5 },
      { x, y: y + bayStart + bayWidth * 0.8 },
      corners[1], corners[2],
      { x, y: y + height },
    ];
  } else if (wall === "right") {
    room.polygon = [
      corners[0],
      { x: x + width, y },
      { x: x + width, y: y + bayStart + bayWidth * 0.2 },
      { x: x + width + bayDepth, y: y + bayStart + bayWidth * 0.5 },
      { x: x + width, y: y + bayStart + bayWidth * 0.8 },
      corners[2], corners[3],
    ];
  }

  if (!room.polygon) return;
  const polyArea = polygonArea(room.polygon);
  room.area = parseFloat(polyArea.toFixed(1));
}

/** Add an angled (45°) corner to one exterior corner of the room */
function applyAngledCorner(
  room: GeneratedRoom,
  buildingW: number,
  buildingH: number
): void {
  const { x, y, width, height } = room;
  const TOL = 0.1;
  const angleSize = 1.0; // how far in to clip

  if (width < 3 || height < 3) return;

  // Find which corner is exterior (touching building boundary)
  // Clip that corner at 45°
  const isLeftExterior = Math.abs(x) < TOL;
  const isRightExterior = Math.abs(x + width - buildingW) < TOL;
  const isBottomExterior = Math.abs(y) < TOL;
  const isTopExterior = Math.abs(y + height - buildingH) < TOL;

  room.shape = "angled-corner";

  if (isBottomExterior && isLeftExterior) {
    // Bottom-left corner angled
    room.polygon = [
      { x: x + angleSize, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
      { x, y: y + angleSize },
    ];
  } else if (isBottomExterior && isRightExterior) {
    // Bottom-right corner angled
    room.polygon = [
      { x, y },
      { x: x + width - angleSize, y },
      { x: x + width, y: y + angleSize },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  } else if (isTopExterior && isLeftExterior) {
    // Top-left corner angled
    room.polygon = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x: x + angleSize, y: y + height },
      { x, y: y + height - angleSize },
    ];
  } else if (isTopExterior && isRightExterior) {
    // Top-right corner angled
    room.polygon = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height - angleSize },
      { x: x + width - angleSize, y: y + height },
      { x, y: y + height },
    ];
  } else {
    // No corner is fully exterior, keep rectangular
    return;
  }

  if (!room.polygon) return;
  const polyArea = polygonArea(room.polygon);
  room.area = parseFloat(polyArea.toFixed(1));
}

/** Calculate area of a polygon using the shoelace formula */
function polygonArea(vertices: Array<{ x: number; y: number }>): number {
  let area = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += vertices[i].x * vertices[j].y;
    area -= vertices[j].x * vertices[i].y;
  }
  return Math.abs(area) / 2;
}

/** Get minimum area (m²) for a room type */
function getMinRoomArea(name: string): number {
  const n = name.toLowerCase();
  if (/garage/i.test(n)) return 14;
  if (/living|lounge|family/i.test(n)) return 14;
  if (/master/i.test(n)) return 12;
  if (/bedroom/i.test(n)) return 9;
  if (/kitchen/i.test(n)) return 6;
  if (/dining/i.test(n)) return 8;
  if (/bathroom|ensuite/i.test(n)) return 3.5;
  if (/office|study/i.test(n)) return 6;
  if (/laundry/i.test(n)) return 4;
  return 4;
}

/** Get minimum width (m) for a room type */
function getMinRoomWidth(name: string): number {
  const n = name.toLowerCase();
  if (/garage/i.test(n)) return 3.0;
  if (/living|lounge|family/i.test(n)) return 3.0;
  if (/master|bedroom/i.test(n)) return 2.5;
  if (/kitchen/i.test(n)) return 2.0;
  if (/dining/i.test(n)) return 2.2;
  if (/bathroom|ensuite/i.test(n)) return 1.5;
  return 2.0;
}

/** Get maximum area (m²) for a room type — prevents rooms from ballooning */
function getMaxRoomArea(name: string): number {
  const n = name.toLowerCase();
  if (/ensuite/i.test(n)) return 5;
  if (/bathroom/i.test(n)) return 8;
  if (/laundry/i.test(n)) return 6;
  if (/office|study/i.test(n)) return 12;
  if (/bedroom/i.test(n) && !/master/i.test(n)) return 18;
  if (/master/i.test(n)) return 28;       // master bedroom max ~28m²
  if (/living|lounge|family/i.test(n)) return 32;  // living room max ~32m²
  if (/kitchen/i.test(n)) return 20;       // kitchen max ~20m²
  if (/dining/i.test(n)) return 16;
  return 999; // garage, hallway, etc. — no cap
}

/**
 * Ensure every room in a column spans the full column width (flush with hallway)
 * and stacks exactly on the room below it (zero gap).
 */
function enforceZeroGapAdjacency(
  rooms: GeneratedRoom[],
  colX: number,
  colWidth: number,
  colStartY: number,
  colEndY: number
): void {
  const TOL = 0.1;

  // Find rooms in this column (exclude hallway, extensions)
  const colRooms = rooms
    .filter(r => !/hallway|porch|balcony|ensuite/i.test(r.name) && Math.abs(r.x - colX) < colWidth)
    .sort((a, b) => a.y - b.y); // top to bottom

  if (colRooms.length === 0) return;

  // Fix widths: every room spans full column width, flush to hallway side
  for (const room of colRooms) {
    room.x = colX;
    room.width = colWidth;
    room.area = parseFloat((room.width * room.height).toFixed(1));
  }

  // ── Enforce max area caps: trim any room that exceeds its max ──
  let trimmedTotal = 0;
  for (const room of colRooms) {
    const maxArea = getMaxRoomArea(room.name);
    const currentArea = room.width * room.height;
    if (currentArea > maxArea + 0.1) {
      const trimmedH = maxArea / room.width;
      trimmedTotal += (room.height - trimmedH) * room.width;
      room.height = parseFloat(trimmedH.toFixed(2));
      room.area = parseFloat(maxArea.toFixed(1));
    }
  }

  // Fix stacking: each room starts exactly where the previous one ends
  let expectedY = colStartY;
  for (const room of colRooms) {
    room.y = expectedY;
    expectedY += room.height;
  }

  // If total height < colEndY, distribute remaining space among rooms
  // that haven't hit their max area cap yet (not just the bottom room).
  const excess = (colEndY - expectedY) + (trimmedTotal / colWidth);
  if (excess > TOL && colRooms.length > 0) {
    // Sort by priority: give excess to rooms furthest from their max cap first
    const eligible = colRooms.map(r => {
      const maxArea = getMaxRoomArea(r.name);
      const currentArea = r.width * r.height;
      const headroom = Math.max(0, maxArea - currentArea);
      return { room: r, headroom };
    }).filter(e => e.headroom > 0.1);

    if (eligible.length > 0) {
      const totalHeadroom = eligible.reduce((s, e) => s + e.headroom, 0);
      let remaining = excess;
      for (const e of eligible) {
        // Distribute proportionally to headroom
        const share = Math.min(remaining * (e.headroom / totalHeadroom), e.headroom / e.room.width);
        e.room.height = parseFloat((e.room.height + share).toFixed(2));
        e.room.area = parseFloat((e.room.width * e.room.height).toFixed(1));
        remaining -= share * e.room.width;
      }
      // Re-stack after redistribution
      let y = colStartY;
      for (const room of colRooms) {
        room.y = y;
        y += room.height;
      }
    }
    // If no room has headroom left, leave the excess as-is (gap above rooms is fine)
  }
}

/**
 * Ensure the garage (if present) shares an internal wall with the kitchen.
 *
 * Runs AFTER zero-gap stacking so room positions are stable.  Strategy:
 * 1. Find garage & kitchen.  If either is missing or they already share a
 *    wall, nothing to do.
 * 2. If they're in the same column but not adjacent, re-order the column
 *    so kitchen is immediately next to the garage.
 * 3. If they're in different columns, swap kitchen with the room that is
 *    directly adjacent to the garage in the garage's column.
 * 4. After any move, re-stack the affected column(s) via the same zero-gap
 *    logic so heights stay correct.
 */
function enforceKitchenGarageAdjacency(
  rooms: GeneratedRoom[],
  leftZoneX: number,
  leftZoneWidth: number,
  rightZoneX: number,
  rightZoneWidth: number,
  colStartY: number,
  leftEndY: number,
  rightEndY: number,
): void {
  const TOL = 0.15;
  const garage = rooms.find(r => /garage/i.test(r.name));
  const kitchen = rooms.find(r => /kitchen/i.test(r.name));
  if (!garage || !kitchen) return;

  // Already adjacent?
  if (findWallBetween(garage, kitchen)) {
    console.log("[kitchen-garage] already adjacent, nothing to do");
    return;
  }

  console.log("[kitchen-garage] NOT adjacent — fixing. garage at", { x: garage.x, y: garage.y, w: garage.width, h: garage.height }, "kitchen at", { x: kitchen.x, y: kitchen.y, w: kitchen.width, h: kitchen.height });

  // Determine which column each is in (after zero-gap, x is exactly colX)
  const inLeft = (r: GeneratedRoom) => Math.abs(r.x - leftZoneX) < 0.3;
  const inRight = (r: GeneratedRoom) => Math.abs(r.x - rightZoneX) < 0.3;
  const garageCol = inLeft(garage) ? "left" : inRight(garage) ? "right" : null;
  if (!garageCol) return; // shouldn't happen

  const colX = garageCol === "left" ? leftZoneX : rightZoneX;
  const colW = garageCol === "left" ? leftZoneWidth : rightZoneWidth;
  const colEndY = garageCol === "left" ? leftEndY : rightEndY;

  // All non-garage, non-kitchen, non-hallway rooms in the garage's column,
  // sorted bottom→top.
  const colRooms = rooms
    .filter(r =>
      r !== garage && r !== kitchen &&
      !/hallway|porch|balcony|ensuite/i.test(r.name) &&
      Math.abs(r.x - colX) < 0.3
    )
    .sort((a, b) => a.y - b.y);

  // Find the room directly adjacent to the garage (above or below),
  // skipping master bedrooms (swapping master would orphan its ensuite).
  let adjacentRoom: GeneratedRoom | null = null;
  const isSafeToSwap = (r: GeneratedRoom) => !/master/i.test(r.name);
  for (const r of colRooms) {
    if ((Math.abs(r.y - (garage.y + garage.height)) < TOL ||
         Math.abs(r.y + r.height - garage.y) < TOL) && isSafeToSwap(r)) {
      adjacentRoom = r;
      break;
    }
  }

  // Fallback: closest safe room in the column
  if (!adjacentRoom) {
    const safe = colRooms.filter(isSafeToSwap);
    if (safe.length > 0) {
      adjacentRoom = safe.reduce((best, r) => {
        const dBest = Math.min(
          Math.abs(best.y - (garage.y + garage.height)),
          Math.abs(best.y + best.height - garage.y)
        );
        const dR = Math.min(
          Math.abs(r.y - (garage.y + garage.height)),
          Math.abs(r.y + r.height - garage.y)
        );
        return dR < dBest ? r : best;
      });
    }
  }

  if (!adjacentRoom) {
    console.log("[kitchen-garage] ⚠️ no safe room to swap — skipping force-adjacency, will fall back to hallway door");
    return;
  }

  // ── Swap kitchen with the adjacent room ──
  const kX = kitchen.x, kY = kitchen.y, kW = kitchen.width, kH = kitchen.height;
  kitchen.x = adjacentRoom.x;
  kitchen.y = adjacentRoom.y;
  kitchen.width = adjacentRoom.width;
  kitchen.height = adjacentRoom.height;
  kitchen.area = adjacentRoom.area;
  adjacentRoom.x = kX;
  adjacentRoom.y = kY;
  adjacentRoom.width = kW;
  adjacentRoom.height = kH;
  adjacentRoom.area = parseFloat((kW * kH).toFixed(1));

  // ── Re-stack BOTH columns so zero-gap holds ──
  // Garage's column now has kitchen instead of adjacentRoom
  enforceZeroGapAdjacency(rooms, colX, colW, colStartY, colEndY);
  // The other column (where adjacentRoom moved) also needs re-stacking
  const otherColX = garageCol === "left" ? rightZoneX : leftZoneX;
  const otherColW = garageCol === "left" ? rightZoneWidth : leftZoneWidth;
  const otherEndY = garageCol === "left" ? rightEndY : leftEndY;
  enforceZeroGapAdjacency(rooms, otherColX, otherColW, colStartY, otherEndY);

  // Verify adjacency was achieved
  if (findWallBetween(garage, kitchen)) {
    console.log("[kitchen-garage] ✅ adjacency fixed. kitchen now at", { x: kitchen.x, y: kitchen.y, w: kitchen.width, h: kitchen.height });
  } else {
    console.warn("[kitchen-garage] ❌ FAILED to make kitchen adjacent to garage!");
  }
}

/**
 * Ensure the master bedroom is the largest bedroom in the house.
 * If a non-master bedroom is larger, cap it to 90% of master's area.
 */
function enforceMasterDominance(rooms: GeneratedRoom[]): void {
  const master = rooms.find(r => /master/i.test(r.name));
  if (!master) return;

  for (const room of rooms) {
    if (room === master) continue;
    if (!/bedroom/i.test(room.name)) continue;
    if (/bathroom/i.test(room.name)) continue;

    // Cap non-master bedroom to at most 90% of master area
    const maxArea = master.area * 0.9;
    if (room.area > maxArea) {
      // Reduce height to cap the area
      const scale = Math.sqrt(maxArea / room.area);
      room.height = parseFloat((room.height * scale).toFixed(2));
      room.area = parseFloat((room.width * room.height).toFixed(1));
    }
  }
}

/**
 * Place ensuite INSIDE the master bedroom — a sub-room within master's boundaries.
 * The master keeps its full area; the ensuite is a private bathroom in one corner.
 */
function carveEnsuiteFromMaster(rooms: GeneratedRoom[], hallway: GeneratedRoom): void {
  const master = rooms.find(r => /master/i.test(r.name));
  if (!master) return;

  // Don't create ensuite if master is too small
  if (master.area < 20) return;

  // Don't carve if there's already an ensuite in the rooms
  if (rooms.some(r => /ensuite/i.test(r.name))) return;

  const ensuiteW = 2.0;
  const ensuiteH = 2.5;
  const ensuiteArea = ensuiteW * ensuiteH; // 5.0m²

  // Safety: ensuite must fit inside master
  if (ensuiteW > master.width - 0.5 || ensuiteH > master.height - 1.0) return;

  // Place ensuite in exterior corner (away from hallway), at the bottom of master
  const isLeftColumn = master.x < hallway.x + hallway.width / 2;
  const ensuiteX = isLeftColumn
    ? master.x // exterior = left side
    : master.x + master.width - ensuiteW; // exterior = right side
  const ensuiteY = master.y + master.height - ensuiteH; // bottom of master

  // Master keeps its full area — ensuite is inside it
  // Create ensuite room (rendered on top of master in the canvas)
  rooms.push({
    name: "Ensuite",
    x: ensuiteX,
    y: ensuiteY,
    width: ensuiteW,
    height: ensuiteH,
    area: parseFloat(ensuiteArea.toFixed(1)),
  });
}

/* ------------------------------------------------------------------ */
/*  Building polygon generator (creative perimeters)                   */
/* ------------------------------------------------------------------ */

interface Bounds {
  x: number; y: number; w: number; h: number;
}

/** Generate a balanced convex-ish polygon with 4-8 sides for the building footprint */
function generateBuildingPolygon(targetArea: number): Array<{ x: number; y: number }> {
  // Pick number of sides: more area → more sides (but capped)
  const sides = targetArea > 200 ? pickRandom([5, 6, 6, 7]) :
                targetArea > 120 ? pickRandom([4, 5, 5, 6]) :
                pickRandom([4, 4, 5, 5]);

  // Start with a circle of the right radius, perturb the points
  const baseRadius = Math.sqrt(targetArea / Math.PI);
  const points: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2; // start from top
    // Add controlled randomness to make it interesting but not chaotic
    const jitter = 0.7 + Math.random() * 0.6; // 70%-130% of base radius
    points.push({
      x: Math.cos(angle) * baseRadius * jitter,
      y: Math.sin(angle) * baseRadius * jitter,
    });
  }

  // Scale to match target area exactly
  const currentArea = polygonArea(points);
  const scale = Math.sqrt(targetArea / currentArea);

  // Center the polygon at origin, then shift to positive coords
  let minX = Infinity, minY = Infinity;
  const scaled = points.map(p => {
    const sx = p.x * scale;
    const sy = p.y * scale;
    if (sx < minX) minX = sx;
    if (sy < minY) minY = sy;
    return { x: sx, y: sy };
  });

  // Shift so all coordinates are positive (origin at 0,0)
  return scaled.map(p => ({ x: p.x - minX, y: p.y - minY }));
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Get bounding box of a polygon */
function polygonBounds(poly: Array<{ x: number; y: number }>): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Check if a point is inside a polygon (ray casting) */
function pointInPolygon(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Check if a rectangle is fully contained within a polygon */
function rectInPolygon(
  rx: number, ry: number, rw: number, rh: number,
  poly: Array<{ x: number; y: number }>
): boolean {
  // Check all four corners + center
  const corners = [
    { x: rx, y: ry },
    { x: rx + rw, y: ry },
    { x: rx + rw, y: ry + rh },
    { x: rx, y: ry + rh },
    { x: rx + rw / 2, y: ry + rh / 2 },
  ];
  return corners.every(c => pointInPolygon(c.x, c.y, poly));
}

/**
 * Clip a room to the building polygon.
 * If the room's rectangle extends outside the building, create polygon vertices
 * for the visible portion. Interior rooms stay rectangular.
 */
function clipRoomToPolygon(
  room: GeneratedRoom,
  buildingPoly: Array<{ x: number; y: number }>
): void {
  // Quick check: is the room fully inside the polygon?
  if (rectInPolygon(room.x, room.y, room.width, room.height, buildingPoly)) {
    return; // fully inside, no clipping needed
  }

  // Room extends outside — generate clipped polygon
  // Sample the room's edges and find intersection points with the building polygon
  const clipped: Array<{ x: number; y: number }> = [];

  // Start with room corners, keep those inside the building
  const corners = [
    { x: room.x, y: room.y },
    { x: room.x + room.width, y: room.y },
    { x: room.x + room.width, y: room.y + room.height },
    { x: room.x, y: room.y + room.height },
  ];

  // Add building polygon vertices that fall inside the room
  for (const bp of buildingPoly) {
    if (bp.x >= room.x && bp.x <= room.x + room.width &&
        bp.y >= room.y && bp.y <= room.y + room.height) {
      clipped.push({ x: bp.x, y: bp.y });
    }
  }

  // Add room corners that fall inside the building
  for (const c of corners) {
    if (pointInPolygon(c.x, c.y, buildingPoly)) {
      clipped.push({ x: c.x, y: c.y });
    }
  }

  // If we have enough points, sort them clockwise and use as polygon
  if (clipped.length >= 3) {
    // Sort by angle from centroid
    const cx = clipped.reduce((s, p) => s + p.x, 0) / clipped.length;
    const cy = clipped.reduce((s, p) => s + p.y, 0) / clipped.length;
    clipped.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

    room.shape = "polygon";
    room.polygon = clipped;
    room.area = parseFloat(polygonArea(clipped).toFixed(1));
    // Update bounding rectangle to match polygon bounds
    const cb = polygonBounds(clipped);
    room.x = cb.x;
    room.y = cb.y;
    room.width = cb.w;
    room.height = cb.h;
  }
  // If clipping produced too few vertices, keep the rectangle as-is
}

/** Create exterior extension relative to the building polygon */
/**
 * Attach an exterior extension (porch/balcony) to the most appropriate room.
 * Balcony → living room (priority 1), then master bedroom, then any bedroom.
 * Porch → front of house, attached to living room or kitchen.
 * Multiple balconies get different hosts via the usedHosts set.
 */
function createSmartExtension(
  name: string,
  side: string,
  rooms: GeneratedRoom[],
  _buildingPoly: Array<{ x: number; y: number }>,
  usedHosts: Set<string> = new Set()
): GeneratedRoom | null {
  const isBalcony = /balcony/i.test(name);
  const isPorch = /porch/i.test(name);

  // Find the host room, skipping already-used hosts for balconies
  let hostRoom: GeneratedRoom | undefined;
  if (isBalcony) {
    // Priority: living room → master → any bedroom, but prefer unused rooms
    hostRoom = rooms.find(r => /living|lounge|family/i.test(r.name) && !usedHosts.has(r.name))
            || rooms.find(r => /master/i.test(r.name) && !usedHosts.has(r.name))
            || rooms.find(r => /bedroom/i.test(r.name) && !usedHosts.has(r.name))
            // Fall back to any room even if already used
            || rooms.find(r => /living|lounge|family/i.test(r.name))
            || rooms.find(r => /master/i.test(r.name))
            || rooms.find(r => /bedroom/i.test(r.name));
  } else if (isPorch) {
    hostRoom = rooms.find(r => /living|lounge/i.test(r.name))
            || rooms.find(r => /kitchen/i.test(r.name));
  }

  if (!hostRoom) return null;

  // Track which host was used (for multiple balcony support)
  usedHosts.add(hostRoom.name);

  // Porch is ALWAYS at the front (y = -1.5), on the exterior.
  // The host room determines horizontal placement. If the preferred host
  // (living/kitchen) isn't at the front, find any room that is.
  if (isPorch) {
    const TOL = 0.15;
    const atFront = (r: GeneratedRoom) => Math.abs(r.y) < TOL;

    if (!atFront(hostRoom)) {
      // Preferred host isn't at the front — try alternatives.
      // Priority: kitchen/living at front → hallway → any other room.
      // NEVER attach porch to a bedroom.
      const alt = rooms.find(r => atFront(r) && /kitchen/i.test(r.name))
        || rooms.find(r => atFront(r) && /living|lounge/i.test(r.name))
        || rooms.find(r => atFront(r) && /hallway/i.test(r.name))
        || rooms.find(r => atFront(r) && !/porch|balcony|bedroom|ensuite|bathroom/i.test(r.name));
      if (alt) {
        console.log(`[porch] host "${hostRoom.name}" not at front, using "${alt.name}" instead`);
        hostRoom = alt;
      } else {
        console.warn(`[porch] ⚠️ no suitable front room for porch — skipped.`);
        return null;
      }
    }

    const extLen = Math.min(hostRoom.width * 0.6, 3.0);
    return {
      name,
      x: hostRoom.x + (hostRoom.width - extLen) / 2,
      y: -1.5, // absolute front exterior
      width: extLen,
      height: 1.5,
      area: parseFloat((extLen * 1.5).toFixed(1)),
    };
  }

  // Balcony can go on any exterior wall.
  // Validate that the LLM-specified side actually points to an exterior wall;
  // if not (e.g., "back" on a room whose top wall is interior), fall back.
  let extWall: "top" | "bottom" | "left" | "right";
  const candidateWall = mapSideToWall(side);
  if (candidateWall && isExteriorWall(hostRoom, candidateWall, rooms)) {
    extWall = candidateWall;
  } else {
    if (candidateWall) {
      console.log(`[balcony] "${name}" side "${side}" → wall "${candidateWall}" is NOT exterior on "${hostRoom.name}", falling back to auto-detect`);
    }
    extWall = findExteriorWall(hostRoom, rooms);
  }

  const extLen = Math.min(hostRoom.width * 0.6, 3.0);

  switch (extWall) {
    case "bottom":
      return { name, x: hostRoom.x + (hostRoom.width - extLen) / 2, y: hostRoom.y - 1.5, width: extLen, height: 1.5, area: parseFloat((extLen * 1.5).toFixed(1)) };
    case "top":
      return { name, x: hostRoom.x + (hostRoom.width - extLen) / 2, y: hostRoom.y + hostRoom.height, width: extLen, height: 1.5, area: parseFloat((extLen * 1.5).toFixed(1)) };
    case "left":
      return { name, x: hostRoom.x - 1.5, y: hostRoom.y + (hostRoom.height - 2) / 2, width: 1.5, height: 2, area: 3 };
    case "right":
      return { name, x: hostRoom.x + hostRoom.width, y: hostRoom.y + (hostRoom.height - 2) / 2, width: 1.5, height: 2, area: 3 };
    default:
      return { name, x: hostRoom.x + hostRoom.width, y: hostRoom.y + (hostRoom.height - 2) / 2, width: 1.5, height: 2, area: 3 };
  }
}

/** Map a user-facing side name to a wall direction, or null if unrecognized. */
function mapSideToWall(side: string): "top" | "bottom" | "left" | "right" | null {
  if (side === "front" || side === "bottom") return "bottom";
  if (side === "back" || side === "top") return "top";
  if (side === "left") return "left";
  if (side === "right") return "right";
  return null;
}

/** Check whether a given wall of a room is on the building exterior. */
function isExteriorWall(
  room: GeneratedRoom,
  wall: "top" | "bottom" | "left" | "right",
  allRooms: GeneratedRoom[]
): boolean {
  const TOL = 0.15;
  const neighbors = allRooms.filter(r => r !== room && !/porch|balcony/i.test(r.name));

  // Compute building extents from interior rooms
  let maxX = 0, maxY = 0, minX = Infinity, minY = Infinity;
  for (const r of neighbors) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }

  switch (wall) {
    case "bottom": {
      // Must be at building bottom edge AND no room below
      const atPerimeter = Math.abs(room.y - minY) < TOL;
      const hasNeighborBelow = neighbors.some(r => Math.abs(room.y - (r.y + r.height)) < TOL);
      return atPerimeter && !hasNeighborBelow;
    }
    case "top": {
      const atPerimeter = Math.abs(room.y + room.height - maxY) < TOL;
      const hasNeighborAbove = neighbors.some(r => Math.abs(room.y + room.height - r.y) < TOL);
      return atPerimeter && !hasNeighborAbove;
    }
    case "left": {
      const atPerimeter = Math.abs(room.x - minX) < TOL;
      const hasNeighborLeft = neighbors.some(r => Math.abs(room.x - (r.x + r.width)) < TOL);
      return atPerimeter && !hasNeighborLeft;
    }
    case "right": {
      const atPerimeter = Math.abs(room.x + room.width - maxX) < TOL;
      const hasNeighborRight = neighbors.some(r => Math.abs(room.x + room.width - r.x) < TOL);
      return atPerimeter && !hasNeighborRight;
    }
  }
}

/** Find which wall of a room is on the exterior (doesn't touch another room AND is at building perimeter).
 *  Prefers bottom (front) and right walls, then left, then top. */
function findExteriorWall(room: GeneratedRoom, allRooms: GeneratedRoom[]): "top" | "bottom" | "left" | "right" {
  // Try preferred walls first using the robust perimeter check
  if (isExteriorWall(room, "bottom", allRooms)) return "bottom";
  if (isExteriorWall(room, "right", allRooms)) return "right";
  if (isExteriorWall(room, "left", allRooms)) return "left";
  if (isExteriorWall(room, "top", allRooms)) return "top";

  // Fallback: old adjacency-only check (for edge cases)
  const TOL = 0.15;
  const neighbors = allRooms.filter(r => r !== room && !/porch|balcony/i.test(r.name));
  const hasBottomNeighbor = neighbors.some(r => Math.abs(room.y - (r.y + r.height)) < TOL);
  const hasTopNeighbor = neighbors.some(r => Math.abs(room.y + room.height - r.y) < TOL);
  const hasLeftNeighbor = neighbors.some(r => Math.abs(room.x - (r.x + r.width)) < TOL);
  const hasRightNeighbor = neighbors.some(r => Math.abs(room.x + room.width - r.x) < TOL);

  if (!hasBottomNeighbor) return "bottom";
  if (!hasRightNeighbor) return "right";
  if (!hasLeftNeighbor) return "left";
  if (!hasTopNeighbor) return "top";
  return "right"; // absolute last resort
}

/* ------------------------------------------------------------------ */
/*  Furniture bounds checker                                            */
/* ------------------------------------------------------------------ */

/**
 * Check if a placed furniture item fits within its room's actual polygon.
 * Returns true if the furniture is fully contained.
 */
export function isFurnitureInBounds(
  itemX: number, itemY: number,
  itemW: number, itemH: number,
  room: GeneratedRoom
): boolean {
  // If room has a polygon, check against that
  if (room.polygon && room.polygon.length >= 3) {
    return rectInPolygon(
      itemX - itemW / 2, itemY - itemH / 2, itemW, itemH,
      room.polygon
    );
  }
  // Otherwise check against room's bounding rectangle
  return (
    itemX - itemW / 2 >= room.x &&
    itemX + itemW / 2 <= room.x + room.width &&
    itemY - itemH / 2 >= room.y &&
    itemY + itemH / 2 <= room.y + room.height
  );
}

function createExtension(
  name: string,
  side: string,
  rooms: GeneratedRoom[],
  buildingW: number,
  buildingH: number
): GeneratedRoom | null {
  const extW = 1.5;
  const extH = buildingH * 0.15;

  switch (side) {
    case "front": return { name, x: (buildingW - 4) / 2, y: -1.5, width: 4, height: 1.5, area: 6 };
    case "back":  return { name, x: buildingW * 0.3, y: buildingH, width: buildingW * 0.4, height: 1.5, area: buildingW * 0.4 * 1.5 };
    case "left":  return { name, x: -1.5, y: buildingH * 0.4, width: 1.5, height: 2, area: 3 };
    case "right": return { name, x: buildingW, y: buildingH * 0.4, width: 1.5, height: 2, area: 3 };
    default: return null;
  }
}

function generateDoors(rooms: GeneratedRoom[]): Door[] {
  const doors: Door[] = [];
  const hallway = rooms.find(r => /hallway/i.test(r.name));
  const kitchen = rooms.find(r => /kitchen/i.test(r.name));

  for (const room of rooms) {
    if (/hallway|porch|balcony/i.test(room.name)) continue;

    if (/garage/i.test(room.name)) {
      // Vehicle door on an exterior wall (not shared with another room)
      const extWall = findExteriorWall(room, rooms);
      if (extWall) {
        doors.push({ room: room.name, wall: extWall, offset: room.width / 2, width: 2.6, swing: "out" });
      }

      // Internal access door: hallway first (garage always opens into hallway),
      // fall back to kitchen, then any other internal room. NEVER lead outside.
      const internalNeighbors = rooms.filter(r =>
        r !== room &&
        !/porch|balcony/i.test(r.name) &&
        findWallBetween(room, r)
      );
      // Sort: hallway first, kitchen second, others last
      internalNeighbors.sort((a, b) => {
        const score = (r: GeneratedRoom) =>
          /hallway/i.test(r.name) ? 0 : /kitchen/i.test(r.name) ? 1 : 2;
        return score(a) - score(b);
      });

      const internalTarget = internalNeighbors[0] ?? null;
      if (internalTarget) {
        const wall = findWallToHallway(room, internalTarget);
        if (wall) {
          const wallLen = wall === "left" || wall === "right" ? room.height : room.width;
          const offset = Math.max(0.8, wallLen * 0.5);
          doors.push({
            room: room.name,
            wall,
            offset,
            width: 0.9,
            swing: "in",
          });
          // Also create the door from the neighbor side
          doors.push({
            room: internalTarget.name,
            wall: oppositeWall(wall),
            offset: (oppositeWall(wall) === "left" || oppositeWall(wall) === "right"
              ? internalTarget.height : internalTarget.width) * 0.5,
            width: 0.9,
            swing: "in",
          });
          const targetLabel = /kitchen/i.test(internalTarget.name) ? "kitchen"
            : /hallway/i.test(internalTarget.name) ? "hallway" : internalTarget.name;
          console.log(`[generateDoors] garage internal door → ${targetLabel} on wall ${wall}`);
        }
      } else {
        console.warn("[generateDoors] ⚠️ garage has NO internal neighbors — no internal door created.");
      }
      continue;
    }

    // Standard room: door to hallway
    // Ensuite connects to master bedroom, not hallway.
    // The ensuite is carved inside the master, so edges don't touch exactly —
    // we find the interior-facing wall and place the door there.
    if (/ensuite/i.test(room.name)) {
      const master = rooms.find(r => /master/i.test(r.name));
      if (master) {
        // Compute building extents to determine which walls are exterior
        let maxX = 0, maxY = 0;
        for (const r of rooms) {
          if (r.x + r.width > maxX) maxX = r.x + r.width;
          if (r.y + r.height > maxY) maxY = r.y + r.height;
        }
        const EXT_TOL = 0.1;

        // Find an interior wall (not on building perimeter) for the door
        const interiorWalls: Door["wall"][] = [];
        if (!(Math.abs(room.x) < EXT_TOL)) interiorWalls.push("left");
        if (!(Math.abs(room.x + room.width - maxX) < EXT_TOL)) interiorWalls.push("right");
        if (!(Math.abs(room.y) < EXT_TOL)) interiorWalls.push("bottom");
        if (!(Math.abs(room.y + room.height - maxY) < EXT_TOL)) interiorWalls.push("top");

        // Prefer top wall (faces main bedroom area), then any interior wall
        const wall: Door["wall"] | null =
          interiorWalls.includes("top") ? "top" :
          interiorWalls.includes("bottom") ? "bottom" :
          interiorWalls.includes("left") ? "left" :
          interiorWalls.includes("right") ? "right" :
          null;

        if (wall) {
          const wallLen = wall === "left" || wall === "right" ? room.height : room.width;
          const doorWidth = 0.75;
          const doorOffset = Math.max(doorWidth / 2 + 0.15, Math.min(wallLen - doorWidth / 2 - 0.15, wallLen * 0.5));

          doors.push({
            room: room.name,
            wall,
            offset: doorOffset,
            width: doorWidth,
            swing: "in",
          });
          // Note: no master-side door — the ensuite is carved inside the master,
          // so the ensuite door alone shows the access point. A master-side door
          // would be placed on an exterior wall (oppositeWall of an interior wall
          // = exterior), creating a phantom door to the outside.
        }
      }
      continue;
    }

    if (hallway) {
      const wall = findWallToHallway(room, hallway);
      if (wall) {
        const wallLen = wall === "left" || wall === "right" ? room.height : room.width;
        doors.push({
          room: room.name,
          wall,
          offset: Math.max(0.5, wallLen * 0.4),
          width: 0.85,
          swing: "in",
        });
      }
    }
  }

  return doors;
}

/** Check if two rooms share a wall (are adjacent) */
function findWallBetween(roomA: GeneratedRoom, roomB: GeneratedRoom): boolean {
  const TOL = 0.2;
  // Check horizontal adjacency
  if (Math.abs(roomA.x + roomA.width - roomB.x) < TOL ||
      Math.abs(roomB.x + roomB.width - roomA.x) < TOL) {
    // Check Y overlap
    return roomA.y < roomB.y + roomB.height && roomA.y + roomA.height > roomB.y;
  }
  // Check vertical adjacency
  if (Math.abs(roomA.y + roomA.height - roomB.y) < TOL ||
      Math.abs(roomB.y + roomB.height - roomA.y) < TOL) {
    // Check X overlap
    return roomA.x < roomB.x + roomB.width && roomA.x + roomA.width > roomB.x;
  }
  return false;
}

function findWallToHallway(room: GeneratedRoom, neighbor: GeneratedRoom): Door["wall"] | null {
  const TOL = 0.1;
  // room's right edge touches neighbor's left edge → door on room's RIGHT wall
  if (Math.abs(room.x + room.width - neighbor.x) < TOL) return "right";
  // neighbor's right edge touches room's left edge → door on room's LEFT wall
  if (Math.abs(neighbor.x + neighbor.width - room.x) < TOL) return "left";
  // room's TOP edge (y+height) touches neighbor's BOTTOM edge (y)
  // → room is BELOW neighbor → door on room's TOP wall
  if (Math.abs(room.y + room.height - neighbor.y) < TOL) return "top";
  // neighbor's TOP edge (y+height) touches room's BOTTOM edge (y)
  // → room is ABOVE neighbor → door on room's BOTTOM wall
  if (Math.abs(neighbor.y + neighbor.height - room.y) < TOL) return "bottom";
  return null;
}

/** Return the opposite wall direction */
function oppositeWall(wall: Door["wall"]): Door["wall"] {
  switch (wall) {
    case "left": return "right";
    case "right": return "left";
    case "top": return "bottom";
    case "bottom": return "top";
  }
}

function generateWindows(rooms: GeneratedRoom[], buildingW: number, buildingH: number, allDoors: Door[]): Window[] {
  const windows: Window[] = [];
  const TOL = 0.1;
  const WALL_MARGIN = 0.2; // minimum distance from room edge to window edge
  const DOOR_GAP = 0.15;   // minimum gap between door edge and window edge

  for (const room of rooms) {
    if (/hallway|corridor|foyer|garage|porch|balcony/i.test(room.name)) continue;

    // Exterior walls get windows
    const walls: Array<{ wall: Door["wall"]; len: number }> = [];

    if (Math.abs(room.x) < TOL) walls.push({ wall: "left", len: room.height });
    if (Math.abs(room.x + room.width - buildingW) < TOL) walls.push({ wall: "right", len: room.height });
    if (Math.abs(room.y) < TOL) walls.push({ wall: "bottom", len: room.width });
    if (Math.abs(room.y + room.height - buildingH) < TOL) walls.push({ wall: "top", len: room.width });

    for (const { wall, len } of walls) {
      // Collect all doors on this room + wall
      const wallDoors = allDoors
        .filter(d => d.room === room.name && d.wall === wall)
        .sort((a, b) => a.offset - b.offset);

      // Build occupied segments: each door blocks [doorOffset - halfW - gap, doorOffset + halfW + gap]
      interface Segment { start: number; end: number; }
      const occupied: Segment[] = wallDoors.map(d => ({
        start: d.offset - d.width / 2 - DOOR_GAP,
        end: d.offset + d.width / 2 + DOOR_GAP,
      }));

      // Find free segments with at least WALL_MARGIN from edges
      const freeSegments: Segment[] = [];
      let cursor = WALL_MARGIN;
      for (const seg of occupied) {
        if (seg.start > cursor + 0.4) {
          // Gap large enough for a window
          freeSegments.push({ start: cursor, end: Math.min(seg.start, len - WALL_MARGIN) });
        }
        cursor = Math.max(cursor, seg.end);
      }
      // Remaining space after last door
      if (cursor < len - WALL_MARGIN - 0.4) {
        freeSegments.push({ start: cursor, end: len - WALL_MARGIN });
      }

      if (freeSegments.length === 0) continue; // no room for a window

      // Pick the largest free segment
      freeSegments.sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const best = freeSegments[0];
      const availableLen = best.end - best.start;

      let wWidth = Math.min(availableLen * 0.7, 1.8);
      if (wWidth < 0.4) continue;

      // Center the window in the available gap
      let wOffset = best.start + availableLen / 2;

      // ── Clamp window to stay entirely within this room's wall segment ──
      const halfW = wWidth / 2;
      const minOffset = WALL_MARGIN + halfW;
      const maxOffset = len - WALL_MARGIN - halfW;
      wOffset = Math.max(minOffset, Math.min(maxOffset, wOffset));

      // Re-verify window doesn't overlap any door
      const overlapsDoor = wallDoors.some(d =>
        Math.abs(wOffset - d.offset) < halfW + d.width / 2 + DOOR_GAP
      );
      if (overlapsDoor) continue;

      windows.push({
        room: room.name,
        wall,
        offset: wOffset,
        width: wWidth,
      });
    }
  }

  return windows;
}

/**
 * Generate the main entrance door on the front of the house.
 * Priority: living room on front → hallway → any front room.
 * If a porch exists, the door connects to it.
 */
function generateMainEntrance(rooms: GeneratedRoom[]): Door[] {
  const TOL = 0.1;
  const porch = rooms.find(r => /porch/i.test(r.name));

  // Find rooms touching the front (y ≈ 0)
  const frontRooms = rooms.filter(r =>
    !/porch|balcony/i.test(r.name) && Math.abs(r.y) < TOL
  );

  // Priority: living room on front → hallway → first available
  const frontRoom = frontRooms.find(r => /living|lounge|family/i.test(r.name))
    || frontRooms.find(r => /hallway/i.test(r.name))
    || frontRooms[0];

  if (!frontRoom) return [];

  const doorWidth = 1.0;
  // World-x center of the door: align with porch center if present, else room center
  const doorWorldX = porch
    ? porch.x + porch.width / 2
    : frontRoom.x + frontRoom.width / 2;

  // Offset relative to front room's left edge
  const roomOffset = doorWorldX - frontRoom.x;
  const clampedOffset = Math.max(0.6, Math.min(roomOffset, frontRoom.width - 0.6));

  const mainDoor: Door = {
    room: frontRoom.name,
    wall: "bottom",
    offset: clampedOffset,
    width: doorWidth,
    swing: "in",
  };

  console.log("[main-entrance] front door on \"" + frontRoom.name + "\" bottom wall, offset=" + clampedOffset.toFixed(2) + (porch ? " (via porch)" : ""));

  // Only the host-room door is created — the porch is an exterior extension,
  // so a single door on the interior room shows the access point.
  return [mainDoor];
}

/**
 * Generate doors for all balconies connecting to their host rooms.
 * Each balcony gets a door on the shared wall with its host (living room,
 * master bedroom, etc.). Supports multiple balconies.
 */
function generateBalconyDoors(rooms: GeneratedRoom[]): Door[] {
  const doors: Door[] = [];
  const balconies = rooms.filter(r => /balcony/i.test(r.name));

  for (const balcony of balconies) {
    // Find the interior room this balcony is attached to
    const host = rooms.find(r =>
      r !== balcony &&
      !/porch|balcony/i.test(r.name) &&
      findWallToHallway(balcony, r) !== null
    );

    if (!host) {
      console.warn(`[balcony-door] ⚠️ no host room found for "${balcony.name}" — skipping door.`);
      continue;
    }

    const wall = findWallToHallway(balcony, host);
    if (!wall) continue;

    const doorWidth = 0.8;

    // Only the host-room door is created — a single door on the interior room
    // correctly shows the access point to the exterior extension.
    const hostWall = oppositeWall(wall);
    const hostWallLen = hostWall === "left" || hostWall === "right" ? host.height : host.width;
    const hostOffset = Math.max(doorWidth / 2 + 0.15, Math.min(hostWallLen - doorWidth / 2 - 0.15, hostWallLen * 0.5));

    doors.push({
      room: host.name,
      wall: hostWall,
      offset: hostOffset,
      width: doorWidth,
      swing: "in",
    });

    console.log(`[balcony-door] "${host.name}" → "${balcony.name}" on ${hostWall} wall`);
  }

  return doors;
}
