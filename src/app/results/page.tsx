"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import FloorPlanCanvas from "@/components/FloorPlanCanvas";
import Sidebar from "@/components/Sidebar";
import type { FloorPlanResult, GeneratedRoom } from "@/lib/ai-client";

export default function ResultsPage() {
  const router = useRouter();
  const [result, setResult] = useState<FloorPlanResult | null>(null);
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [style, setStyle] = useState("modern");
  const [hoveredRoom, setHoveredRoom] = useState<GeneratedRoom | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("archResult");
    if (!raw) {
      router.push("/input");
      return;
    }
    setResult(JSON.parse(raw));
  }, [router]);

  const handleRegenerate = () => {
    router.push("/processing");
  };

  if (!result) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1">
      {/* Top bar */}
      <header className="px-6 py-4 border-b border-zinc-200 flex items-center gap-4 flex-wrap">
        <Link href="/input" className="text-zinc-500 hover:text-zinc-800 transition-colors">
          ← New Plan
        </Link>
        <h1 className="text-lg font-semibold text-zinc-800">Your Floor Plan</h1>

        {/* View toggle */}
        <div className="ml-auto flex rounded-lg border border-zinc-200 overflow-hidden">
          <button
            onClick={() => setViewMode("2d")}
            className={`px-4 py-1.5 text-sm ${
              viewMode === "2d"
                ? "bg-zinc-800 text-white"
                : "text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            2D
          </button>
          <button
            onClick={() => setViewMode("3d")}
            className={`px-4 py-1.5 text-sm ${
              viewMode === "3d"
                ? "bg-zinc-800 text-white"
                : "text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            3D
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col lg:flex-row gap-6 p-6">
        {/* Canvas */}
        <div className="flex-1 flex flex-col items-center gap-4">
          <FloorPlanCanvas
            rooms={result.rooms}
            viewMode={viewMode}
            onRoomHover={setHoveredRoom}
          />

          {/* Hover info */}
          {hoveredRoom && (
            <div className="text-sm text-zinc-600 bg-zinc-50 rounded-lg px-4 py-2 border border-zinc-200">
              <span className="font-semibold">{hoveredRoom.name}</span>:{" "}
              {hoveredRoom.width}m × {hoveredRoom.height}m —{" "}
              {hoveredRoom.area.toFixed(1)}m²
            </div>
          )}
        </div>

        {/* Sidebar */}
        <Sidebar
          result={result}
          style={style}
          onStyleChange={setStyle}
          onRegenerate={handleRegenerate}
        />
      </main>
    </div>
  );
}
