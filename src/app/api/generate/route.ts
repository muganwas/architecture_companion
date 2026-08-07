import { NextRequest, NextResponse } from "next/server";
import { generateFloorPlan } from "@/lib/ai-client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { description, style, budget, areaM2, isGroundFloor, emergencyExit, kitchenLivingConnection } = body;

    if (!description || typeof description !== "string" || description.trim().length === 0) {
      return NextResponse.json(
        { error: "Description is required" },
        { status: 400 }
      );
    }

    const result = await generateFloorPlan({
      description: description.trim(),
      style: style || "modern",
      budget: budget || "standard",
      areaM2: areaM2 || undefined,
      isGroundFloor: isGroundFloor ?? true,
      emergencyExit: emergencyExit ?? false,
      kitchenLivingConnection: kitchenLivingConnection ?? "open",
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";
    console.error("Generate API error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
