export interface PromptAnalysis {
  found: string[];
  missing: string[];
  defaults: { label: string; value: string }[];
  summary: string;
  /** Converted area in m², if detected */
  areaM2?: number;
  /** Original area string the user provided */
  areaOriginal?: string;
}

export function analyzePrompt(description: string): PromptAnalysis {
  const desc = description.toLowerCase();
  const found: string[] = [];
  const missing: string[] = [];
  const defaults: { label: string; value: string }[] = [];

  // 1. Room count
  const bedMatch = desc.match(/(\d+)\s*-?\s*bed(?:room)?/i);
  const bathMatch = desc.match(/(\d+)\s*-?\s*bath(?:room)?/i);

  if (bedMatch) {
    found.push(`${bedMatch[1]} bedroom${bedMatch[1] !== "1" ? "s" : ""}`);
  } else {
    missing.push("Number of bedrooms");
    defaults.push({ label: "Bedrooms", value: "2 bedrooms (default)" });
  }

  if (bathMatch) {
    found.push(`${bathMatch[1]} bathroom${bathMatch[1] !== "1" ? "s" : ""}`);
  } else {
    missing.push("Number of bathrooms");
    defaults.push({ label: "Bathrooms", value: "1 bathroom (default)" });
  }

  // 2. House type
  const houseTypes = [
    "bungalow", "apartment", "flat", "cottage", "villa", "mansion",
    "studio", "duplex", "townhouse", "ranch", "cabin", "loft",
    "single-story", "single story", "single floor", "one story", "one floor",
    "two-story", "two story", "two floor", "2-story", "2 story", "double-story",
    "multi-story", "multi story", "split-level",
  ];

  const foundType = houseTypes.find(t => desc.includes(t));
  if (foundType) {
    found.push(`House type: ${foundType}`);
  } else {
    missing.push("House type (bungalow, apartment, etc.)");
    defaults.push({ label: "House type", value: "Single-story (default)" });
  }

  // 3. Total area / size — convert to m²
  let areaM2: number | undefined;
  let areaOriginal: string | undefined;

  const areaMatch = desc.match(/(\d+\.?\d*)\s*(sq\.?\s*(m|ft|meter|foot|feet)|square\s*(meter|foot|feet|m))/i);
  const sizeMatch = desc.match(/(\d+\.?\d*)\s*(m²|m2|sqm|sq\.?\s*ft|square\s*feet)/i);
  const genericSizeMatch = desc.match(/(?:about|around|approx(?:imately)?|roughly)\s*(\d+\.?\d*)\s*(?:sq|square|m)/i);

  if (areaMatch || sizeMatch || genericSizeMatch) {
    const m = (areaMatch || sizeMatch || genericSizeMatch)!;
    const rawValue = parseFloat(m[1]);
    const unitStr = (m[2] || m[3] || "").toLowerCase();

    // Determine if it's sq ft
    const isSqFt = /ft|foot|feet/i.test(unitStr);

    if (isSqFt) {
      areaM2 = parseFloat((rawValue / 10.764).toFixed(1));
      areaOriginal = `${rawValue} sq ft`;
      found.push(`Area: ${rawValue} sq ft → ${areaM2} m²`);
    } else {
      areaM2 = rawValue;
      areaOriginal = `${rawValue} m²`;
      found.push(`Area: ${rawValue} m²`);
    }
  } else {
    missing.push("Total area / size");
    defaults.push({ label: "Total area", value: "~100m² (default)" });
  }

  // 4. Special features
  const features = [
    { keyword: /porch|veranda|terrace/, label: "Porch/Veranda/Terrace" },
    { keyword: /garage|carport|parking/, label: "Garage/Parking" },
    { keyword: /garden|yard|backyard|outdoor/, label: "Garden/Outdoor space" },
    { keyword: /office|study|workspace|work room/, label: "Home office/Study" },
    { keyword: /ensuite|en-suite|master bath/, label: "Ensuite bathroom" },
    { keyword: /walk-in|walk in|closet|wardrobe/, label: "Walk-in closet" },
    { keyword: /laundry|utility|wash room/, label: "Laundry/Utility room" },
    { keyword: /open.?plan|open.?floor/, label: "Open-plan layout" },
    { keyword: /balcony/, label: "Balcony" },
    { keyword: /guest|visitor/, label: "Guest room/area" },
    { keyword: /dining|dinner/, label: "Dining area" },
    { keyword: /storage|pantry/, label: "Storage/Pantry" },
  ];

  let foundFeatures = 0;
  for (const f of features) {
    if (f.keyword.test(desc)) {
      found.push(f.label);
      foundFeatures++;
    }
  }

  if (foundFeatures === 0) {
    missing.push("Special features (porch, garage, office, etc.)");
    defaults.push({ label: "Special features", value: "None specified" });
  }

  // 5. Style — defaults to "Modern" if not specified
  const styles = ["modern", "rustic", "minimalist", "traditional", "contemporary", "colonial", "mediterranean"];
  const foundStyle = styles.find(s => desc.includes(s));
  if (foundStyle) {
    found.push(`Style: ${foundStyle}`);
  } else {
    defaults.push({ label: "Architectural style", value: "Modern (default)" });
  }

  // 6. Entrance / orientation
  if (/(?:faces?|facing|oriented?|entrance)\s+(north|south|east|west)/i.test(desc)) {
    found.push("Orientation/entrance direction");
  }

  // Summary
  const summaryParts: string[] = [];
  if (bedMatch) summaryParts.push(`${bedMatch[1]} bedroom${bedMatch[1] !== "1" ? "s" : ""}`);
  else summaryParts.push("2 bedrooms");
  if (bathMatch) summaryParts.push(`${bathMatch[1]} bathroom${bathMatch[1] !== "1" ? "s" : ""}`);
  else summaryParts.push("1 bathroom");
  if (foundType) summaryParts.push(foundType);
  else summaryParts.push("single-story home");
  summaryParts.push(foundStyle ? `${foundStyle} style` : "Modern style");

  const summary = summaryParts.join(", ");

  return { found, missing, defaults, summary, areaM2, areaOriginal };
}
