type AIProvider = "openai" | "deepseek";

import { computeLayout, AbstractPlan } from "./layoutEngine";
import { PlacedFurniture } from "./furniture";
import { suggestFurniture } from "./furniturePlacer";

interface AIClientConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
}

function getConfig(): AIClientConfig {
  const provider = (process.env.AI_PROVIDER || "deepseek") as AIProvider;

  if (provider === "deepseek") {
    return {
      provider: "deepseek",
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat", // DeepSeek V4 Pro
    };
  }

  return {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o",
  };
}

interface GenerateFloorPlanInput {
  description: string;
  style?: "modern" | "rustic" | "minimalist";
  budget?: "basic" | "standard" | "premium";
  /** Pre-converted area in m², if the user specified one */
  areaM2?: number;
  /** Whether this is a ground-floor house (true) or apartment/upper-floor (false) */
  isGroundFloor?: boolean;
  /** Whether to include a mandatory emergency exit (apartments only) */
  emergencyExit?: boolean;
  /** Kitchen-living room connection: "open" (default), "door", "window", or "separated" */
  kitchenLivingConnection?: "open" | "door" | "window" | "separated";
}

export interface GeneratedRoom {
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  area: number;
  /** Optional polygon vertices for non-rectangular rooms (in meters, world coords) */
  polygon?: Array<{ x: number; y: number }>;
  /** Shape type */
  shape?: "rectangle" | "l-shape" | "bay-window" | "angled-corner" | "polygon";
  /** Optional display override (e.g., "I.Hallway" for apartment interior hallways) */
  displayLabel?: string;
  /** True when this room absorbs a kitchen zone (kitchen area/kitchenette/cooking area) */
  hasKitchenZone?: boolean;
}

export interface Door {
  room: string;
  wall: "top" | "bottom" | "left" | "right";
  offset: number;
  width: number;
  swing: "in" | "out";
}

export interface Window {
  room: string;
  wall: "top" | "bottom" | "left" | "right";
  offset: number;
  width: number;
}

export interface FloorPlanResult {
  rooms: GeneratedRoom[];
  doors?: Door[];
  windows?: Window[];
  totalArea: number;
  warnings?: string[];
  sustainabilityScore: {
    light: number;
    ventilation: number;
    energy: number;
    overall: number;
  };
  costEstimate: {
    low: number;
    high: number;
    currency: string;
  };
  /** Pre-placed furniture items */
  placedFurniture?: PlacedFurniture[];
  /** Building perimeter polygon (world coords) */
  buildingPolygon?: Array<{ x: number; y: number }>;
  /** For apartments: building corridor access point and the main entrance it connects to */
  entranceApproach?: { eHallX: number; eHallY: number; doorX: number; doorY: number; wall: Door["wall"] };
  raw: string;
}

const ABSTRACT_PLAN_FORMAT = `{
  "totalArea": 150,
  "hallwayWidth": 1.2,
  "hallwaySide": "center",
  "zones": {
    "frontLeft": ["Garage"],
    "leftMiddle": ["Kitchen"],
    "backLeft": ["Master Bedroom", "Ensuite"],
    "frontRight": ["Living Room"],
    "backRight": ["Bedroom 2", "Bathroom"]
  },
  "roomRatios": {
    "Living Room": 0.22, "Kitchen": 0.12, "Master Bedroom": 0.16,
    "Bedroom 2": 0.12, "Bathroom": 0.05, "Ensuite": 0.03, "Garage": 0.16
  },
  "exteriorExtensions": { "Porch": "front" },
  "roomShapes": { "Living Room": "bay-window", "Master Bedroom": "angled-corner" },
  "sustainabilityScore": { "light": 0.8, "ventilation": 0.7, "energy": 0.75, "overall": 0.75 },
  "costEstimate": { "low": 50000, "high": 80000, "currency": "USD" }
}`;

