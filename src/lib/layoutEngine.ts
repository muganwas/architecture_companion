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

  // Fixed hallway width
  const hallwayWidth = 1.2;

  // Choose building aspect ratio
  const aspectRatio = totalArea > 50 ? 1.4 : 1.2;
  const buildingW = Math.sqrt(totalArea * aspectRatio);
  const buildingH = totalArea / buildingW;

  // Normalize ratios to sum to 1.0 (exclude hallway, porch, balcony from ratio calc)
  const interiorRatios: Record<string, number> = {};
  let ratioSum = 0;
  for (const [name, ratio] of Object.entries(roomRatios)) {
    if (/hallway|porch|balcony/i.test(name)) continue;
    interiorRatios[name] = ratio;
    ratioSum += ratio;
  }
  // Normalize
  if (ratioSum > 0) {
    for (const name of Object.keys(interiorRatios)) {
      interiorRatios[name] /= ratioSum;
    }
  }

  // Step 2: Place hallway
  let hallwayX: number;
  if (hallwaySide === "left") hallwayX = 0;
  else if (hallwaySide === "right") hallwayX = buildingW - hallwayWidth;
  else hallwayX = (buildingW - hallwayWidth) / 2; // center

  const hallway: GeneratedRoom = {
    name: "Hallway",
    x: hallwayX,
    y: 0,
    width: hallwayWidth,
    height: buildingH,
    area: hallwayWidth * buildingH,
  };

  // Step 3: Compute zone boundaries
  const leftZoneWidth = hallwayX;
  const rightZoneStart = hallwayX + hallwayWidth;
  const rightZoneWidth = buildingW - rightZoneStart;

  const rooms: GeneratedRoom[] = [hallway];

  // Helper: place rooms vertically in a column
  function placeColumn(
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

    for (const name of colRoomNames) {
      const ratio = (interiorRatios[name] || 0) / colRatioSum;
      const roomH = ratio * colHeight;
      const roomArea = colWidth * roomH;

      rooms.push({
        name,
        x,
        y: currentY,
        width: colWidth,
        height: roomH,
        area: parseFloat(roomArea.toFixed(1)),
      });

      currentY += roomH;
    }

    return currentY;
  }

  // Place left column
  const leftRooms = [
    ...(zones.frontLeft || []),
    ...(zones.leftMiddle || []),
    ...(zones.backLeft || []),
  ];
  if (leftRooms.length > 0) {
    placeColumn(leftRooms, 0, leftZoneWidth, 0, buildingH);
  }

  // Place right column
  const rightRooms = [
    ...(zones.frontRight || []),
    ...(zones.rightMiddle || []),
    ...(zones.backRight || []),
  ];
  if (rightRooms.length > 0) {
    placeColumn(rightRooms, rightZoneStart, rightZoneWidth, 0, buildingH);
  }

  // Step 4: Add exterior extensions (porch, balcony)
  for (const [roomName, side] of Object.entries(exteriorExtensions)) {
    const extRoom = createExtension(roomName, side, rooms, buildingW, buildingH);
    if (extRoom) rooms.push(extRoom);
  }

  // Step 5: Generate doors
  const doors = generateDoors(rooms);

  // Step 6: Generate windows
  const windows = generateWindows(rooms, buildingW, buildingH);

  // Step 7: Apply creative shapes post-processing
  applyCreativeShapes(rooms, plan.roomShapes || {}, buildingW, buildingH);

  return { rooms, doors, windows };
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

  // Kitchens on exterior get bay window
  if (/kitchen/i.test(name) && (Math.abs(room.x) < TOL || Math.abs(room.x + room.width - buildingW) < TOL)) {
    return "bay-window";
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

  for (const room of rooms) {
    if (/hallway|porch|balcony/i.test(room.name)) continue;
    if (/garage/i.test(room.name)) {
      // Garage: vehicle door (front) + internal door
      doors.push({ room: room.name, wall: "bottom", offset: room.width / 2, width: 2.6, swing: "out" });
      if (hallway) {
        doors.push({ room: room.name, wall: "top", offset: 1.5, width: 0.85, swing: "in" });
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

function findWallToHallway(room: GeneratedRoom, hallway: GeneratedRoom): Door["wall"] | null {
  const TOL = 0.1;
  if (Math.abs(room.x + room.width - hallway.x) < TOL) return "right";
  if (Math.abs(hallway.x + hallway.width - room.x) < TOL) return "left";
  if (Math.abs(room.y + room.height - hallway.y) < TOL) return "top";
  if (Math.abs(hallway.y + hallway.height - room.y) < TOL) return "bottom";
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
