"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import ProcessingScreen from "@/components/ProcessingScreen";
import type { FloorPlanResult } from "@/lib/ai-client";

export default function ProcessingPage() {
  const router = useRouter();
  const [result, setResult] = useState<FloorPlanResult | null>(null);
  const [error, setError] = useState("");
  const fetching = useRef(false);

  useEffect(() => {
    if (fetching.current) return;
    fetching.current = true;

    const raw = sessionStorage.getItem("archInput");
    if (!raw) {
      router.push("/input");
      return;
    }

    const input = JSON.parse(raw);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: input.description || "A 2-bedroom modern apartment",
        areaM2: input.areaM2 || undefined,
        isGroundFloor: input.isGroundFloor ?? true,
        emergencyExit: input.emergencyExit ?? false,
        kitchenLivingConnection: input.kitchenLivingConnection ?? "open",
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to generate floor plan");
        }
        return res.json();
      })
      .then((data: FloorPlanResult) => {
        setResult(data);
        sessionStorage.setItem("archResult", JSON.stringify(data));
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Something went wrong");
      });
  }, [router]);

  // Navigate in an effect, not during render
  useEffect(() => {
    if (result) {
      router.push("/results");
    }
  }, [result, router]);

  // Navigate in an effect, not during render
  useEffect(() => {
    if (result) {
      router.push("/results");
    }
  }, [result, router]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4 bg-[#f4f5f7]">
        <svg className="w-12 h-12 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <h2 className="text-xl font-semibold text-zinc-900">Something went wrong</h2>
        <p className="text-zinc-600 text-center max-w-md">{error}</p>
        <button
          onClick={() => router.push("/input")}
          className="rounded-lg bg-blue-600 px-6 py-2 text-white font-medium hover:bg-blue-700 transition-colors"
        >
          ← Try Again
        </button>
      </div>
    );
  }

  // Show processing animation while fetching
  if (!result && !error) {
    return <ProcessingScreen onComplete={() => {}} />;
  }

  // Loading / transitioning
  return null;
}