async function callOpenAI(
  config: AIClientConfig,
  prompt: string
): Promise<string> {
  const baseURL =
    config.provider === "deepseek"
      ? "https://api.deepseek.com/v1"
      : "https://api.openai.com/v1";

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            `You are an architectural planner. Output valid JSON only, no markdown.\n\nReturn this abstract plan format (the layout engine computes coordinates):\n${ABSTRACT_PLAN_FORMAT}\n\nSTUDIO / STUDIO APARTMENT RULES (apply when user asks for \"studio\"):\n- A studio is ONE open room — NOT separate rooms. Do NOT create separate \"Bedroom\", \"Kitchen\", or \"Living Room\" zones.\n- Create a single zone called \"Studio\" that contains all living functions (sleeping, cooking, sitting areas).\n- Only separate room: \"Bathroom\". Always include a Bathroom.\n- totalArea: 25-40m² (if user doesn't specify). Studios are compact by definition.\n- Studios NEVER have hallways or corridors.\n- If user asks for a balcony, add it in exteriorExtensions (e.g. \"Balcony\": \"right\").\n\nCRITICAL RULES:\n- totalArea MUST be at least 60m². A 2-bedroom house needs at least 80m², 3-bedroom at least 100m². Never return less than 60m² (exception: studios — see STUDIO rules above).\n- totalArea is INTERIOR floor area ONLY. Balconies, porches, and verandas are exterior extensions that sit OUTSIDE the building — they do NOT count toward totalArea. They go in exteriorExtensions.\n- Only include rooms the user explicitly asked for. Do NOT invent rooms (no auto-dining, no auto-guest).\n- If the user asks for N bedrooms, you MUST include exactly N bedrooms (Master Bedroom counts as 1). Count and verify.\n- If the user asks for N bathrooms, Ensuite COUNTS as a bathroom. "1 bathroom" → ALWAYS a standalone Bathroom (never Ensuite — it must be accessible to everyone). "2+ bathrooms" + master → 1 Ensuite + remaining Bathroom(s). Count and verify. NEVER create duplicate room names.\n- If user asks for a garage, you MUST include it in frontLeft or frontRight zone. It is required, not optional.\n- Master bedroom must always be in backLeft or backRight zone.\n- Living room must be in frontLeft or frontRight (it's the face of the house).\n- No single room should exceed 22% of totalArea. Living room and garage are largest at 18-22%.\n\nDETAILED RULES:\n- totalArea in m². Convert sq ft (÷10.764). If user specifies sq ft, convert to m².\n- hallwaySide: "center", "left", or "right".\n- zones: room names by column. Available slots: frontLeft, leftMiddle, backLeft, frontRight, rightMiddle, backRight.\n- roomRatios: fraction of totalArea for each room. Sum to 1.0 (excl. extensions).\n  Smallest (2-5%): Bathroom, Ensuite, Porch.\n  Medium (8-14%): Bedrooms, Kitchen.\n  Largest (16-22%): Living Room, Garage. Living Room always largest.\n  1 bath → always standalone Bathroom in a back zone (never Ensuite — must be hallway-accessible). 2+ baths → 1 Ensuite (with master) + remaining Bathroom(s) spread across different zones.\n  Ensuite ONLY with Master Bedroom in same zone.\n- exteriorExtensions: Porch=front, Balcony=right/left/back. These are EXTRA space outside the building — their area is NOT part of totalArea.\n- If user requested dining, place Kitchen + Dining on same side.\n- If user requested garage, place in frontLeft or frontRight. Garage MUST be included if asked.\n- roomShapes (optional): "rectangle", "l-shape", "bay-window", "angled-corner".`,
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`${config.provider} API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

export async function generateFloorPlan(
  input: GenerateFloorPlanInput
): Promise<FloorPlanResult> {
  const config = getConfig();

  if (!config.apiKey) {
    throw new Error(
      `Missing API key for ${config.provider}. Set ${config.provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY"} in your environment.`
    );
  }

  const style = input.style || "modern";
  const budget = input.budget || "standard";

  const areaHint = input.areaM2
    ? `\nIMPORTANT: The total area MUST be ${input.areaM2}m². Do not use any other value.`
    : "";

  const prompt = `USER REQUEST: "${input.description}"\nStyle: ${style} | Budget: ${budget}${areaHint}\n\nReturn the abstract plan JSON. No coordinates — the layout engine handles geometry.`;

  const raw = await callOpenAI(config, prompt);
  const parsed = JSON.parse(raw);

  // Try abstract plan format (layout engine), fall back to legacy coordinates
  if (parsed.zones && parsed.roomRatios) {
    const layout = computeLayout(parsed as AbstractPlan, {
      isGroundFloor: input.isGroundFloor ?? true,
      emergencyExit: input.emergencyExit ?? false,
      kitchenLivingConnection: input.kitchenLivingConnection ?? "open",
    });
    const furniture = suggestFurniture(layout.rooms, layout.doors, layout.windows);

    // ── Post-furniture check: if an ensuite has no toilet, sink, or shower/bathtub,
    //     it's not functional — remove it and warn the user.
    const ensuiteRoom = layout.rooms.find(r => /ensuite/i.test(r.name));
    if (ensuiteRoom) {
      const ensuiteFurniture = furniture.filter(f => f.room === ensuiteRoom.name);
      const hasToilet = ensuiteFurniture.some(f => f.itemId === "toilet");
      const hasSink = ensuiteFurniture.some(f => f.itemId === "sink-bathroom");
      const hasShowerOrTub = ensuiteFurniture.some(f => f.itemId === "shower" || f.itemId === "bathtub");
      if (!hasToilet || !hasSink || !hasShowerOrTub) {
        // Remove non-functional ensuite
        const idx = layout.rooms.indexOf(ensuiteRoom);
        if (idx >= 0) layout.rooms.splice(idx, 1);
        // Remove its door
        layout.doors = layout.doors.filter(d => d.room !== "Ensuite");
        // Remove its furniture
        for (let i = furniture.length - 1; i >= 0; i--) {
          if (furniture[i].room === "Ensuite") furniture.splice(i, 1);
        }
        const missing = [!hasToilet && "toilet", !hasSink && "sink", !hasShowerOrTub && "shower/bathtub"]
          .filter(Boolean).join(", ");
        console.warn(`[ensuite] ⚠️ removed — master too tight for functional ensuite (missing: ${missing}).`);
      }
    }

    // Validate: check which requested rooms couldn't fit
    const warnings = validateRoomPlacement(input.description, parsed as AbstractPlan, layout.rooms);

    // Total area: interior rooms only (exclude hallway, porch, balcony — extensions are extra)
    const interiorArea = layout.rooms
      .filter(r => !/hallway|porch|balcony/i.test(r.name))
      .reduce((s, r) => s + r.area, 0);

    return {
      rooms: layout.rooms,
      doors: layout.doors,
      windows: layout.windows,
      totalArea: parseFloat(interiorArea.toFixed(1)),
      sustainabilityScore: parsed.sustainabilityScore || { light: 0.7, ventilation: 0.7, energy: 0.7, overall: 0.7 },
      costEstimate: parsed.costEstimate || { low: 50000, high: 80000, currency: "USD" },
      placedFurniture: furniture,
      buildingPolygon: layout.buildingPolygon,
      entranceApproach: layout.entranceApproach,
      raw,
      warnings,
    };
  }

  // Legacy format
  const legacyRooms: GeneratedRoom[] = parsed.rooms || [];
  const legacyDoors: Door[] = parsed.doors || [];
  const legacyWindows: Window[] = parsed.windows || [];
  const legacyFurniture = suggestFurniture(legacyRooms, legacyDoors, legacyWindows);
  // Validate against user description
  const legacyWarnings = validateRoomPlacement(
    input.description,
    { totalArea: 0, hallwayWidth: 1.2, hallwaySide: "center", zones: {}, roomRatios: {}, exteriorExtensions: {} },
    legacyRooms
  );

  return {
    rooms: legacyRooms,
    doors: parsed.doors || [],
    windows: parsed.windows || [],
    totalArea: legacyRooms.reduce(
      (sum: number, r: GeneratedRoom) => sum + r.area,
      0
    ),
    sustainabilityScore: parsed.sustainabilityScore || { light: 0.7, ventilation: 0.7, energy: 0.7, overall: 0.7 },
    costEstimate: parsed.costEstimate || { low: 50000, high: 80000, currency: "USD" },
    placedFurniture: legacyFurniture,
    raw,
    warnings: legacyWarnings,
  };
}

