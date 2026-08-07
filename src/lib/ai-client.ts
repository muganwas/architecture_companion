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
            `You are an architectural planner. Output valid JSON only, no markdown.\n\nReturn this abstract plan format (the layout engine computes coordinates):\n${ABSTRACT_PLAN_FORMAT}\n\nCRITICAL RULES:\n- totalArea MUST be at least 60m². A 2-bedroom house needs at least 80m², 3-bedroom at least 100m². Never return less than 60m².\n- Only include rooms the user explicitly asked for. Do NOT invent rooms (no auto-dining, no auto-guest).\n- If the user asks for N bedrooms, you MUST include exactly N bedrooms (Master Bedroom counts as 1). Count and verify.\n- If the user asks for N bathrooms, Ensuite COUNTS as a bathroom. So "2 bathrooms" with a master = 1 Ensuite + 1 Bathroom. NEVER create duplicate room names.\n- If user asks for a garage, you MUST include it in frontLeft or frontRight zone. It is required, not optional.\n- Master bedroom must always be in backLeft or backRight zone.\n- Living room must be in frontLeft or frontRight (it's the face of the house).\n- No single room should exceed 22% of totalArea. Living room and garage are largest at 18-22%.\n\nDETAILED RULES:\n- totalArea in m². Convert sq ft (÷10.764). If user specifies sq ft, convert to m².\n- hallwaySide: "center", "left", or "right".\n- zones: room names by column. Available slots: frontLeft, leftMiddle, backLeft, frontRight, rightMiddle, backRight.\n- roomRatios: fraction of totalArea for each room. Sum to 1.0 (excl. extensions).\n  Smallest (2-5%): Bathroom, Ensuite, Porch.\n  Medium (8-14%): Bedrooms, Kitchen.\n  Largest (16-22%): Living Room, Garage. Living Room always largest.\n  1 bath → in any back zone. 2 baths (including ensuite) → spread across different zones.\n  Ensuite ONLY with Master Bedroom in same zone.\n- exteriorExtensions: Porch=front, Balcony=right/left/back.\n- If user requested dining, place Kitchen + Dining on same side.\n- If user requested garage, place in frontLeft or frontRight. Garage MUST be included if asked.\n- roomShapes (optional): "rectangle", "l-shape", "bay-window", "angled-corner".`,
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

    // Validate: check which requested rooms couldn't fit
    const warnings = validateRoomPlacement(input.description, parsed as AbstractPlan, layout.rooms);

    return {
      rooms: layout.rooms,
      doors: layout.doors,
      windows: layout.windows,
      totalArea: layout.rooms.reduce((s, r) => s + r.area, 0),
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
  if (plan.totalArea < 60) {
    warnings.push(
      `⚠️ The generated plan has only ${plan.totalArea}m² total area (minimum usable is 60m²). ` +
      `The layout has been scaled up to 100m². Please specify a larger area in your description (e.g., "100 square meters").`
    );
  }

  // ── 1. Detect rooms the USER explicitly asked for ──
  const userRequested: Array<{ keyword: RegExp; label: string }> = [
    { keyword: /garage|carport|parking/i, label: "Garage / Parking" },
    { keyword: /dining|dinner/i, label: "Dining room" },
    { keyword: /office|study|workspace|work room/i, label: "Home office / Study" },
    { keyword: /laundry|utility|wash room/i, label: "Laundry / Utility room" },
    { keyword: /ensuite|en-suite|master bath/i, label: "Ensuite bathroom" },
    { keyword: /walk-in|walk in|closet|wardrobe/i, label: "Walk-in closet" },
    { keyword: /porch|veranda|terrace/i, label: "Porch / Veranda" },
    { keyword: /balcony/i, label: "Balcony" },
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

  // ── 1b. Check bedroom & bathroom counts ──
  const bedCountMatch = desc.match(/(\d+)\s*-?\s*bed(?:room)?s?/i);
  const bathCountMatch = desc.match(/(\d+)\s*-?\s*bath(?:room)?s?/i);

  if (bedCountMatch) {
    const requested = parseInt(bedCountMatch[1]);
    const placed = placedLower.filter(n => /bedroom|master/i.test(n) && !/bathroom/i.test(n)).length;
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
