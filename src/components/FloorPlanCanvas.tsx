"use client";

import { GeneratedRoom } from "@/lib/ai-client";

interface FloorPlanCanvasProps {
  rooms: GeneratedRoom[];
  viewMode: "2d" | "3d";
  onRoomHover?: (room: GeneratedRoom | null) => void;
}

const ROOM_COLORS: Record<string, string> = {
  "Living Room": "#FDE68A",
  Kitchen: "#FCA5A5",
  Bedroom: "#A5B4FC",
  Bathroom: "#86EFAC",
  Dining: "#D8B4FE",
  Hallway: "#E5E7EB",
  Office: "#FED7AA",
  default: "#CBD5E1",
};

function getRoomColor(name: string): string {
  for (const [key, color] of Object.entries(ROOM_COLORS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return ROOM_COLORS.default;
}

export default function FloorPlanCanvas({
  rooms,
  viewMode,
  onRoomHover,
}: FloorPlanCanvasProps) {
  if (rooms.length === 0) return null;

  const padding = 20;
  const canvasSize = 500;
  const maxCoord = Math.max(
    ...rooms.map((r) => Math.max(r.x + r.width, r.y + r.height)),
    10
  );
  const scale = (canvasSize - padding * 2) / maxCoord;

  return (
    <div className="relative w-full aspect-square max-w-[500px] mx-auto bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden">
      {/* Grid background */}
      <svg
        viewBox={`0 0 ${canvasSize} ${canvasSize}`}
        className="absolute inset-0 w-full h-full"
      >
        <defs>
          <pattern
            id="grid"
            width={20 * scale}
            height={20 * scale}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${20 * scale} 0 L 0 0 0 ${20 * scale}`}
              fill="none"
              stroke="#e5e7eb"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Rooms */}
      <svg
        viewBox={`0 0 ${canvasSize} ${canvasSize}`}
        className="absolute inset-0 w-full h-full"
      >
        {rooms.map((room, i) => {
          const x = padding + room.x * scale;
          const y = padding + room.y * scale;
          const w = room.width * scale;
          const h = room.height * scale;

          return (
            <g
              key={i}
              onMouseEnter={() => onRoomHover?.(room)}
              onMouseLeave={() => onRoomHover?.(null)}
              className="cursor-pointer transition-opacity hover:opacity-80"
            >
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill={getRoomColor(room.name)}
                stroke="#374151"
                strokeWidth="1.5"
                rx="4"
              />
              <text
                x={x + w / 2}
                y={y + h / 2 - 4}
                textAnchor="middle"
                className="text-[10px] font-semibold fill-zinc-800"
              >
                {room.name}
              </text>
              <text
                x={x + w / 2}
                y={y + h / 2 + 12}
                textAnchor="middle"
                className="text-[9px] fill-zinc-500"
              >
                {room.area.toFixed(1)}m²
              </text>
              {/* Door indicator */}
              <rect
                x={x + w / 2 - 6}
                y={y + h - 4}
                width="12"
                height="4"
                fill="#374151"
                rx="1"
              />
            </g>
          );
        })}
      </svg>

      {viewMode === "3d" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/5 backdrop-blur-sm">
          <div className="text-center text-zinc-500">
            <div className="text-4xl mb-2">🏗️</div>
            <p className="font-medium">3D View</p>
            <p className="text-sm">Coming soon with Three.js</p>
          </div>
        </div>
      )}
    </div>
  );
}