/* ------------------------------------------------------------------ */
/*  Validation: check which requested rooms couldn't be placed         */
/* ------------------------------------------------------------------ */

function validateRoomPlacement(
  userDescription: string,
  plan: AbstractPlan,
  placedRooms: GeneratedRoom[]
): string[] {
  const warnings: string[] = [];
  const desc = userDescription.toLowerCase();

  // ── 0. Check if total area is unreasonably small ──
  // Studios are exempt — they are naturally compact (25-40m²)
  const isStudioPlan = /studio/i.test(desc) || Object.values(plan.zones).flat().some(n => /studio/i.test(n));
  // 1-bedroom homes are compact (35-60m²) — different limits than 2+ bedroom
  const wordNums: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5" };
  const bedMatch = desc.match(/(\d+|one|two|three|four|five)\s*-?\s*bed(?:room)?/i);
  const bedCount = bedMatch ? (wordNums[bedMatch[1].toLowerCase()] || bedMatch[1]) : null;
  const isOneBed = bedCount === "1";
  const minArea = isOneBed ? 35 : 60;
  const defaultArea = isOneBed ? 45 : 100;
  if (plan.totalArea < minArea && !isStudioPlan) {
    warnings.push(
      `⚠️ The generated plan has only ${plan.totalArea}m² total area (minimum usable is ${minArea}m²). ` +
      `The layout has been scaled up to ${defaultArea}m². Please specify a larger area in your description (e.g., "${defaultArea} square meters").`
    );
  }

  // ── 1. Detect rooms the USER explicitly asked for ──
  // Porches, verandas, and balconies are exterior extensions — they sit OUTSIDE
  // the building footprint and don't consume interior area. Don't show
  // user-facing "couldn't fit" warnings for them.
  const exteriorPattern = /porch|veranda|terrace|balcony/i;

  const userRequested: Array<{ keyword: RegExp; label: string }> = [
    { keyword: /garage|carport|parking/i, label: "Garage / Parking" },
    { keyword: /dining|dinner/i, label: "Dining room" },
    { keyword: /office|study|workspace|work room/i, label: "Home office / Study" },
    { keyword: /laundry|utility|wash room/i, label: "Laundry / Utility room" },
    { keyword: /ensuite|en-suite|master bath/i, label: "Ensuite bathroom" },
    { keyword: /walk-in|walk in|closet|wardrobe/i, label: "Walk-in closet" },
    { keyword: /guest/i, label: "Guest room" },
    { keyword: /pantry|storage/i, label: "Pantry / Storage" },
  ];

  const placedLower = placedRooms.map(r => r.name.toLowerCase());

  for (const { keyword, label } of userRequested) {
    if (keyword.test(desc)) {
      const found = placedLower.some(name => keyword.test(name));
      if (!found) {
        warnings.push(
          `You asked for a "${label}" but it couldn't fit in this floor plan. ` +
          `Try increasing the total area or reducing other rooms.`
        );
      }
    }
  }

  // ── 1a. Check porches/balconies (exterior extensions, not interior rooms) ──
  if (exteriorPattern.test(desc)) {
    const found = placedLower.some(name => exteriorPattern.test(name));
    if (!found) {
      console.log(`[validate] user asked for porch/balcony but none was placed — extension may have had no suitable host`);
    }
  }

  // ── 1b. Check bedroom & bathroom counts ──
  const bedCountMatch = desc.match(/(\d+)\s*-?\s*bed(?:room)?s?/i);
  const bathCountMatch = desc.match(/(\d+)\s*-?\s*bath(?:room)?s?/i);

  if (bedCountMatch) {
    const requested = parseInt(bedCountMatch[1]);
    let placed = placedLower.filter(n => /bedroom|master|studio/i.test(n) && !/bathroom/i.test(n)).length;
    if (placed < requested) {
      warnings.push(
        `You asked for ${requested} bedroom${requested > 1 ? "s" : ""} but only ${placed} could fit. ` +
        `Try increasing the total area.`
      );
    }
  }

  if (bathCountMatch) {
    const requested = parseInt(bathCountMatch[1]);
    const placed = placedLower.filter(n => /bathroom|ensuite|powder|wc/i.test(n)).length;
    if (placed < requested) {
      warnings.push(
        `You asked for ${requested} bathroom${requested > 1 ? "s" : ""} but only ${placed} could fit. ` +
        `Try increasing the total area.`
      );
    }
  }

  // ── 2. Detect rooms the AI added that user DIDN'T ask for ──
  const autoAddedPatterns: Array<{ regex: RegExp; label: string; userMustAsk: RegExp }> = [
    { regex: /dining/i, label: "Dining room", userMustAsk: /dining|dinner/i },
  ];

  for (const { regex, label, userMustAsk } of autoAddedPatterns) {
    const wasPlaced = placedLower.some(name => regex.test(name));
    const userAsked = userMustAsk.test(desc);
    if (wasPlaced && !userAsked) {
      warnings.push(
        `A "${label}" was added but you didn't request one. ` +
        `Kitchens often serve as dining areas — try omitting the dining room to free up space for other rooms.`
      );
    }
  }

  // ── 3. Check for rooms that are unusually small (under 4m²) ──
  for (const room of placedRooms) {
    if (room.area < 4 && !/hallway|corridor|foyer|porch|balcony/i.test(room.name)) {
      warnings.push(
        `"${room.name}" is only ${room.area.toFixed(1)}m² — very tight. ` +
        `Consider a larger total area for more comfortable room sizes.`
      );
    }
  }

  return warnings;
}
