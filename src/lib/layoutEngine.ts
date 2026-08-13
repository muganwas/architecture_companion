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
  /** For apartments: building corridor access point and the main entrance it connects to */
  entranceApproach?: { eHallX: number; eHallY: number; doorX: number; doorY: number; wall: Door["wall"] };
}

/* ------------------------------------------------------------------ */
/*  Layout engine                                                      */
/* ------------------------------------------------------------------ */

export interface LayoutOptions {
  /** Whether this is a ground-floor house (true) or apartment/upper-floor (false).
   *  Apartments get their main entrance from the hallway instead of an exterior wall. */
  isGroundFloor?: boolean;
  /** Whether to include a mandatory emergency exit (apartments only). */
  emergencyExit?: boolean;
  /** Kitchen-living room connection type. Default: "open" (wide passage). */
  kitchenLivingConnection?: "open" | "door" | "window" | "separated";
}

export function computeLayout(plan: AbstractPlan, options?: LayoutOptions): LayoutResult {
  let { totalArea } = plan;
  const { hallwaySide, zones, roomRatios, exteriorExtensions } = plan;

  // Determine home type for size capping
  const allZoneNames = Object.values(zones).flat();
  const bedroomCount = allZoneNames.filter(n => /bedroom/i.test(n) && !/master/i.test(n)).length;
  const hasMaster = allZoneNames.some(n => /master/i.test(n));
  const totalBeds = bedroomCount + (hasMaster ? 1 : 0);
  const isStudio = /studio/i.test(allZoneNames.join(" ")) || (totalBeds === 0 && allZoneNames.some(n => /living|lounge/i.test(n)));

  // Studios and small homes: cap max size and set sensible defaults
  if (isStudio) {
    if (totalArea > 40) { console.warn(`Layout engine: studio capped from ${totalArea}m² to 40m²`); totalArea = 40; }
    if (totalArea < 20) totalArea = 25; // cozy default
  } else if (totalBeds === 1) {
    if (totalArea > 60) { console.warn(`Layout engine: 1-bedroom capped from ${totalArea}m² to 60m²`); totalArea = 60; }
    if (totalArea < 35) totalArea = 45; // comfortable default
  } else {
    // 2+ bedrooms: use user-specified area with normal min/max
    if (totalArea < 60) {
      console.warn(`Layout engine: totalArea ${totalArea}m² too small, defaulting to 100m²`);
      totalArea = 100;
    }
  }
  if (totalArea > 500) {
    console.warn(`Layout engine: totalArea ${totalArea}m² too large, capping at 500m²`);
    totalArea = 500;
  }

  // ── Step 0: Compute building dimensions for pleasant proportions ──
  // Goal: aspect ratio between 0.8 and 1.25 (slightly rectangular, never long/thin).
  // For small homes (studio, 1-bed), use a single squarish block.
  // For larger homes, use two columns with a hallway between them.
  const hallwayWidth = 1.2;
  let buildingW: number;
  let buildingH: number;

  // Determine if hallway will be skipped (computed again after isStudio detection)
  const habitableRoomsPre = allZoneNames.filter(n =>
    !/hallway|corridor|porch|balcony|bathroom|ensuite|powder|wc|toilet/i.test(n)
  );
  const willSkipHallway = habitableRoomsPre.length <= 3 || isStudio;

  if (willSkipHallway) {
    // Single-block layout — make it squarish
    const side = Math.sqrt(totalArea);
    // Slightly rectangular is fine (0.85–1.15), never more than 1.4:1
    buildingW = Math.max(4.5, side);
    buildingH = totalArea / buildingW;
    // If too narrow, adjust: swap dimensions for a wider-than-tall layout
    if (buildingW / buildingH > 1.5) {
      // Too wide for height — cap width and let height grow
      buildingW = Math.sqrt(totalArea * 1.15);
      buildingH = totalArea / buildingW;
    }
    // Final safety: ensure neither dimension is absurd
    if (buildingW / buildingH > 1.4) {
      buildingW = Math.sqrt(totalArea * 1.2);
      buildingH = totalArea / buildingW;
    }
    if (buildingH / buildingW > 1.4) {
      buildingH = Math.sqrt(totalArea * 1.2);
      buildingW = totalArea / buildingH;
    }
    // Ensure minimum dimensions
    buildingW = Math.max(buildingW, 4.5);
    buildingH = Math.max(buildingH, 3.0);
  } else {
    // Two-column layout with hallway
    const colWidth = Math.max(5.0, Math.min(8.0, (Math.sqrt(totalArea) - hallwayWidth) / 2));
    buildingW = colWidth * 2 + hallwayWidth;
    buildingH = totalArea / buildingW;
    // Enforce maximum aspect ratio of 1.5:1 for two-column layouts too
    if (buildingW / buildingH > 1.5) {
      buildingW = Math.sqrt(totalArea * 1.3);
      buildingH = totalArea / buildingW;
    }
    if (buildingH / buildingW > 1.5) {
      buildingH = Math.sqrt(totalArea * 1.3);
      buildingW = totalArea / buildingH;
    }
  }

  console.log(`[layout] area=${totalArea}m² building=${buildingW.toFixed(1)}×${buildingH.toFixed(1)}m ratio=${(Math.max(buildingW,buildingH)/Math.min(buildingW,buildingH)).toFixed(2)} ${willSkipHallway ? "compact" : "two-column"}`);

  // For two-column layouts, compute the effective column width
  const colWidth = willSkipHallway ? buildingW : (buildingW - hallwayWidth) / 2;
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

  // Step 1: Determine if this plan needs a hallway.
  // Small homes (studio, 1-bed, compact) don't need corridors — the living
  // room serves as the central circulation space.
  // (allZoneNames, isStudio, and habitableRooms are already computed above)
  const habitableRooms = allZoneNames.filter(n =>
    !/hallway|corridor|porch|balcony|bathroom|ensuite|powder|wc|toilet/i.test(n)
  );
  const skipHallway = habitableRooms.length <= 3 || isStudio;

  if (skipHallway) {
    console.log(`[layout] skipping hallway — ${habitableRooms.length} habitable room(s), ${isStudio ? "studio" : "compact"} layout`);
  }

  // Step 2: Place hallway between the two fixed-width columns (if needed).
  // The hallway is an INTERIOR corridor — it must never be on an exterior wall,
  // especially when balconies are present (balconies need exterior walls).
  let effectiveHallwaySide = hallwaySide;
  const hasBalconies = Object.keys(exteriorExtensions).some(k => /balcony/i.test(k));
  if (hasBalconies && (effectiveHallwaySide === "left" || effectiveHallwaySide === "right")) {
    console.log(`[hallway-balcony] forcing hallway from "${effectiveHallwaySide}" to "center" — balconies need exterior walls`);
    effectiveHallwaySide = "center";
  }

  let hallwayX: number;
  if (effectiveHallwaySide === "left") hallwayX = polyBounds.x;
  else if (effectiveHallwaySide === "right") hallwayX = polyBounds.x + colWidth * 2 + hallwayWidth - hallwayWidth;
  else hallwayX = polyBounds.x + colWidth; // center: between the two columns

  const hallway: GeneratedRoom = {
    name: "Hallway",
    x: skipHallway ? 0 : hallwayX,
    y: polyBounds.y,
    width: skipHallway ? 0 : hallwayWidth,
    height: buildingH,
    area: skipHallway ? 0 : (hallwayWidth * buildingH),
  };

  // Step 3: Fixed column zones — rooms span full column width, touching hallway.
  // Without a hallway, use a single full-width column.
  const leftZoneX = polyBounds.x;
  const leftZoneWidth = skipHallway ? buildingW : colWidth;
  const rightZoneX = polyBounds.x + colWidth + hallwayWidth;
  const rightZoneWidth = colWidth;

  const rooms: GeneratedRoom[] = [];
  if (!skipHallway) rooms.push(hallway);

  // Step 3: Place rooms in columns with balanced proportions
  const minRoomWidth = 2.2; // minimum room width in meters (fits a bed)

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

      // Bathrooms, ensuites, and utility rooms keep a natural capped width
      // for realistic proportions — not all rooms need to span the full column.
      if (/bathroom|ensuite|powder|wc|laundry/i.test(name)) {
        roomW = Math.min(colWidth, 3.0);
      }

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
      const minArea = getMinRoomArea(name, totalArea);
      const minW = getMinRoomWidth(name);
      roomW = Math.max(roomW, minW, minRoomWidth);
      roomH = Math.max(roomH, 2.0);

      // Don't exceed column bounds
      const remainingH = endY - currentY;
      const isLast = idx === colRoomNames.length - 1;
      if (isLast) {
        // Last room: take remaining space, but cap at its max area
        const maxArea = getMaxRoomArea(name, totalArea);
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
      const maxArea = getMaxRoomArea(name, totalArea);
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

  // ── Balance columns: ensure rooms are distributed across both sides ──
  // Only skip for hub-and-spoke (living room as central hub).
  // Studios still need balancing to distribute rooms properly.
  const allRoomNamesPre = Object.values(zones).flat().filter(n => !/porch|balcony/i.test(n));
  const isHubPre = skipHallway && !isStudio && allRoomNamesPre.some(n => /living|lounge|family/i.test(n)) && allRoomNamesPre.length >= 3;
  if (!isHubPre) balanceColumns(zones);

  // Determine if this is a hub-and-spoke layout: small home (no hallway, not studio)
  // where the living room serves as the central circulation space.
  const allRoomNames = Object.values(zones).flat().filter(n => !/porch|balcony/i.test(n));
  const hasLivingRoom = allRoomNames.some(n => /living|lounge|family/i.test(n));
  const useHubAndSpoke = skipHallway && !isStudio && hasLivingRoom && allRoomNames.length >= 3;

  if (useHubAndSpoke) {
    console.log(`[layout] hub-and-spoke — living room as central hub for ${allRoomNames.length} rooms`);
    placeHubAndSpoke(rooms, zones, interiorRatios, totalArea, buildingW, buildingH);
  } else {
  // ── Merge kitchen zones into living room (hub-and-spoke only) ──
  // Studios already handle kitchens in the furniture placer.
  if (useHubAndSpoke) {
    for (const zoneKey of Object.keys(zones)) {
      const arr = (zones as Record<string, string[]>)[zoneKey];
      if (!arr) continue;
      for (let i = arr.length - 1; i >= 0; i--) {
        const lower = arr[i].toLowerCase();
        const isKitchenZone = /kitchen|cooking|kitchenette/i.test(lower);
        if (isKitchenZone) {
          // Find living room to merge into
          const livingName = arr.find(n => /living|lounge|family/i.test(n))
            || Object.values(zones).flat().find(n => /living|lounge|family/i.test(n));
          if (livingName) {
            interiorRatios[livingName] = (interiorRatios[livingName] || 0) + (interiorRatios[arr[i]] || 0);
          }
          arr.splice(i, 1);
        }
      }
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

  // ── Post-process: merge split columns in compact (no-hallway) layouts ──
  // When skipHallway is true and rooms end up on BOTH sides, they form two
  // disconnected building blocks. Shift right-column rooms into the left
  // column so the floor plan is one contiguous building.
  if (skipHallway && leftRooms.length > 0 && rightRooms.length > 0) {
    const leftRoomNames = new Set(leftRooms.map(n => n.toLowerCase()));
    for (const room of rooms) {
      if (leftRoomNames.has(room.name.toLowerCase())) continue;
      room.x = polyBounds.x;
      room.width = buildingW;
    }
  }

  // ── Cap hallway height to the tallest column ── (no wasted hallway past last room)
  const maxEndY = Math.max(leftEndY, rightEndY);
  hallway.height = maxEndY - polyBounds.y;
  hallway.area = parseFloat((hallway.width * hallway.height).toFixed(1));

  // ── Post-processing: enforce master bedroom dominance FIRST ──
  // Must run before zero-gap so any space freed by capping non-master bedrooms
  // gets redistributed to fill the column.
  enforceMasterDominance(rooms);

  // ── Post-processing: enforce zero-gap adjacency ──
  // Every column room must span full column width and stack flush.
  // Use maxEndY (tallest column) for both sides so the shorter column
  // stretches its rooms to fill the hallway height — no dead space.
  enforceZeroGapAdjacency(rooms, leftZoneX, leftZoneWidth, polyBounds.y, maxEndY, totalArea);
  enforceZeroGapAdjacency(rooms, rightZoneX, rightZoneWidth, polyBounds.y, maxEndY, totalArea);

  } // end else (column layout)

  // ── Post-processing: carve ensuite from master bedroom ──
  // Only carve if the LLM's abstract plan explicitly includes an Ensuite.
  carveEnsuiteFromMaster(rooms, hallway, zones);

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

  // Step 6: Generate main entrance first, so the bathroom can avoid it.
  const isGroundFloor = options?.isGroundFloor ?? true;
  if (!isGroundFloor) {
    hallway.displayLabel = "I.Hallway";
  }
  const mainEntranceDoors = generateMainEntrance(rooms, isGroundFloor);

  // ── Post-processing: carve bathroom from studio room ──
  // Runs AFTER balcony + entrance are placed so it can see actual positions
  // and avoid blocking the entrance door or balcony door.
  carveBathroomFromStudio(rooms, zones, mainEntranceDoors);

  // Step 7: Generate remaining doors (internal, balcony, emergency)
  const mainEntranceWalls = new Set(mainEntranceDoors.map(d => `${d.room}:${d.wall}`));
  const doors = generateDoors(rooms, mainEntranceWalls, options?.kitchenLivingConnection);
  for (const d of mainEntranceDoors) doors.push(d);
  const balconyDoors = generateBalconyDoors(rooms);
  for (const d of balconyDoors) doors.push(d);
  // Emergency exit for apartments (if requested)
  if (!isGroundFloor && options?.emergencyExit) {
    const emergencyDoors = generateEmergencyExit(rooms);
    for (const d of emergencyDoors) doors.push(d);
  }

  // ── Post-check: ensure main entrance and balcony doors don't overlap ──
  resolveDoorConflicts(doors, rooms, mainEntranceDoors, balconyDoors);

  const windows = generateWindows(rooms, buildingW, buildingH, doors);

  // Step 7: Apply creative shapes post-processing (interior shapes only)
  applyCreativeShapes(rooms, plan.roomShapes || {}, buildingW, buildingH);

  // Build perimeter polygon that traces actual room edges (L-shape, T-shape, etc.)
  // rather than a simple bounding rectangle that includes empty gaps.
  const buildingPoly = traceBuildingOutline(rooms);

  return { rooms, doors, windows, buildingPolygon: buildingPoly,
    entranceApproach: computeEntranceApproach(rooms, mainEntranceDoors, isGroundFloor),
  };
}

/* ------------------------------------------------------------------ */
/*  Creative shape post-processing                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Hub-and-spoke layout — living room as central circulation space   */
/* ------------------------------------------------------------------ */

/**
 * For small homes (1-bed, no hallway), place the living room centrally
 * and arrange other rooms around it. All rooms connect through the living
 * room — no corridor needed. Building shape follows room arrangement.
 */
function placeHubAndSpoke(
  rooms: GeneratedRoom[],
  zones: AbstractPlan["zones"],
  ratios: Record<string, number>,
  totalArea: number,
  buildingW: number,
  buildingH: number
): void {
  const allNames = Object.values(zones).flat().filter(n => !/porch|balcony/i.test(n));
  const livingName = allNames.find(n => /living|lounge|family/i.test(n)) || allNames[0];

  // In hub-and-spoke layouts, ALL kitchens are open-plan zones within
  // the living room — regardless of exact name. The AI may normalize
  // "cooking area" → "Kitchen", so name-based heuristics are unreliable.
  const kitchenZoneNames = allNames.filter(n =>
    /kitchen|cooking|kitchenette/i.test(n)
  );
  for (const kn of kitchenZoneNames) {
    ratios[livingName] = (ratios[livingName] || 0) + (ratios[kn] || 0);
  }
  const otherNames = allNames.filter(n => n !== livingName && !kitchenZoneNames.includes(n));

  // ── Living room: central square (includes kitchen zone) ──
  const liveRatio = ratios[livingName] || 0.35;
  const otherRatioSum = otherNames.reduce((s, n) => s + (ratios[n] || 0), 0);
  const totalRatio = liveRatio + otherRatioSum;
  const liveFrac = totalRatio > 0 ? liveRatio / totalRatio : 0.4;

  // Living room gets a squarish shape in the center
  const liveArea = totalArea * liveFrac;
  const liveSide = Math.sqrt(liveArea);
  const liveW = Math.max(3.5, Math.min(liveSide * 1.2, buildingW * 0.7));
  const liveH = Math.max(3.0, liveArea / liveW);

  // Center the living room
  const liveX = (buildingW - liveW) / 2;
  const liveY = (buildingH - liveH) / 2;

  rooms.push({
    name: livingName,
    x: parseFloat(liveX.toFixed(2)),
    y: parseFloat(liveY.toFixed(2)),
    width: parseFloat(liveW.toFixed(2)),
    height: parseFloat(liveH.toFixed(2)),
    area: parseFloat((liveW * liveH).toFixed(1)),
    hasKitchenZone: kitchenZoneNames.length > 0,
  });

  if (otherNames.length === 0) return;

  // ── Place other rooms around the living room ──
  // Reserve the bottom/front side for the main entrance.
  // Assign rooms to left, right, top only (bottom stays open for exterior access).
  const sides: Array<{ wall: "left" | "right" | "top" | "bottom"; name: string }> = [];
  const usedSides = new Set<string>();

  for (const name of otherNames) {
    const n = name.toLowerCase();
    let preferred: string[];
    if (/bedroom|master/i.test(n)) {
      preferred = ["left", "top"];
    } else if (/kitchen|cooking|kitchenette/i.test(n)) {
      preferred = ["right", "top"];
    } else if (/bathroom|ensuite|wc|toilet|powder/i.test(n)) {
      preferred = ["top", "right"];
    } else {
      preferred = ["left", "right", "top"];
    }

    let assigned = false;
    for (const wall of preferred) {
      if (!usedSides.has(wall)) {
        sides.push({ wall: wall as "left" | "right" | "top" | "bottom", name });
        usedSides.add(wall);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      // All preferred sides taken — pick any free side
      for (const wall of ["left", "right", "top", "bottom"]) {
        if (!usedSides.has(wall)) {
          sides.push({ wall: wall as "left" | "right" | "top" | "bottom", name });
          usedSides.add(wall);
          break;
        }
      }
    }
  }

  // Compute dimensions for each side room
  for (const { wall, name } of sides) {
    const ratio = ratios[name] || (1 / (otherNames.length + 1));
    const roomArea = totalArea * (ratio / totalRatio);
    const maxDepth = wall === "left" || wall === "right"
      ? (buildingW - liveW) / 2 - 0.1
      : (buildingH - liveH) / 2 - 0.1;

    let rw: number, rh: number, rx: number, ry: number;

    if (wall === "left") {
      rw = Math.max(2.5, Math.min(roomArea / liveH, maxDepth));
      rh = liveH;
      rx = liveX - rw;
      ry = liveY;
    } else if (wall === "right") {
      rw = Math.max(2.5, Math.min(roomArea / liveH, maxDepth));
      rh = liveH;
      rx = liveX + liveW;
      ry = liveY;
    } else if (wall === "top") {
      // Room ABOVE living room: room's bottom = living room's top
      rw = liveW;
      rh = Math.max(2.5, Math.min(roomArea / liveW, maxDepth));
      rx = liveX;
      ry = liveY + liveH;
    } else {
      // Room BELOW living room (front): room's top = living room's bottom
      rw = liveW;
      rh = Math.max(2.5, Math.min(roomArea / liveW, maxDepth));
      rx = liveX;
      ry = liveY - rh;
    }

    // Enforce balanced proportions: max 2:1 aspect ratio
    if (rw > rh * 2) rw = rh * 2;
    if (rh > rw * 2) rh = rw * 2;

    // Ensure minimum area
    const minArea = getMinRoomArea(name, totalArea);
    if (rw * rh < minArea) {
      if (wall === "left" || wall === "right") {
        rw = Math.max(rw, minArea / rh);
      } else {
        rh = Math.max(rh, minArea / rw);
      }
    }

    // Cap bathroom to a reasonable size — bathrooms don't need to span
    // the full living room wall. Use typical bathroom proportions.
    if (/bathroom|ensuite|wc|toilet|powder/i.test(name)) {
      const maxBathArea = Math.min(7, totalArea * 0.08);
      const currentArea = rw * rh;
      if (currentArea > maxBathArea) {
        const isVertical = wall === "left" || wall === "right";
        // Typical bathroom: ~2m along wall × ~2.5m deep
        if (isVertical) {
          rh = Math.min(rh, 3.0);
          rw = Math.max(2.0, maxBathArea / rh);
          // Corner-align: flush with bottom of living room
          ry = liveY;
        } else {
          rw = Math.min(rw, 3.0);
          rh = Math.max(2.0, maxBathArea / rw);
        }
      }
    }

    rooms.push({
      name,
      x: parseFloat(rx.toFixed(2)),
      y: parseFloat(ry.toFixed(2)),
      width: parseFloat(rw.toFixed(2)),
      height: parseFloat(rh.toFixed(2)),
      area: parseFloat((rw * rh).toFixed(1)),
    });
  }

  // Shift all rooms so the minimum x/y is 0
  const minX = Math.min(...rooms.map(r => r.x));
  const minY = Math.min(...rooms.map(r => r.y));
  if (minX < 0) for (const r of rooms) r.x = parseFloat((r.x - minX).toFixed(2));
  if (minY < 0) for (const r of rooms) r.y = parseFloat((r.y - minY).toFixed(2));
}

/**
 * Trace the building outline by following actual room exterior edges.
 * Produces L-shapes, T-shapes, etc. instead of a bounding rectangle.
 */
function traceBuildingOutline(rooms: GeneratedRoom[]): Array<{ x: number; y: number }> {
  const TOL = 0.1;
  const interior = rooms.filter(r => !/porch|balcony/i.test(r.name));
  if (interior.length === 0) return [];

  // Collect all exterior edges as segments
  interface Edge { x1: number; y1: number; x2: number; y2: number; }
  const edges: Edge[] = [];

  for (const room of interior) {
    const x = room.x, y = room.y, w = room.width, h = room.height;
    const walls = [
      { x1: x, y1: y, x2: x + w, y2: y },           // bottom
      { x1: x + w, y1: y, x2: x + w, y2: y + h },     // right
      { x1: x, y1: y + h, x2: x + w, y2: y + h },     // top
      { x1: x, y1: y, x2: x, y2: y + h },             // left
    ];

    for (const edge of walls) {
      // Check if this edge is shared with another room (segment overlap)
      const isShared = interior.some(other => {
        if (other === room) return false;
        const ox = other.x, oy = other.y, ow = other.width, oh = other.height;
        const isH = Math.abs(edge.y1 - edge.y2) < TOL;
        if (isH) {
          // Horizontal: same Y and X ranges overlap
          const onBottom = Math.abs(edge.y1 - oy) < TOL;
          const onTop = Math.abs(edge.y1 - (oy + oh)) < TOL;
          if (!onBottom && !onTop) return false;
          const eMin = Math.min(edge.x1, edge.x2), eMax = Math.max(edge.x1, edge.x2);
          const oMin = ox, oMax = ox + ow;
          return eMax > oMin + TOL && oMax > eMin + TOL;
        } else {
          // Vertical: same X and Y ranges overlap
          const onLeft = Math.abs(edge.x1 - ox) < TOL;
          const onRight = Math.abs(edge.x1 - (ox + ow)) < TOL;
          if (!onLeft && !onRight) return false;
          const eMin = Math.min(edge.y1, edge.y2), eMax = Math.max(edge.y1, edge.y2);
          const oMin = oy, oMax = oy + oh;
          return eMax > oMin + TOL && oMax > eMin + TOL;
        }
      });

      if (!isShared) {
        edges.push(edge);
      }
    }
  }

  // Chain edges into a continuous polygon
  if (edges.length === 0) return [];

  const poly: Array<{ x: number; y: number }> = [];
  const used = new Set<number>();

  // Start with the leftmost-bottommost point
  const current = edges[0];
  poly.push({ x: current.x1, y: current.y1 });
  used.add(0);
  let cx = current.x2, cy = current.y2;

  while (used.size < edges.length) {
    let found = false;
    for (let i = 0; i < edges.length; i++) {
      if (used.has(i)) continue;
      const e = edges[i];
      if (Math.abs(e.x1 - cx) < TOL && Math.abs(e.y1 - cy) < TOL) {
        poly.push({ x: cx, y: cy });
        cx = e.x2; cy = e.y2;
        used.add(i);
        found = true;
        break;
      }
      if (Math.abs(e.x2 - cx) < TOL && Math.abs(e.y2 - cy) < TOL) {
        poly.push({ x: cx, y: cy });
        cx = e.x1; cy = e.y1;
        used.add(i);
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  poly.push({ x: cx, y: cy });

  return poly.length >= 3 ? poly : [];
}

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

  for (const room of rooms) {
    // Skip hallway, extensions, very small rooms
    if (/hallway|corridor|foyer|porch|balcony/i.test(room.name)) continue;
    if (room.width < 2 || room.height < 2 || room.area < 6) continue;

    const hint = shapeHints[room.name.toLowerCase()];

    // Determine shape based on hint or room characteristics
    const shape = hint || inferShape(room);

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
  room: GeneratedRoom
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

/** Get minimum area (m²) for a room type — scales with total building area */
function getMinRoomArea(name: string, totalArea?: number): number {
  const n = name.toLowerCase();

  // Ratio-based floor: room should be at least X% of total area
  if (/garage/i.test(n)) return Math.max(14, totalArea ? totalArea * 0.10 : 14);
  if (/living|lounge|family/i.test(n)) return Math.max(14, totalArea ? totalArea * 0.12 : 14);
  if (/master/i.test(n)) return Math.max(12, totalArea ? totalArea * 0.09 : 12);
  if (/bedroom/i.test(n)) return Math.max(9, totalArea ? totalArea * 0.07 : 9);
  if (/kitchen|cooking|kitchenette/i.test(n)) return Math.max(8, totalArea ? totalArea * 0.06 : 8);
  if (/dining/i.test(n)) return Math.max(8, totalArea ? totalArea * 0.06 : 8);
  if (/bathroom|ensuite/i.test(n)) return Math.max(7, totalArea ? totalArea * 0.07 : 7);
  if (/office|study/i.test(n)) return Math.max(7, totalArea ? totalArea * 0.05 : 7);
  if (/laundry/i.test(n)) return Math.max(4, totalArea ? totalArea * 0.03 : 4);
  return Math.max(4, totalArea ? totalArea * 0.03 : 4);
}

/** Get minimum width (m) for a room type */
function getMinRoomWidth(name: string): number {
  const n = name.toLowerCase();
  if (/garage/i.test(n)) return 3.0;
  if (/living|lounge|family/i.test(n)) return 3.0;
  if (/master|bedroom/i.test(n)) return 2.5;
  if (/kitchen|cooking|kitchenette/i.test(n)) return 2.0;
  if (/dining/i.test(n)) return 2.2;
  if (/bathroom|ensuite/i.test(n)) return 1.5;
  return 2.0;
}

/** Get maximum area (m²) for a room type — only bathrooms/ensuites/laundry are capped.
 *  Living spaces grow freely with total area via the LLM's ratios. */
function getMaxRoomArea(name: string, totalArea: number): number {
  const n = name.toLowerCase();
  const scale = Math.max(totalArea / 150, 0.7);

  // Only cap sanitary/utility rooms — living spaces fill available area
  if (/ensuite/i.test(n)) return Math.round(10 * scale);
  if (/bathroom/i.test(n)) return Math.round(24 * scale);
  if (/laundry/i.test(n)) return Math.round(10 * scale);   // was 6 — raised 67%

  // Everything else: no hard cap — ratios determine size
  return 999;
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
  colEndY: number,
  totalArea: number
): void {
  const TOL = 0.1;

  // Find rooms in this column (exclude hallway, extensions)
  const colRooms = rooms
    .filter(r => !/hallway|porch|balcony|ensuite/i.test(r.name) && Math.abs(r.x - colX) < colWidth)
    .sort((a, b) => a.y - b.y); // top to bottom

  if (colRooms.length === 0) return;

  // Fix widths: every room spans full column width, flush to hallway side.
  // Bathrooms, ensuites, powder rooms, WC, and laundry keep a natural capped
  // width (≤2.5m) for realistic proportions — houses aren't uniform boxes.
  for (const room of colRooms) {
    if (/bathroom|ensuite|powder|wc|laundry/i.test(room.name)) continue;
    room.x = colX;
    room.width = colWidth;
    room.area = parseFloat((room.width * room.height).toFixed(1));
  }

  // ── Enforce max area caps: trim any room that exceeds its max ──
  let trimmedTotal = 0;
  for (const room of colRooms) {
    const maxArea = getMaxRoomArea(room.name, totalArea);
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
    // Sort by priority: bathrooms/ensuites below functional minimum (5.5m²) first,
    // then by headroom (rooms furthest from max cap get more).
    const FUNC_MIN_BATH = 7; // minimum to fit toilet + sink + shower/tub comfortably
    const eligible = colRooms.map(r => {
      const maxArea = getMaxRoomArea(r.name, totalArea);
      const currentArea = r.width * r.height;
      const headroom = Math.max(0, maxArea - currentArea);
      const isBath = /bathroom|ensuite|powder|wc/i.test(r.name);
      const belowFuncMin = isBath && currentArea < FUNC_MIN_BATH ? 1 : 0;
      return { room: r, headroom, belowFuncMin };
    }).filter(e => e.headroom > 0.1);

    // Sort: bathrooms below functional min first, then by headroom (descending)
    eligible.sort((a, b) => {
      if (a.belowFuncMin !== b.belowFuncMin) return b.belowFuncMin - a.belowFuncMin;
      return b.headroom - a.headroom;
    });

    if (eligible.length > 0) {
      let remaining = excess;
      // First pass: bring bathrooms up to functional minimum
      for (const e of eligible) {
        if (!e.belowFuncMin) continue;
        const deficit = FUNC_MIN_BATH - (e.room.width * e.room.height);
        const neededH = deficit / e.room.width;
        const give = Math.min(neededH, remaining);
        if (give > 0.01) {
          e.room.height = parseFloat((e.room.height + give).toFixed(2));
          e.room.area = parseFloat((e.room.width * e.room.height).toFixed(1));
          remaining -= give * e.room.width;
          e.belowFuncMin = 0;
        }
      }
      // Second pass: capped rooms (bathrooms, laundry) get full headroom,
      // EXCEPT the top room — it gets ALL remaining space to reach the
      // building edge (critical for top-wall windows).
      const topRoom = colRooms[colRooms.length - 1];
      const topIsCapped = eligible.some(e => e.room === topRoom && getMaxRoomArea(e.room.name, totalArea) < 999);
      if (remaining > 0.01) {
        for (const e of eligible) {
          const maxArea = getMaxRoomArea(e.room.name, totalArea);
          if (maxArea >= 999) continue; // uncapped — handle later
          if (e.room === topRoom && topIsCapped) continue; // top room gets fourth pass
          const currentArea = e.room.width * e.room.height;
          const hr = Math.max(0, maxArea - currentArea);
          if (hr < 0.1) continue;
          const neededH = hr / e.room.width;
          const give = Math.min(neededH, remaining);
          if (give > 0.01) {
            e.room.height = parseFloat((e.room.height + give).toFixed(2));
            e.room.area = parseFloat((e.room.width * e.room.height).toFixed(1));
            remaining -= give * e.room.width;
          }
        }
      }
      // Third pass: distribute whatever's left among uncapped rooms proportionally
      if (remaining > 0.01) {
        const uncapped = eligible.filter(e => {
          const maxArea = getMaxRoomArea(e.room.name, totalArea);
          return maxArea >= 999;
        });
        const totalUncappedHeadroom = uncapped.reduce((s, e) => {
          const maxArea = getMaxRoomArea(e.room.name, totalArea);
          const currentArea = e.room.width * e.room.height;
          return s + Math.max(0, maxArea - currentArea);
        }, 0);
        if (totalUncappedHeadroom > 0.1) {
          for (const e of uncapped) {
            const currentArea = e.room.width * e.room.height;
            const hr = Math.max(0, 999 - currentArea);
            if (hr < 0.1) continue;
            const share = Math.min(remaining * (hr / totalUncappedHeadroom), hr / e.room.width);
            if (share > 0.01) {
              e.room.height = parseFloat((e.room.height + share).toFixed(2));
              e.room.area = parseFloat((e.room.width * e.room.height).toFixed(1));
              remaining -= share * e.room.width;
            }
          }
        }
      }
      // Fourth pass: TOP room (often a bathroom) fills ALL remaining space
      // to the building edge, overriding any max area cap. This ensures
      // its top wall IS the building exterior so it gets a window.
      if (remaining > 0.01 && topRoom) {
        topRoom.height = parseFloat((topRoom.height + remaining / topRoom.width).toFixed(2));
        topRoom.area = parseFloat((topRoom.width * topRoom.height).toFixed(1));
        remaining = 0;
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
 * Balance room distribution across the left and right columns.
 * Triggers when one column is empty (0 vs 2+) OR when one column has
 * only 1 room while the other has 3+ (e.g., bathroom stranded alone).
 */
function balanceColumns(
  zones: Record<string, string[]>
): void {
  const leftZones = ["frontLeft", "leftMiddle", "backLeft"];
  const rightZones = ["frontRight", "rightMiddle", "backRight"];
  const zoneMap: Record<string, string> = {
    frontRight: "frontLeft", rightMiddle: "leftMiddle", backRight: "backLeft",
    frontLeft: "frontRight", leftMiddle: "rightMiddle", backLeft: "backRight",
  };

  const isNotExtension = (n: string) => !/porch|balcony/i.test(n);

  const leftRooms = leftZones.flatMap(k => (zones[k] || []).filter(isNotExtension));
  const rightRooms = rightZones.flatMap(k => (zones[k] || []).filter(isNotExtension));

  // Balance when one column has 2+ fewer rooms than the other.
  // E.g. 3 vs 1, 4 vs 2, 3 vs 0 — prevents lopsided layouts where
  // one side is underfilled while the other has crowding.
  const needsBalance = leftRooms.length <= rightRooms.length - 2
                    || rightRooms.length <= leftRooms.length - 2;

  if (!needsBalance) return;

  // Move from fuller → sparser side. Move 1 room for lone-side case, half for empty-side.
  const fromRight = rightRooms.length > leftRooms.length;
  const moveCount = Math.min(
    fromRight ? rightRooms.length - 1 : leftRooms.length - 1, // leave at least 1
    Math.max(1, Math.floor(Math.max(leftRooms.length, rightRooms.length) / 2))
  );

  const fromZoneNames = fromRight ? [...rightZones].reverse() : [...leftZones].reverse();

  // Collect rooms to move, tracking their source zone
  const toMove: Array<{ name: string; fromZone: string }> = [];
  for (const k of fromZoneNames) {
    const arr = zones[k];
    if (!arr) continue;
    for (let i = arr.length - 1; i >= 0 && toMove.length < moveCount; i--) {
      if (isNotExtension(arr[i]) && !/garage/i.test(arr[i])) {
        toMove.push({ name: arr[i], fromZone: k });
        arr.splice(i, 1);
      }
    }
  }

  // Place moved rooms in corresponding zones on the target side
  for (const { name, fromZone } of toMove) {
    const destKey = zoneMap[fromZone];
    if (!destKey) continue;
    if (!zones[destKey]) zones[destKey] = [];
    zones[destKey]!.push(name);
  }

  console.log(`[balance] moved ${toMove.length} rooms from ${fromRight ? "right" : "left"} → ${fromRight ? "left" : "right"} column (${Math.max(leftRooms.length, rightRooms.length)} vs ${Math.min(leftRooms.length, rightRooms.length)})`);
}

/**
 * Ensure the master bedroom is the largest bedroom in the house.
 * Instead of shrinking non-master bedrooms (which creates gaps),
 * grow the master to be at least 10% larger than any competitor.
 */
function enforceMasterDominance(rooms: GeneratedRoom[]): void {
  const master = rooms.find(r => /master/i.test(r.name));
  if (!master) return;

  let largestNonMaster = 0;
  for (const room of rooms) {
    if (room === master) continue;
    if (!/bedroom/i.test(room.name)) continue;
    if (/bathroom/i.test(room.name)) continue;
    if (room.area > largestNonMaster) largestNonMaster = room.area;
  }

  // If a non-master is larger, grow the master to be 10% bigger
  if (largestNonMaster > master.area) {
    const targetArea = largestNonMaster * 1.1;
    master.height = parseFloat((targetArea / master.width).toFixed(2));
    master.area = parseFloat(targetArea.toFixed(1));
    console.log(`[master-dominance] grew master to ${master.area.toFixed(1)}m² (was smaller than ${largestNonMaster.toFixed(1)}m² non-master)`);
  }
}

/**
 * Place ensuite INSIDE the master bedroom — a sub-room within master's boundaries.
 * The master keeps its full area; the ensuite is a private bathroom in one corner.
 */
function carveEnsuiteFromMaster(
  rooms: GeneratedRoom[],
  hallway: GeneratedRoom,
  zones?: Record<string, string[]>
): void {
  const master = rooms.find(r => /master/i.test(r.name));
  if (!master) return;

  // Don't carve if there's already an ensuite in the rooms
  if (rooms.some(r => /ensuite/i.test(r.name))) return;

  // Only carve if the LLM's abstract plan explicitly included "Ensuite" in a zone
  // AND there are 2+ bathrooms total. A single bathroom must be hallway-accessible.
  if (zones) {
    const allZoneNames = Object.values(zones).flat().filter(Boolean) as string[];
    const hasEnsuiteInPlan = allZoneNames.some((n) => /ensuite/i.test(n));
    const bathCount = allZoneNames.filter((n) => /bathroom|ensuite|powder|wc/i.test(n)).length;
    if (!hasEnsuiteInPlan || bathCount < 2) return;
  }

  // ── Minimum functional ensuite: must fit toilet, sink, and shower ──
  const MIN_ENSUITE_AREA = 5.5;  // m² — toilet (0.45×0.7) + sink (0.6×0.5) + shower (0.9×0.9) + circulation
  const MIN_ENSUITE_W = 1.8;     // m
  const MIN_ENSUITE_H = 2.5;     // m

  // Master must have enough room for a bed (3m² min) plus the ensuite
  const bedZoneH = 2.0; // minimum height along the opposite wall for a bed
  if (master.height < MIN_ENSUITE_H + bedZoneH || master.width < MIN_ENSUITE_W + 0.5) {
    console.warn(`[ensuite] ⚠️ master (${master.width.toFixed(1)}×${master.height.toFixed(1)}m) too small for functional ensuite — skipping.`);
    return;
  }

  // Scale ensuite proportionally to master size. Minimum ensures all fixtures fit.
  const ensuiteArea = Math.max(MIN_ENSUITE_AREA, master.area * 0.15);
  const maxWidth = master.width * 0.45;
  const ensuiteW = Math.min(maxWidth, Math.max(MIN_ENSUITE_W, Math.sqrt(ensuiteArea * 0.75)));
  const ensuiteH = Math.max(MIN_ENSUITE_H, ensuiteArea / ensuiteW);

  // Final safety: ensuite must fit inside master leaving room for the bed
  if (ensuiteH > master.height - bedZoneH || ensuiteW > master.width - 0.5) {
    // Try the minimum functional size as a last resort
    if (MIN_ENSUITE_H <= master.height - bedZoneH && MIN_ENSUITE_W <= master.width - 0.5) {
      console.log(`[ensuite] scaled size (${ensuiteW.toFixed(1)}×${ensuiteH.toFixed(1)}m) doesn't fit — using minimum functional ${MIN_ENSUITE_W}×${MIN_ENSUITE_H}m`);
    } else {
      console.warn(`[ensuite] ⚠️ even minimum functional ensuite (${MIN_ENSUITE_W}×${MIN_ENSUITE_H}m) won't fit in master (${master.width.toFixed(1)}×${master.height.toFixed(1)}m) — skipping.`);
      return;
    }
  }

  const finalW = Math.min(ensuiteW, master.width - 0.5);
  const finalH = Math.min(ensuiteH, master.height - bedZoneH);
  const finalArea = finalW * finalH;

  // Place ensuite in a CORNER of the master — touches two walls.
  // Prefer a corner where both walls are exterior (window on two sides).
  // Fall back to any exterior-wall corner, then any corner.
  const ext = {
    top:    isExteriorWall(master, "top", rooms),
    bottom: isExteriorWall(master, "bottom", rooms),
    left:   isExteriorWall(master, "left", rooms),
    right:  isExteriorWall(master, "right", rooms),
  };

  // Corner definitions: [corner name, x-offset, y-offset, wall1, wall2]
  const corners: Array<{ label: string; x: number; y: number; extCount: number }> = [
    { label: "top-left",     x: master.x,                          y: master.y,                          extCount: (ext.top ? 1 : 0) + (ext.left ? 1 : 0) },
    { label: "top-right",    x: master.x + master.width - finalW,  y: master.y,                          extCount: (ext.top ? 1 : 0) + (ext.right ? 1 : 0) },
    { label: "bottom-left",  x: master.x,                          y: master.y + master.height - finalH, extCount: (ext.bottom ? 1 : 0) + (ext.left ? 1 : 0) },
    { label: "bottom-right", x: master.x + master.width - finalW,  y: master.y + master.height - finalH, extCount: (ext.bottom ? 1 : 0) + (ext.right ? 1 : 0) },
  ];

  // Sort by exterior wall count (descending), pick the best corner
  corners.sort((a, b) => b.extCount - a.extCount);
  const best = corners[0];

  const ensuiteX = best.x;
  const ensuiteY = best.y;

  console.log(`[ensuite] corner="${best.label}" extWalls=${best.extCount} (top=${ext.top} bottom=${ext.bottom} left=${ext.left} right=${ext.right})`);

  rooms.push({
    name: "Ensuite",
    x: ensuiteX,
    y: ensuiteY,
    width: parseFloat(finalW.toFixed(2)),
    height: parseFloat(finalH.toFixed(2)),
    area: parseFloat(finalArea.toFixed(1)),
  });

  if (finalArea < 6) {
    console.log(`[ensuite] compact ${finalArea.toFixed(1)}m² (${finalW.toFixed(1)}×${finalH.toFixed(1)}m) — minimum functional size.`);
  }
}

/**
 * Carve a bathroom from the studio room (like an ensuite from a master bedroom).
 * Studios have a single open room — the bathroom should be placed in a corner,
 * touching two walls, so the remaining studio space stays contiguous.
 */
function carveBathroomFromStudio(
  rooms: GeneratedRoom[],
  zones?: Record<string, string[]>,
  mainEntranceDoors?: Door[]
): void {
  const studio = rooms.find(r => /studio/i.test(r.name));
  const bathroom = rooms.find(r => /bathroom/i.test(r.name) && !/ensuite/i.test(r.name));

  // Only carve if both Studio and Bathroom exist as separate rooms
  if (!studio || !bathroom) return;

  // Don't carve if bathroom is already inside the studio bounds
  const bInStudio =
    bathroom.x >= studio.x - 0.01 &&
    bathroom.y >= studio.y - 0.01 &&
    bathroom.x + bathroom.width <= studio.x + studio.width + 0.01 &&
    bathroom.y + bathroom.height <= studio.y + studio.height + 0.01;

  if (bInStudio) {
    // Already carved — nothing to do
    return;
  }

  if (!zones) return;

  const allZoneNames = Object.values(zones).flat().filter(Boolean) as string[];
  const hasStudio = allZoneNames.some(n => /studio/i.test(n));
  const hasBathroom = allZoneNames.some(n => /bathroom/i.test(n) && !/ensuite/i.test(n));
  if (!hasStudio || !hasBathroom) return;

  // ── Minimum functional bathroom: toilet + sink + shower/bathtub ──
  const MIN_BATH_AREA = 6.0;   // m²
  const MIN_BATH_W = 1.8;      // m
  const MIN_BATH_H = 2.5;      // m

  // Studio must be large enough to carve a bathroom and still be functional
  if (studio.area < MIN_BATH_AREA + 12) {
    console.warn(`[studio-bath] ⚠️ studio too small (${studio.area.toFixed(1)}m²) to carve bathroom — leaving separate.`);
    return;
  }

  // Use the bathroom's original ratio, capped at 18% of studio area
  const bathArea = Math.max(MIN_BATH_AREA, Math.min(bathroom.area, studio.area * 0.18));
  const bathW = Math.max(MIN_BATH_W, Math.min(2.6, Math.sqrt(bathArea * 0.7)));
  const bathH = Math.max(MIN_BATH_H, bathArea / bathW);

  if (bathW > studio.width - 1.5 || bathH > studio.height - 2.5) {
    console.warn(`[studio-bath] ⚠️ bathroom (${bathW.toFixed(1)}×${bathH.toFixed(1)}m) too large for studio (${studio.width.toFixed(1)}×${studio.height.toFixed(1)}m).`);
    return;
  }

  // Place bathroom in a corner of the studio — prefer exterior walls,
  // but AVOID the main entrance wall and balcony wall.
  const ext = {
    top:    isExteriorWall(studio, "top", rooms),
    bottom: isExteriorWall(studio, "bottom", rooms),
    left:   isExteriorWall(studio, "left", rooms),
    right:  isExteriorWall(studio, "right", rooms),
  };

  // Detect balcony walls from the actual rooms (balcony now exists in rooms array)
  const balconySides = new Set<"bottom" | "top" | "left" | "right">();
  {
    const TOL = 0.2;
    let maxX = 0, maxY = 0, minX = Infinity, minY = Infinity;
    for (const r of rooms) {
      if (/porch|balcony/i.test(r.name)) continue;
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.width > maxX) maxX = r.x + r.width;
      if (r.y + r.height > maxY) maxY = r.y + r.height;
    }
    for (const r of rooms) {
      if (!/balcony/i.test(r.name)) continue;
      if (r.y + r.height <= minY + TOL) balconySides.add("bottom");
      if (r.y >= maxY - TOL) balconySides.add("top");
      if (r.x + r.width <= minX + TOL) balconySides.add("left");
      if (r.x >= maxX - TOL) balconySides.add("right");
    }
  }

  // Use the ACTUAL main entrance door wall (not predicted) since the entrance
  // has already been generated at this point.
  const mainDoor = mainEntranceDoors?.[0];
  const blockedWalls = new Set<"bottom" | "top" | "left" | "right">();
  if (mainDoor) {
    blockedWalls.add(mainDoor.wall);
  } else {
    // Fallback: predict entrance (shouldn't happen since entrance is already generated)
    const entrancePriority: Array<"bottom" | "left" | "right" | "top"> = ["bottom", "left", "right", "top"];
    for (const wall of entrancePriority) {
      if (balconySides.has(wall)) continue;
      blockedWalls.add(wall);
      break;
    }
  }
  // Also block balcony walls
  for (const w of balconySides) blockedWalls.add(w);

  const corners: Array<{ label: string; x: number; y: number; extCount: number; blockedCount: number }> = [
    { label: "top-left",     x: studio.x,                             y: studio.y,                              extCount: (ext.top ? 1 : 0) + (ext.left ? 1 : 0),   blockedCount: (blockedWalls.has("top") ? 1 : 0) + (blockedWalls.has("left") ? 1 : 0) },
    { label: "top-right",    x: studio.x + studio.width - bathW,      y: studio.y,                              extCount: (ext.top ? 1 : 0) + (ext.right ? 1 : 0),  blockedCount: (blockedWalls.has("top") ? 1 : 0) + (blockedWalls.has("right") ? 1 : 0) },
    { label: "bottom-left",  x: studio.x,                             y: studio.y + studio.height - bathH,     extCount: (ext.bottom ? 1 : 0) + (ext.left ? 1 : 0), blockedCount: (blockedWalls.has("bottom") ? 1 : 0) + (blockedWalls.has("left") ? 1 : 0) },
    { label: "bottom-right", x: studio.x + studio.width - bathW,      y: studio.y + studio.height - bathH,     extCount: (ext.bottom ? 1 : 0) + (ext.right ? 1 : 0), blockedCount: (blockedWalls.has("bottom") ? 1 : 0) + (blockedWalls.has("right") ? 1 : 0) },
  ];

  // Sort: prefer corners with FEWER blocked walls, then more exterior walls
  corners.sort((a, b) => {
    if (a.blockedCount !== b.blockedCount) return a.blockedCount - b.blockedCount;
    return b.extCount - a.extCount;
  });
  const best = corners[0];

  console.log(`[studio-bath] carving bathroom from Studio corner="${best.label}" extWalls=${best.extCount} balconyWalls=${Array.from(balconySides)} entrance=${mainDoor?.wall ?? "?"} blocked=${Array.from(blockedWalls)} (${bathW.toFixed(1)}×${bathH.toFixed(1)}m, ${(bathW*bathH).toFixed(1)}m²)`);

  // Remove the old separate bathroom
  const bathIdx = rooms.indexOf(bathroom);
  if (bathIdx >= 0) rooms.splice(bathIdx, 1);

  // Add the carved bathroom at the corner
  rooms.push({
    name: "Bathroom",
    x: best.x,
    y: best.y,
    width: parseFloat(bathW.toFixed(2)),
    height: parseFloat(bathH.toFixed(2)),
    area: parseFloat((bathW * bathH).toFixed(1)),
  });
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
    // Priority: living room → studio → master → any bedroom → kitchen → any room on exterior
    hostRoom = rooms.find(r => /living|lounge|family/i.test(r.name) && !usedHosts.has(r.name))
            || rooms.find(r => /studio/i.test(r.name) && !usedHosts.has(r.name))
            || rooms.find(r => /master/i.test(r.name) && !usedHosts.has(r.name))
            || rooms.find(r => /bedroom/i.test(r.name) && !usedHosts.has(r.name))
            // Fall back to any room even if already used
            || rooms.find(r => /living|lounge|family/i.test(r.name))
            || rooms.find(r => /studio/i.test(r.name))
            || rooms.find(r => /master/i.test(r.name))
            || rooms.find(r => /bedroom/i.test(r.name))
            // Ultimate fallback: any non-hallway, non-extension room
            || rooms.find(r => /kitchen/i.test(r.name))
            || rooms.find(r => !/hallway|porch|balcony/i.test(r.name));
  } else if (isPorch) {
    hostRoom = rooms.find(r => /living|lounge/i.test(r.name))
            || rooms.find(r => /kitchen/i.test(r.name))
            // Fallback: any room at the front
            || rooms.find(r => !/hallway|porch|balcony/i.test(r.name));
  }

  if (!hostRoom) {
    console.warn(`[extension] ⚠️ no host room found for "${name}" — skipping.`);
    return null;
  }

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

  const extLen = Math.min(hostRoom.width * 0.5, 2.8);

  // Offset balcony to one side to leave room for bathroom door / entrance.
  // Detect if the studio has a bathroom zone — if so, offset away from it.
  const hasBathZone = rooms.some(r => /bathroom/i.test(r.name) && !/ensuite/i.test(r.name));
  let extOffset: number;
  if (hasBathZone) {
    // Check which side the bathroom is likely on (before carving, it's still a separate room)
    const bathRoom = rooms.find(r => /bathroom/i.test(r.name) && !/ensuite/i.test(r.name));
    if (bathRoom && bathRoom.x + bathRoom.width / 2 < hostRoom.x + hostRoom.width / 2) {
      // Bathroom on left → offset balcony to right
      extOffset = Math.max(0, hostRoom.width - extLen - 0.3);
    } else {
      // Bathroom likely on right → offset balcony to left
      extOffset = 0.3;
    }
  } else {
    // No bathroom zone — center the balcony
    extOffset = (hostRoom.width - extLen) / 2;
  }

  switch (extWall) {
    case "bottom":
      return { name, x: hostRoom.x + extOffset, y: hostRoom.y - 1.5, width: extLen, height: 1.5, area: parseFloat((extLen * 1.5).toFixed(1)) };
    case "top":
      return { name, x: hostRoom.x + extOffset, y: hostRoom.y + hostRoom.height, width: extLen, height: 1.5, area: parseFloat((extLen * 1.5).toFixed(1)) };
    case "left":
      return { name, x: hostRoom.x - 1.5, y: hostRoom.y + extOffset, width: 1.5, height: extLen, area: parseFloat((extLen * 1.5).toFixed(1)) };
    case "right":
      return { name, x: hostRoom.x + hostRoom.width, y: hostRoom.y + extOffset, width: 1.5, height: extLen, area: parseFloat((extLen * 1.5).toFixed(1)) };
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

function generateDoors(rooms: GeneratedRoom[], skipWalls?: Set<string>, kitchenLivingConnection?: "open" | "door" | "window" | "separated"): Door[] {
  const doors: Door[] = [];
  const hallway = rooms.find(r => /hallway/i.test(r.name));
  // Kitchen as a separate room (only in larger homes with hallways).
  // In hub-and-spoke / skipHallway layouts, kitchens are merged into living room.
  const kitchen = rooms.find(r => /kitchen|cooking|kitchenette/i.test(r.name));

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
    // The ensuite is carved inside the master, so we place the door on the
    // wall OPPOSITE the exterior wall it sits against (faces the bedroom).
    if (/ensuite/i.test(room.name)) {
      const master = rooms.find(r => /master/i.test(r.name));
      if (master) {
        // Find which wall of the ensuite is exterior — the door goes opposite
        const extWall = findExteriorWall(room, rooms);
        const doorWall = oppositeWall(extWall);

        const wallLen = doorWall === "left" || doorWall === "right" ? room.height : room.width;
        const doorWidth = 0.75;
        const doorOffset = Math.max(doorWidth / 2 + 0.15, Math.min(wallLen - doorWidth / 2 - 0.15, wallLen * 0.5));

        doors.push({
          room: room.name,
          wall: doorWall,
          offset: doorOffset,
          width: doorWidth,
          swing: "in",
        });
        // Note: no master-side door — the ensuite is carved inside the master,
        // so the ensuite door alone shows the access point.
      }
      continue;
    }

    // Bathroom carved from studio — door faces into the studio room
    // (same pattern as ensuite carved from master bedroom)
    if (/bathroom/i.test(room.name) && !/ensuite/i.test(room.name)) {
      const studio = rooms.find(r => /studio/i.test(r.name));
      if (studio) {
        // Check if bathroom is inside the studio bounds (carved)
        const bInStudio =
          room.x >= studio.x - 0.01 &&
          room.y >= studio.y - 0.01 &&
          room.x + room.width <= studio.x + studio.width + 0.01 &&
          room.y + room.height <= studio.y + studio.height + 0.01;

        if (bInStudio) {
          // Find which wall of the bathroom is exterior — door goes opposite
          const extWall = findExteriorWall(room, rooms);
          const doorWall = oppositeWall(extWall);
          const wallLen = doorWall === "left" || doorWall === "right" ? room.height : room.width;
          const doorWidth = 0.8;
          const doorOffset = Math.max(doorWidth / 2 + 0.15, Math.min(wallLen - doorWidth / 2 - 0.15, wallLen * 0.5));

          doors.push({
            room: room.name,
            wall: doorWall,
            offset: doorOffset,
            width: doorWidth,
            swing: "in",
          });
          continue;
        }
      }
    }

    if (hallway) {
      const wall = findWallToHallway(room, hallway);
      if (wall) {
        // Skip if a main entrance door already exists on this room+wall (apartment mode)
        const key = `${room.name}:${wall}`;
        if (skipWalls && skipWalls.has(key)) continue;

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

  // ── Hub-and-spoke: internal doors from living room to every adjacent room ──
  // In hub layouts, the living room is the central circulation space.
  // Every other room gets a door connecting directly to the living room.
  const hasLiving = rooms.some(r => /living|lounge|family/i.test(r.name));
  if (!hallway && hasLiving) {
    const living = rooms.find(r => /living|lounge|family/i.test(r.name))!;
    for (const room of rooms) {
      if (room === living) continue;
      if (/porch|balcony|garage/i.test(room.name)) continue;

      const sharedWall = findWallToHallway(room, living);
      if (sharedWall) {
        const isKitchen = /kitchen|cooking|kitchenette/i.test(room.name);
        // Kitchen gets a wide open passage, other rooms get standard doors
        const doorW = isKitchen ? Math.min((sharedWall === "left" || sharedWall === "right" ? room.height : room.width) * 0.6, 2.5) : 0.85;

        const wallLen = sharedWall === "left" || sharedWall === "right" ? room.height : room.width;
        // Offset: bathrooms centered (50%) so both corners stay free
        // for shower and sink. Bedrooms and kitchens also at 50%.
        const doorOffset = Math.max(0.5, wallLen * 0.5);

        doors.push({
          room: room.name,
          wall: sharedWall,
          offset: doorOffset,
          width: doorW,
          swing: "in" as const,
        });
        console.log(`[hub-doors] ${room.name} ↔ Living Room on ${sharedWall} wall (${isKitchen ? "open passage" : "door"})`);
      }
    }
  }

  // ── Kitchen ↔ living room connection ──
  // Default: wide open-plan passage. Can be overridden to door, window, or solid wall.
  const klConnection = kitchenLivingConnection ?? "open";
  // Skip if already handled by hub-and-spoke above (no hallway)
  if (klConnection !== "separated" && kitchen && hallway) {
    const livingRoom = rooms.find(r => /living|lounge|family/i.test(r.name));
    if (livingRoom && livingRoom !== kitchen) {
      const sharedWall = findWallToHallway(kitchen, livingRoom);
      if (sharedWall) {
        const wallLen = sharedWall === "left" || sharedWall === "right"
          ? kitchen.height : kitchen.width;

        let openingWidth: number;
        let label: string;
        switch (klConnection) {
          case "door":
            openingWidth = 0.85;
            label = "door";
            break;
          case "window":
            openingWidth = Math.min(wallLen * 0.3, 1.5);
            label = "serving window";
            break;
          default: // "open"
            openingWidth = Math.min(wallLen * 0.6, 2.5);
            label = "open passage";
            break;
        }

        const openingOffset = wallLen * 0.5;

        // Opening on the kitchen side
        doors.push({
          room: kitchen.name,
          wall: sharedWall,
          offset: openingOffset,
          width: openingWidth,
          swing: "in",
        });
        // Matching opening on the living room side
        doors.push({
          room: livingRoom.name,
          wall: oppositeWall(sharedWall),
          offset: (oppositeWall(sharedWall) === "left" || oppositeWall(sharedWall) === "right"
            ? livingRoom.height : livingRoom.width) * 0.5,
          width: openingWidth,
          swing: "in",
        });

        console.log(`[kitchen-living] ${label} (${openingWidth.toFixed(1)}m) on ${sharedWall} wall`);
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

function generateWindows(rooms: GeneratedRoom[], _buildingW: number, _buildingH: number, allDoors: Door[]): Window[] {
  const windows: Window[] = [];
  const TOL = 0.1;
  const WALL_MARGIN = 0.2;
  const DOOR_GAP = 0.15;

  // Use actual room extents for exterior wall detection, not formula dimensions
  const bldMaxX = Math.max(...rooms.map(r => r.x + r.width));
  const bldMaxY = Math.max(...rooms.map(r => r.y + r.height));
  const bldMinX = Math.min(...rooms.map(r => r.x));
  const bldMinY = Math.min(...rooms.map(r => r.y));

  for (const room of rooms) {
    if (/hallway|corridor|foyer|garage|porch|balcony/i.test(room.name)) continue;

    const walls: Array<{ wall: Door["wall"]; len: number }> = [];

    if (Math.abs(room.x - bldMinX) < TOL) walls.push({ wall: "left", len: room.height });
    if (Math.abs(room.x + room.width - bldMaxX) < TOL) walls.push({ wall: "right", len: room.height });
    if (Math.abs(room.y - bldMinY) < TOL) walls.push({ wall: "bottom", len: room.width });
    if (Math.abs(room.y + room.height - bldMaxY) < TOL) walls.push({ wall: "top", len: room.width });

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

      const wWidth = Math.min(availableLen * 0.7, 1.8);
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
 * Generate the main entrance door.
 * Ground-floor houses: front exterior wall (bottom), optionally via porch.
 * Apartments/upper-floor: exterior bottom wall, aligned with E.Hallway
 *   (the building's shared corridor / stairwell access point).
 */
function generateMainEntrance(rooms: GeneratedRoom[], isGroundFloor: boolean = true): Door[] {
  const TOL = 0.1;
  const porch = rooms.find(r => /porch/i.test(r.name));
  const hallway = rooms.find(r => /hallway/i.test(r.name));
  const doorWidth = 1.0;

  // ── Hub-and-spoke / small apartment: entrance MUST go through living room ──
  const hasLivingRoom = rooms.some(r => /living|lounge|family/i.test(r.name));
  const isHub = !hallway && hasLivingRoom && rooms.filter(r => !/porch|balcony/i.test(r.name)).length >= 3;

  if (isHub) {
    const living = rooms.find(r => /living|lounge|family/i.test(r.name))!;
    const TOL = 0.15;
    const otherRooms = rooms.filter(r => r !== living && !/porch|balcony/i.test(r.name));
    const hasNeighbor = (wall: string) =>
      wall === "bottom" ? otherRooms.some(r => Math.abs(living.y - (r.y + r.height)) < TOL)
      : wall === "top" ? otherRooms.some(r => Math.abs((living.y + living.height) - r.y) < TOL)
      : wall === "left" ? otherRooms.some(r => Math.abs(living.x - (r.x + r.width)) < TOL)
      : otherRooms.some(r => Math.abs((living.x + living.width) - r.x) < TOL);

    const preferredWalls: Door["wall"][] = ["bottom", "right", "left", "top"];
    for (const w of preferredWalls) {
      if (!hasNeighbor(w) && isExteriorWall(living, w, rooms)) {
        const wallLen = w === "left" || w === "right" ? living.height : living.width;
        console.log(`[main-entrance] hub: living room on ${w} wall`);
        return [{
          room: living.name, wall: w,
          offset: Math.max(0.6, wallLen * 0.5),
          width: doorWidth, swing: "in",
        }];
      }
    }
    // Fallback: any exterior wall of living room
    const extWall = findExteriorWall(living, rooms);
    const wallLen = extWall === "left" || extWall === "right" ? living.height : living.width;
    console.log(`[main-entrance] hub fallback: living room on ${extWall} wall`);
    return [{ room: living.name, wall: extWall, offset: Math.max(0.6, wallLen * 0.5), width: doorWidth, swing: "in" }];
  }

  // ── Apartment/upper-floor: exterior wall WITHOUT a balcony ──
  // E.Hallway (building corridor) and balconies serve different purposes
  // and must not occupy the same exterior side of the building.
  // Studios and compact apartments may not have a hallway — still need E.Hallway access.
  if (!isGroundFloor) {
    const balconySides = getBalconySides(rooms);
    const TOL = 0.1;

    // Compute building extents from rooms
    let bldMaxX = 0, bldMaxY = 0;
    for (const r of rooms) {
      if (/porch|balcony/i.test(r.name)) continue;
      if (r.x + r.width > bldMaxX) bldMaxX = r.x + r.width;
      if (r.y + r.height > bldMaxY) bldMaxY = r.y + r.height;
    }

    // Find a room on an exterior wall that doesn't have a balcony
    // Priority: bottom (front) → left → right → top
    const candidateWalls: Array<{ wall: Door["wall"]; check: (r: GeneratedRoom) => boolean; label: string }> = [
      { wall: "bottom", check: r => Math.abs(r.y) < TOL, label: "bottom (front)" },
      { wall: "left",   check: r => Math.abs(r.x) < TOL, label: "left" },
      { wall: "right",  check: r => Math.abs(r.x + r.width - bldMaxX) < TOL, label: "right" },
      { wall: "top",    check: r => Math.abs(r.y + r.height - bldMaxY) < TOL, label: "top (back)" },
    ];

    for (const { wall, check, label } of candidateWalls) {
      if (balconySides.has(wall)) {
        console.log(`[main-entrance] skipping ${label} wall — has balcony`);
        continue;
      }

      const room =
        // Prefer the living room as the entrance host so the furniture
        // placer can see the main door and keep the seating area clear of it.
        rooms.find(r =>
          check(r) && !/hallway|porch|balcony|garage/i.test(r.name) &&
          /living|lounge|family|media/i.test(r.name)
        ) ??
        rooms.find(r =>
          check(r) && !/hallway|porch|balcony|garage/i.test(r.name)
        );

      if (room) {
        const wallLen = wall === "left" || wall === "right" ? room.height : room.width;
        const offset = Math.max(doorWidth / 2 + 0.2, Math.min(wallLen - doorWidth / 2 - 0.2, wallLen * 0.5));

        console.log(`[main-entrance] apartment: exterior ${label} wall of "${room.name}" (E.Hallway access)`);
        return [{
          room: room.name,
          wall,
          offset,
          width: doorWidth,
          swing: "in",
        }];
      }
    }

    console.warn("[main-entrance] ⚠️ apartment mode but no non-balcony exterior wall for main entrance.");
    return [];
  }

  // ── Ground-floor: front exterior door ──
  // Find rooms touching the front (y ≈ 0)
  const frontRooms = rooms.filter(r =>
    !/porch|balcony/i.test(r.name) && Math.abs(r.y) < TOL
  );

  // Priority: living room on front → hallway → first available
  const frontRoom = frontRooms.find(r => /living|lounge|family/i.test(r.name))
    || frontRooms.find(r => /hallway/i.test(r.name))
    || frontRooms[0];

  if (!frontRoom) return [];

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
    // Find the interior room this balcony is attached to.
    // Use the standard adjacency check first, then a wider-tolerance fallback
    // (mirrors detectBalconyWall in furniturePlacer.ts).
    let host: GeneratedRoom | undefined;
    let wall: Door["wall"] | null = null;

    // Try strict adjacency (TOL=0.1) first
    host = rooms.find(r =>
      r !== balcony &&
      !/porch|balcony/i.test(r.name) &&
      findWallToHallway(balcony, r) !== null
    );

    if (host) {
      wall = findWallToHallway(balcony, host);
    } else {
      // Fallback: wider-tolerance detection (TOL=0.5) for robustness against
      // floating-point drift from extension offset calculations.
      for (const r of rooms) {
        if (r === balcony || /porch|balcony/i.test(r.name)) continue;
        const w = findBalconySharedWall(balcony, r);
        if (w) { host = r; wall = w; break; }
      }
    }

    if (!host || !wall) {
      console.warn(`[balcony-door] ⚠️ no host room found for "${balcony.name}" — skipping door.`);
      continue;
    }

    const doorWidth = 2.0; // wide sliding/French door for balcony access

    // Place the door on the BALCONY side — always aligns with the balcony position.
    // This is more intuitive than placing it on the host room's wall.
    const balconyWallLen = wall === "left" || wall === "right" ? balcony.height : balcony.width;
    const balconyOffset = Math.max(doorWidth / 2 + 0.15, Math.min(balconyWallLen - doorWidth / 2 - 0.15, balconyWallLen * 0.5));

    doors.push({
      room: balcony.name,
      wall,
      offset: balconyOffset,
      width: doorWidth,
      swing: "in",
    });

    console.log(`[balcony-door] "${balcony.name}" ← "${host.name}" on ${wall} wall`);
  }

  return doors;
}

/**
 * Wide-tolerance balcony-host wall detection (TOL=0.5).
 * Mirrors detectBalconyWall in furniturePlacer.ts for consistency.
 */
function findBalconySharedWall(
  balcony: GeneratedRoom,
  room: GeneratedRoom
): Door["wall"] | null {
  const TOL = 0.5;
  const hOverlap =
    balcony.x + balcony.width > room.x + TOL &&
    room.x + room.width > balcony.x + TOL;
  const vOverlap =
    balcony.y + balcony.height > room.y + TOL &&
    room.y + room.height > balcony.y + TOL;

  // Balcony below room → shared bottom wall of room, top wall of balcony
  if (Math.abs(room.y - (balcony.y + balcony.height)) < TOL && hOverlap) return "top";
  // Balcony above room → shared top wall of room, bottom wall of balcony
  if (Math.abs(balcony.y - (room.y + room.height)) < TOL && hOverlap) return "bottom";
  // Balcony left of room → shared left wall of room, right wall of balcony
  if (Math.abs(room.x - (balcony.x + balcony.width)) < TOL && vOverlap) return "right";
  // Balcony right of room → shared right wall of room, left wall of balcony
  if (Math.abs(balcony.x - (room.x + room.width)) < TOL && vOverlap) return "left";
  return null;
}

/**
 * Detect and resolve conflicts where a main entrance door and a balcony door
 * occupy the same physical wall segment. Offsets the balcony door away from
 * the main entrance so they don't overlap.
 */
function resolveDoorConflicts(
  doors: Door[],
  rooms: GeneratedRoom[],
  mainEntranceDoors: Door[],
  balconyDoors: Door[]
): void {
  for (const mainDoor of mainEntranceDoors) {
    const mainRoom = rooms.find(r => r.name === mainDoor.room);
    if (!mainRoom) continue;
    const mainPos = doorWorldPos(mainDoor, mainRoom);

    for (const balconyDoor of balconyDoors) {
      const balconyRoom = rooms.find(r => r.name === balconyDoor.room);
      if (!balconyRoom) continue;
      const balPos = doorWorldPos(balconyDoor, balconyRoom);
      const dist = Math.sqrt((mainPos.x - balPos.x) ** 2 + (mainPos.y - balPos.y) ** 2);

      // Overlapping doors on the same wall segment
      if (dist < 0.5 && mainDoor.wall === balconyDoor.wall) {
        const wallLen = balconyDoor.wall === "left" || balconyDoor.wall === "right"
          ? balconyRoom.height : balconyRoom.width;
        balconyDoor.offset = Math.max(balconyDoor.width / 2 + 0.2, wallLen * 0.2);
        const mainWallLen = mainDoor.wall === "left" || mainDoor.wall === "right"
          ? mainRoom.height : mainRoom.width;
        mainDoor.offset = Math.max(mainDoor.width / 2 + 0.2, mainWallLen * 0.8);
        console.log(`[door-conflict] resolved — offset balcony to ${balconyDoor.offset.toFixed(1)}, entrance to ${mainDoor.offset.toFixed(1)}`);
      }
    }
  }
}

/** Compute world-space position of a door's center on its room's wall. */
function doorWorldPos(door: Door, room: GeneratedRoom): { x: number; y: number } {
  switch (door.wall) {
    case "bottom": return { x: room.x + door.offset, y: room.y };
    case "top":    return { x: room.x + door.offset, y: room.y + room.height };
    case "left":   return { x: room.x, y: room.y + door.offset };
    case "right":  return { x: room.x + room.width, y: room.y + door.offset };
  }
}

/**
 * Generate a mandatory emergency exit for apartments/upper-floor units.
 * Placed on an exterior wall of a room that doesn't already have a balcony door.
 * Priority: master bedroom → kitchen → any bedroom → living room.
 * Swings outward for safety compliance.
 */
function generateEmergencyExit(rooms: GeneratedRoom[]): Door[] {
  const hallway = rooms.find(r => /hallway/i.test(r.name));

  // Find rooms with an exterior wall, excluding hallway, porch, balcony, garage
  const candidates = rooms.filter(r =>
    !/hallway|porch|balcony|garage|ensuite|bathroom|laundry/i.test(r.name)
  );

  // Sort by priority: master → kitchen → bedroom → living → any
  const priority = (r: GeneratedRoom): number => {
    const n = r.name.toLowerCase();
    if (/master/i.test(n)) return 0;
    if (/kitchen/i.test(n)) return 1;
    if (/bedroom/i.test(n)) return 2;
    if (/living|lounge|family/i.test(n)) return 3;
    return 4;
  };
  candidates.sort((a, b) => priority(a) - priority(b));

  for (const room of candidates) {
    // Find an exterior wall that's NOT the hallway wall
    const extWall = findExteriorWall(room, rooms);
    if (!extWall) continue;

    // Skip if this wall faces the hallway
    if (hallway) {
      const hallwayWall = findWallToHallway(room, hallway);
      if (hallwayWall === extWall) continue;
    }

    const wallLen = extWall === "left" || extWall === "right" ? room.height : room.width;
    const doorWidth = 0.9;

    // Place near the edge of the wall, away from the center (doesn't compete with windows)
    const offset = Math.max(doorWidth / 2 + 0.2, wallLen * 0.15);

    console.log(`[emergency-exit] on "${room.name}" ${extWall} wall`);
    return [{
      room: room.name,
      wall: extWall,
      offset,
      width: doorWidth,
      swing: "out", // emergency exits swing outward
    }];
  }

  console.warn("[emergency-exit] ⚠️ no suitable exterior wall found for emergency exit.");
  return [];
}

/**
 * For apartments, compute the E.Hallway position outside the building.
 * E.Hallway is the building's shared corridor — placed on an exterior side
 * that does NOT have a balcony (balconies face open space, not corridors).
 */
function computeEntranceApproach(
  rooms: GeneratedRoom[],
  mainEntranceDoors: Door[],
  isGroundFloor: boolean
): { eHallX: number; eHallY: number; doorX: number; doorY: number; wall: Door["wall"] } | undefined {
  if (isGroundFloor) return undefined;

  const mainDoor = mainEntranceDoors[0];
  if (!mainDoor) return undefined;

  const room = rooms.find(r => r.name === mainDoor.room);
  if (!room) return undefined;

  const wall = mainDoor.wall;

  // Compute door world position
  let doorWorldX: number, doorWorldY: number;
  if (wall === "left" || wall === "right") {
    doorWorldX = wall === "left" ? room.x : room.x + room.width;
    doorWorldY = room.y + mainDoor.offset;
  } else {
    doorWorldX = room.x + mainDoor.offset;
    doorWorldY = wall === "bottom" ? room.y : room.y + room.height;
  }

  // E.Hallway: outside the building, on the same side as the main entrance door
  const eHallDist = 1.0;
  let eHallX = doorWorldX, eHallY = doorWorldY;
  switch (wall) {
    case "bottom": eHallY = room.y - eHallDist; break;
    case "top":    eHallY = room.y + room.height + eHallDist; break;
    case "left":   eHallX = room.x - eHallDist; break;
    case "right":  eHallX = room.x + room.width + eHallDist; break;
  }

  return { eHallX, eHallY, doorX: doorWorldX, doorY: doorWorldY, wall };
}

/** Detect which building exterior sides have balconies attached. */
function getBalconySides(rooms: GeneratedRoom[]): Set<"top" | "bottom" | "left" | "right"> {
  const sides = new Set<"top" | "bottom" | "left" | "right">();
  const TOL = 0.2;

  // Compute building extents
  let maxX = 0, maxY = 0, minX = Infinity, minY = Infinity;
  for (const r of rooms) {
    if (/porch|balcony/i.test(r.name)) continue;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }

  for (const r of rooms) {
    if (!/balcony/i.test(r.name)) continue;
    if (r.y + r.height <= minY + TOL) sides.add("bottom");
    if (r.y >= maxY - TOL) sides.add("top");
    if (r.x + r.width <= minX + TOL) sides.add("left");
    if (r.x >= maxX - TOL) sides.add("right");
  }
  return sides;
}
