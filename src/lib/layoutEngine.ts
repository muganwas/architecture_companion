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

  // ── Step 0: Generate creative building perimeter (4-8 sided polygon) ──
  const buildingPoly = generateBuildingPolygon(totalArea);

  // Use polygon bounding box as the working rectangle for column layout
  const polyBounds = polygonBounds(buildingPoly);
  const buildingW = polyBounds.w;
  const buildingH = polyBounds.h;

  // Fixed hallway width
  const hallwayWidth = 1.2;

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

  // Step 1: Place hallway within the polygon bounding box
  let hallwayX: number;
  if (hallwaySide === "left") hallwayX = polyBounds.x;
  else if (hallwaySide === "right") hallwayX = polyBounds.x + buildingW - hallwayWidth;
  else hallwayX = polyBounds.x + (buildingW - hallwayWidth) / 2;

  const hallway: GeneratedRoom = {
    name: "Hallway",
    x: hallwayX,
    y: polyBounds.y,
    width: hallwayWidth,
    height: buildingH,
    area: hallwayWidth * buildingH,
  };

  // Step 2: Compute zone boundaries within polygon bounds
  const leftZoneX = polyBounds.x;
  const leftZoneWidth = hallwayX - polyBounds.x;
  const rightZoneX = hallwayX + hallwayWidth;
  const rightZoneWidth = (polyBounds.x + buildingW) - rightZoneX;

  const rooms: GeneratedRoom[] = [hallway];

  // Step 3: Place rooms in columns with balanced proportions
  const minRoomWidth = 2.2; // minimum room width in meters (fits a bed)

  function placeColumnBalanced(
    names: string[],
    x: number,
    colWidth: number,
    startY: number,
    endY: number
  ): number {
    const colRoomNames = names.filter(n => !/hallway|porch|balcony/i.test(n));
    if (colRoomNames.length === 0) return startY;

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
      if (idx === colRoomNames.length - 1) {
        roomH = remainingH;
      } else {
        roomH = Math.min(roomH, remainingH - 1.5);
      }
      roomH = Math.max(roomH, 2.0);

      // Ensure minimum area by adjusting height if needed
      const roomArea = roomW * roomH;
      if (roomArea < minArea) {
        roomH = Math.max(roomH, minArea / roomW);
        if (idx !== colRoomNames.length - 1) {
          roomH = Math.min(roomH, remainingH - 1.5);
        }
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

  // Place left column rooms
  const leftRooms = [
    ...(zones.frontLeft || []),
    ...(zones.leftMiddle || []),
    ...(zones.backLeft || []),
  ];
  if (leftRooms.length > 0 && leftZoneWidth >= minRoomWidth) {
    placeColumnBalanced(leftRooms, leftZoneX, leftZoneWidth, polyBounds.y, polyBounds.y + buildingH);
  }

  // Place right column rooms
  const rightRooms = [
    ...(zones.frontRight || []),
    ...(zones.rightMiddle || []),
    ...(zones.backRight || []),
  ];
  if (rightRooms.length > 0 && rightZoneWidth >= minRoomWidth) {
    placeColumnBalanced(rightRooms, rightZoneX, rightZoneWidth, polyBounds.y, polyBounds.y + buildingH);
  }

  // ── Post-processing: enforce master bedroom dominance ──
  enforceMasterDominance(rooms);

  // Step 4: Building polygon is decorative outline only — do NOT clip rooms.
  // Clipping destroys usable room area and creates gaps between rooms.
  // The polygon is rendered as a subtle dashed outline for visual interest.

  // Step 5: Add exterior extensions (porch, balcony) outside the polygon
  for (const [roomName, side] of Object.entries(exteriorExtensions)) {
    const extRoom = createExtensionOnPolygon(roomName, side, rooms, buildingPoly, polyBounds);
    if (extRoom) rooms.push(extRoom);
  }

  // Step 6: Generate doors & windows
  const doors = generateDoors(rooms);
  const windows = generateWindows(rooms, buildingW, buildingH);

  // Step 7: Apply creative shapes post-processing (interior shapes only)
  applyCreativeShapes(rooms, plan.roomShapes || {}, buildingW, buildingH);

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
function createExtensionOnPolygon(
  name: string,
  side: string,
  rooms: GeneratedRoom[],
  buildingPoly: Array<{ x: number; y: number }>,
  bounds: Bounds
): GeneratedRoom | null {
  const extW = 1.5;
  const extH = bounds.h * 0.15;

  switch (side) {
    case "front": return {
      name, x: bounds.x + (bounds.w - 4) / 2, y: bounds.y - 1.5,
      width: 4, height: 1.5, area: 6,
    };
    case "back": return {
      name, x: bounds.x + bounds.w * 0.3, y: bounds.y + bounds.h,
      width: bounds.w * 0.4, height: 1.5, area: bounds.w * 0.4 * 1.5,
    };
    case "left": return {
      name, x: bounds.x - 1.5, y: bounds.y + bounds.h * 0.4,
      width: 1.5, height: 2, area: 3,
    };
    case "right": return {
      name, x: bounds.x + bounds.w, y: bounds.y + bounds.h * 0.4,
      width: 1.5, height: 2, area: 3,
    };
    default: return null;
  }
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
      // Vehicle door on front wall (bottom = front of house)
      doors.push({ room: room.name, wall: "bottom", offset: room.width / 2, width: 2.6, swing: "out" });

      // Internal access door: find ANY adjacent room and place door on shared wall.
      // Prefer kitchen, then hallway, then any other room.
      const neighbors = rooms.filter(r =>
        r !== room && !/porch|balcony/i.test(r.name) && findWallBetween(room, r)
      );
      // Sort: kitchen first, then hallway, then others
      neighbors.sort((a, b) => {
        const aKit = /kitchen/i.test(a.name) ? 0 : /hallway/i.test(a.name) ? 1 : 2;
        const bKit = /kitchen/i.test(b.name) ? 0 : /hallway/i.test(b.name) ? 1 : 2;
        return aKit - bKit;
      });

      if (neighbors.length > 0) {
        const neighbor = neighbors[0];
        const wall = findWallToHallway(room, neighbor);
        if (wall) {
          const wallLen = wall === "left" || wall === "right" ? room.height : room.width;
          doors.push({
            room: room.name,
            wall: wall,
            offset: Math.max(0.8, wallLen * 0.5),
            width: 0.9,
            swing: "in",
          });
        }
      }
      continue;
    }

    // Standard room: door to hallway
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
  // room's bottom edge touches neighbor's top edge → door on room's BOTTOM wall
  if (Math.abs(room.y + room.height - neighbor.y) < TOL) return "bottom";
  // neighbor's bottom edge touches room's top edge → door on room's TOP wall
  if (Math.abs(neighbor.y + neighbor.height - room.y) < TOL) return "top";
  return null;
}

function generateWindows(rooms: GeneratedRoom[], buildingW: number, buildingH: number): Window[] {
  const windows: Window[] = [];
  const TOL = 0.1;

  for (const room of rooms) {
    if (/hallway|corridor|foyer|garage|porch|balcony/i.test(room.name)) continue;

    // Exterior walls get windows
    const walls: Array<{ wall: Door["wall"]; len: number }> = [];

    if (Math.abs(room.x) < TOL) walls.push({ wall: "left", len: room.height });
    if (Math.abs(room.x + room.width - buildingW) < TOL) walls.push({ wall: "right", len: room.height });
    if (Math.abs(room.y) < TOL) walls.push({ wall: "bottom", len: room.width });
    if (Math.abs(room.y + room.height - buildingH) < TOL) walls.push({ wall: "top", len: room.width });

    for (const { wall, len } of walls) {
      windows.push({
        room: room.name,
        wall,
        offset: len * 0.2,
        width: Math.min(len * 0.5, 1.8),
      });
    }
  }

  return windows;
}
