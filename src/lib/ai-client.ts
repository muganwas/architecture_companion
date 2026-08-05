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
  raw: string;
}

const ABSTRACT_PLAN_FORMAT = `{
  "totalArea": 140,
  "hallwayWidth": 1.2,
  "hallwaySide": "center",
  "zones": {
    "frontLeft": ["Garage"],
    "leftMiddle": ["Kitchen"],
    "backLeft": ["Master Bedroom", "Ensuite"],
    "frontRight": ["Living Room"],
    "rightMiddle": ["Dining"],
    "backRight": ["Bedroom 2", "Bathroom"]
  },
  "roomRatios": {
    "Living Room": 0.25, "Kitchen": 0.11, "Master Bedroom": 0.14,
    "Bedroom 2": 0.10, "Bathroom": 0.05, "Ensuite": 0.04,
    "Dining": 0.10, "Garage": 0.21
  },
  "exteriorExtensions": { "Porch": "front", "Balcony": "right" },
  "roomShapes": { "Living Room": "bay-window", "Master Bedroom": "angled-corner", "Dining": "l-shape" },
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
            `You are an architectural planner. Output valid JSON only, no markdown.\n\nReturn this abstract plan format (the layout engine computes coordinates):\n${ABSTRACT_PLAN_FORMAT}\n\nRULES:\n- totalArea in m². Convert sq ft (÷10.764).\n- hallwaySide: "center", "left", or "right".\n- zones: room names in each column. Available: frontLeft, leftMiddle, backLeft, frontRight, rightMiddle, backRight.\n- roomRatios: fraction of totalArea for each room. Sum to 1.0 (excl. exterior extensions).\n  Smallest (2-5%): Bathroom, Ensuite, Porch.\n  Medium (8-12%): Bedrooms, Kitchen, Dining.\n  Largest (18-25%): Living Room, Garage. Living Room always largest.\n  Garage ≤ Living Room ratio.\n  1 bath → backRight/backLeft. 2+ baths → 1 near bedrooms + 1 near front.\n  Ensuite ONLY with Master Bedroom in same back zone.\n- exteriorExtensions: Porch=front, Balcony=right/left/back.\n- All bedrooms in backLeft/backRight.\n- Kitchen + Dining on same side (both left or both right).\n- roomShapes (optional): creative shapes for rooms. Values: "rectangle", "l-shape", "bay-window", "angled-corner".\n  Living rooms on exterior → "bay-window". Master bedrooms → "angled-corner". Dining rooms → "l-shape". Kitchens on exterior → "bay-window".`,
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

  const prompt = `USER REQUEST: "${input.description}"\nStyle: ${style} | Budget: ${budget}\n\nReturn the abstract plan JSON. No coordinates — the layout engine handles geometry.`;

  const raw = await callOpenAI(config, prompt);
  const parsed = JSON.parse(raw);

  // Try abstract plan format (layout engine), fall back to legacy coordinates
  if (parsed.zones && parsed.roomRatios) {
    const layout = computeLayout(parsed as AbstractPlan);
    const furniture = suggestFurniture(layout.rooms);

    return {
      rooms: layout.rooms,
      doors: layout.doors,
      windows: layout.windows,
      totalArea: layout.rooms.reduce((s, r) => s + r.area, 0),
      sustainabilityScore: parsed.sustainabilityScore || { light: 0.7, ventilation: 0.7, energy: 0.7, overall: 0.7 },
      costEstimate: parsed.costEstimate || { low: 50000, high: 80000, currency: "USD" },
      placedFurniture: furniture,
      raw,
      warnings: [],
    };
  }

  // Legacy format
  const legacyRooms: GeneratedRoom[] = parsed.rooms || [];
  const legacyFurniture = suggestFurniture(legacyRooms);

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
    warnings: [],
  };
}
