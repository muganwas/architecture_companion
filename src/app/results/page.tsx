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
  const [hoveredFurniture, setHoveredFurniture] = useState<{ name: string; room: string } | null>(null);

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
      <div className="flex items-center justify-center min-h-[60vh] bg-[#f4f5f7]">
        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 bg-[#f4f5f7]">
      {/* Top bar */}
      <header className="px-6 py-4 border-b border-zinc-200/60 flex items-center gap-4 flex-wrap bg-white">
        <Link href="/input" className="text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-medium">
          ← New Plan
        </Link>
        <h1 className="text-lg font-semibold text-zinc-900">Your Floor Plan</h1>

        {/* View toggle + Refine */}
        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/review"
            className="px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          >
            Refine Prompt
          </Link>
          <div className="flex rounded-lg border border-zinc-200 overflow-hidden">
          <button
            onClick={() => setViewMode("2d")}
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${
              viewMode === "2d"
                ? "bg-zinc-800 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            2D
          </button>
          <button
            onClick={() => setViewMode("3d")}
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${
              viewMode === "3d"
                ? "bg-zinc-800 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            3D
          </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col lg:flex-row gap-6 p-6">
        {/* Canvas */}
        <div className="flex-1 flex flex-col items-center gap-4">
          {/* Validation warnings — advisory only */}
          {result.warnings && result.warnings.length > 0 && (
            <div className="w-full max-w-[640px] bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="flex items-start gap-2.5">
                <svg className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-amber-800 mb-1.5">Advisory Notes</p>
                  <ul className="space-y-1">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="text-xs text-amber-700">{w}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          <FloorPlanCanvas
            rooms={result.rooms}
            doors={result.doors || []}
            windows={result.windows || []}
            placedFurniture={result.placedFurniture}
            buildingPolygon={result.buildingPolygon}
            viewMode={viewMode}
            onRoomHover={setHoveredRoom}
            onFurnitureHover={setHoveredFurniture}
          />

          {/* Hover info */}
          {hoveredRoom && (
            <div className="text-sm text-zinc-700 bg-white rounded-lg px-4 py-2 border border-zinc-200/60">
              <span className="font-semibold text-zinc-900">{hoveredRoom.name}</span>:{" "}
              {hoveredRoom.width}m × {hoveredRoom.height}m —{" "}
              {hoveredRoom.area.toFixed(1)}m²
            </div>
          )}
          {hoveredFurniture && (
            <div className="text-sm text-zinc-700 bg-white rounded-lg px-4 py-2 border border-blue-300 shadow-sm">
              🪑 <span className="font-semibold text-zinc-900">{hoveredFurniture.name}</span>
              <span className="text-zinc-500 ml-2">in {hoveredFurniture.room}</span>
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
