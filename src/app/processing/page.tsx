"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import ProcessingScreen from "@/components/ProcessingScreen";
import type { FloorPlanResult } from "@/lib/ai-client";

export default function ProcessingPage() {
  const router = useRouter();
  const [result, setResult] = useState<FloorPlanResult | null>(null);
  const [error, setError] = useState("");

  const fetchPlan = useCallback(async () => {
    try {
      const raw = sessionStorage.getItem("archInput");
      if (!raw) {
        router.push("/input");
        return;
      }

      const input = JSON.parse(raw);

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: input.description || "A 2-bedroom modern apartment",
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate floor plan");
      }

      const data: FloorPlanResult = await res.json();
      setResult(data);
      sessionStorage.setItem("archResult", JSON.stringify(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }, [router]);

  useEffect(() => {
    fetchPlan();
  }, [fetchPlan]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4">
        <div className="text-5xl">😞</div>
        <h2 className="text-xl font-semibold text-zinc-800">Something went wrong</h2>
        <p className="text-zinc-500 text-center max-w-md">{error}</p>
        <button
          onClick={() => router.push("/input")}
          className="rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 transition-colors"
        >
          ← Try Again
        </button>
      </div>
    );
  }

  if (result) {
    // Navigate to results
    router.push("/results");
    return null;
  }

  return <ProcessingScreen onComplete={() => {}} />;
}
