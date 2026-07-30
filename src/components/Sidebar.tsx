"use client";

import type { FloorPlanResult } from "@/lib/ai-client";

interface SidebarProps {
  result: FloorPlanResult;
  style: string;
  onStyleChange: (style: string) => void;
  onRegenerate: () => void;
}

export default function Sidebar({
  result,
  style,
  onStyleChange,
  onRegenerate,
}: SidebarProps) {
  const scorePercent = Math.round(result.sustainabilityScore.overall * 100);

  return (
    <aside className="w-full lg:w-80 space-y-6">
      {/* Style Switcher */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <label className="text-sm font-semibold text-zinc-700 block mb-2">
          🎨 Style
        </label>
        <select
          value={style}
          onChange={(e) => onStyleChange(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="modern">Modern</option>
          <option value="rustic">Rustic</option>
          <option value="minimalist">Minimalist</option>
        </select>
        <button
          onClick={onRegenerate}
          className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          🔄 Try New Variation
        </button>
      </div>

      {/* Room List */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <h3 className="text-sm font-semibold text-zinc-700 mb-3">📐 Rooms</h3>
        <ul className="space-y-2">
          {result.rooms.map((room, i) => (
            <li
              key={i}
              className="flex justify-between items-center text-sm py-1.5 px-2 rounded-lg bg-zinc-50"
            >
              <span className="font-medium text-zinc-800">{room.name}</span>
              <span className="text-zinc-500">
                {room.width}m × {room.height}m ({room.area.toFixed(1)}m²)
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 pt-3 border-t border-zinc-100 flex justify-between text-sm">
          <span className="font-semibold text-zinc-700">Total Area</span>
          <span className="text-zinc-800">{result.totalArea.toFixed(1)}m²</span>
        </div>
      </div>

      {/* Sustainability Score */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <h3 className="text-sm font-semibold text-zinc-700 mb-3">♻️ Sustainability</h3>
        <div className="flex items-center gap-3 mb-3">
          <div className="relative w-16 h-16">
            <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
              <circle
                cx="32"
                cy="32"
                r="28"
                fill="none"
                stroke="#e5e7eb"
                strokeWidth="6"
              />
              <circle
                cx="32"
                cy="32"
                r="28"
                fill="none"
                stroke={scorePercent >= 70 ? "#22c55e" : scorePercent >= 40 ? "#f59e0b" : "#ef4444"}
                strokeWidth="6"
                strokeDasharray={`${scorePercent * 1.76} 176`}
                strokeLinecap="round"
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-lg font-bold text-zinc-800">
              {scorePercent}
            </span>
          </div>
          <div className="text-sm space-y-1">
            <div>☀️ Light: {Math.round(result.sustainabilityScore.light * 100)}%</div>
            <div>🌬️ Ventilation: {Math.round(result.sustainabilityScore.ventilation * 100)}%</div>
            <div>⚡ Energy: {Math.round(result.sustainabilityScore.energy * 100)}%</div>
          </div>
        </div>
      </div>

      {/* Cost Estimate */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <h3 className="text-sm font-semibold text-zinc-700 mb-3">💰 Cost Estimate</h3>
        <p className="text-2xl font-bold text-zinc-800">
          {result.costEstimate.low.toLocaleString()} –{" "}
          {result.costEstimate.high.toLocaleString()}{" "}
          <span className="text-sm font-normal text-zinc-500">
            {result.costEstimate.currency}
          </span>
        </p>
        <p className="text-xs text-zinc-400 mt-1">Basic tier estimate</p>
      </div>

      {/* Export */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <h3 className="text-sm font-semibold text-zinc-700 mb-3">📤 Export</h3>
        <div className="space-y-2">
          <button className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 transition-colors text-left">
            📸 Download PNG / SVG
          </button>
          <button className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 transition-colors text-left">
            📐 Export to CAD / BIM
          </button>
          <button className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 transition-colors text-left">
            🔗 Share Link
          </button>
        </div>
      </div>
    </aside>
  );
}
