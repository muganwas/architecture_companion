type AIProvider = "openai" | "deepseek";

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
}

export interface FloorPlanResult {
  rooms: GeneratedRoom[];
  totalArea: number;
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
  raw: string;
}

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
            "You are an architectural AI assistant. You generate floor plans as structured JSON. Always respond with valid JSON only, no markdown.",
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

  const prompt = `
Generate a floor plan for a building with the following description:
"${input.description}"

Style: ${style}
Budget tier: ${budget}

Respond with a JSON object in this exact structure:
{
  "rooms": [
    { "name": "Living Room", "width": 5.0, "height": 4.0, "x": 0, "y": 0, "area": 20.0 }
  ],
  "sustainabilityScore": { "light": 0.8, "ventilation": 0.7, "energy": 0.75, "overall": 0.75 },
  "costEstimate": { "low": 50000, "high": 80000, "currency": "USD" }
}

Rules:
- Arrange rooms logically (living room near entrance, kitchen near dining, bedrooms private)
- Room dimensions in meters
- x,y coordinates for a top-down 2D layout origin at (0,0)
- sustainabilityScore values from 0.0 to 1.0
- costEstimate in USD based on the budget tier
- Include at minimum: living room, kitchen, bedroom, bathroom
- Total layout should fit within 20m x 20m
`.trim();

  const raw = await callOpenAI(config, prompt);
  const parsed = JSON.parse(raw);

  return {
    rooms: parsed.rooms,
    totalArea: parsed.rooms.reduce(
      (sum: number, r: GeneratedRoom) => sum + r.area,
      0
    ),
    sustainabilityScore: parsed.sustainabilityScore,
    costEstimate: parsed.costEstimate,
    raw,
  };
}
