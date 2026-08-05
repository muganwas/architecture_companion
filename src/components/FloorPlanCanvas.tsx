"use client";

import React, { useMemo, useState, useCallback } from "react";
import { Stage, Layer, Group, Rect, Line, Circle, Text } from "react-konva";
import { GeneratedRoom, Door, Window } from "@/lib/ai-client";
import { PlacedFurniture, getFurnitureById } from "@/lib/furniture";

/* ------------------------------------------------------------------ */
/*  Types & constants                                                  */
/* ------------------------------------------------------------------ */

interface FloorPlanCanvasProps {
  rooms: GeneratedRoom[];
  doors: Door[];
  windows: Window[];
  placedFurniture?: PlacedFurniture[];
  viewMode: "2d" | "3d";
  onRoomHover?: (room: GeneratedRoom | null) => void;
  onFurnitureHover?: (info: { name: string; room: string } | null) => void;
}

const STAGE_W = 700;
const STAGE_H = 700;
const PAD = 60;
const WALL = 3;

/* ---------- room fills ---------- */

const FILL: Record<string, string> = {
  hallway: "#ece8e0", corridor: "#ece8e0", foyer: "#ece8e0",
  "living room": "#f7f3eb", kitchen: "#faf6ef", bedroom: "#f2f0f0",
  "master bedroom": "#f2f0f0", bathroom: "#f5f4fa", ensuite: "#f5f4fa",
  dining: "#faf7ef", office: "#f2f5f0", laundry: "#f8f5f8", garage: "#ebebeb",
};

function fill(n: string) {
  const l = n.toLowerCase();
  for (const [k, v] of Object.entries(FILL)) if (l.includes(k)) return v;
  return "#f9f8f5";
}

/* ---------- geometry helpers ---------- */

interface BBox { x: number; y: number; w: number; h: number; }

function computeBBox(rooms: GeneratedRoom[]): BBox {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rooms) {
    if (r.x < x1) x1 = r.x; if (r.y < y1) y1 = r.y;
    if (r.x + r.width > x2) x2 = r.x + r.width;
    if (r.y + r.height > y2) y2 = r.y + r.height;
  }
  return { x: x1, y: y1, w: x2 - x1 || 10, h: y2 - y1 || 10 };
}

function computeScale(rooms: GeneratedRoom[]): { s: number; bb: BBox } {
  const bb = computeBBox(rooms);
  const drawW = STAGE_W - PAD * 2;
  const drawH = STAGE_H - PAD * 2;
  const s = Math.min(drawW / bb.w, drawH / bb.h);
  return { s, bb };
}

/** World coords → canvas pixel coords (Y flipped for screen) */
function toCanvas(wx: number, wy: number, s: number, bb: BBox): { x: number; y: number } {
  return { x: PAD + (wx - bb.x) * s, y: STAGE_H - PAD - (wy - bb.y) * s };
}

/** Get room center in world coords */
function roomCenter(room: GeneratedRoom): { x: number; y: number } {
  return { x: room.x + room.width / 2, y: room.y + room.height / 2 };
}

/** Build polygon for door gap (world coords → flat array) */
function doorGapPoly(room: GeneratedRoom, door: Door): Array<{ x: number; y: number }> {
  const { x: rx, y: ry, width: rw, height: rh } = room;
  const gapHw = door.width / 2;
  const off = door.offset;
  switch (door.wall) {
    case "bottom": return [
      { x: rx + off - gapHw, y: ry }, { x: rx + off + gapHw, y: ry },
      { x: rx + off + gapHw, y: ry - 0.08 }, { x: rx + off - gapHw, y: ry - 0.08 },
    ];
    case "top": return [
      { x: rx + off - gapHw, y: ry + rh }, { x: rx + off + gapHw, y: ry + rh },
      { x: rx + off + gapHw, y: ry + rh + 0.08 }, { x: rx + off - gapHw, y: ry + rh + 0.08 },
    ];
    case "left": return [
      { x: rx, y: ry + off - gapHw }, { x: rx - 0.08, y: ry + off - gapHw },
      { x: rx - 0.08, y: ry + off + gapHw }, { x: rx, y: ry + off + gapHw },
    ];
    case "right": return [
      { x: rx + rw, y: ry + off - gapHw }, { x: rx + rw + 0.08, y: ry + off - gapHw },
      { x: rx + rw + 0.08, y: ry + off + gapHw }, { x: rx + rw, y: ry + off + gapHw },
    ];
    default: return [];
  }
}

/** Flatten world-point array → Konva flat [x1,y1,x2,y2,...] in screen coords */
function worldToScreenFlat(
  pts: Array<{ x: number; y: number }>, s: number, bb: BBox
): number[] {
  const flat: number[] = [];
  for (const p of pts) {
    const sp = toCanvas(p.x, p.y, s, bb);
    flat.push(sp.x, sp.y);
  }
  return flat;
}

/** Rectangle corners → flat screen polygon */
function rectToScreenFlat(room: GeneratedRoom, s: number, bb: BBox): number[] {
  const corners = [
    { x: room.x, y: room.y },
    { x: room.x + room.width, y: room.y },
    { x: room.x + room.width, y: room.y + room.height },
    { x: room.x, y: room.y + room.height },
  ];
  return worldToScreenFlat(corners, s, bb);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function FloorPlanCanvas({
  rooms, doors, windows, placedFurniture, viewMode, onRoomHover, onFurnitureHover,
}: FloorPlanCanvasProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [hoveredFurnIdx, setHoveredFurnIdx] = useState<number | null>(null);

  const { s, bb } = useMemo(() => computeScale(rooms), [rooms]);
  const roomMap = useMemo(() => new Map(rooms.map(r => [r.name, r])), [rooms]);

  // Group rooms by name for compound shapes
  const grouped = useMemo(() => {
    const map = new Map<string, GeneratedRoom[]>();
    for (const r of rooms) {
      const k = r.name.toLowerCase();
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return Array.from(map.entries());
  }, [rooms]);

  // Furniture lookup
  const furnByRoom = useMemo(() => {
    const map = new Map<string, PlacedFurniture[]>();
    if (placedFurniture) {
      for (const pf of placedFurniture) {
        if (!map.has(pf.room)) map.set(pf.room, []);
        map.get(pf.room)!.push(pf);
      }
    }
    return map;
  }, [placedFurniture]);

  if (rooms.length === 0) return null;

  /* ================================================================ */
  /*  GRID LINES                                                       */
  /* ================================================================ */
  const grid1mLines: React.ReactElement[] = [];
  for (let wx = Math.floor(bb.x); wx <= bb.x + bb.w; wx++) {
    const p1 = toCanvas(wx, bb.y, s, bb);
    const p2 = toCanvas(wx, bb.y + bb.h, s, bb);
    grid1mLines.push(<Line key={`g1-${wx}`} points={[p1.x, p1.y, p2.x, p2.y]} stroke="#e8e4dc" strokeWidth={0.5} />);
  }
  for (let wy = Math.floor(bb.y); wy <= bb.y + bb.h; wy++) {
    const p1 = toCanvas(bb.x, wy, s, bb);
    const p2 = toCanvas(bb.x + bb.w, wy, s, bb);
    grid1mLines.push(<Line key={`g1y-${wy}`} points={[p1.x, p1.y, p2.x, p2.y]} stroke="#e8e4dc" strokeWidth={0.5} />);
  }

  const grid5mLines: React.ReactElement[] = [];
  for (let wx = Math.floor(bb.x / 5) * 5; wx <= bb.x + bb.w; wx += 5) {
    const p1 = toCanvas(wx, bb.y, s, bb);
    const p2 = toCanvas(wx, bb.y + bb.h, s, bb);
    grid5mLines.push(<Line key={`g5-${wx}`} points={[p1.x, p1.y, p2.x, p2.y]} stroke="#d4cfc6" strokeWidth={0.8} />);
  }
  for (let wy = Math.floor(bb.y / 5) * 5; wy <= bb.y + bb.h; wy += 5) {
    const p1 = toCanvas(bb.x, wy, s, bb);
    const p2 = toCanvas(bb.x + bb.w, wy, s, bb);
    grid5mLines.push(<Line key={`g5y-${wy}`} points={[p1.x, p1.y, p2.x, p2.y]} stroke="#d4cfc6" strokeWidth={0.8} />);
  }

  /* ================================================================ */
  /*  FURNITURE RENDER  —  TOP-DOWN PLAN VIEW                          */
  /* ================================================================ */
  const renderFurnitureItem = useCallback((pf: PlacedFurniture, i: number) => {
    const item = getFurnitureById(pf.itemId);
    if (!item) return null;

    const scaleW = item.width * pf.scale * s;
    const scaleH = item.height * pf.scale * s;
    const isRot = pf.rotation === 90 || pf.rotation === 270;
    const rw = isRot ? scaleH : scaleW;
    const rh = isRot ? scaleW : scaleH;
    const pos = toCanvas(pf.x, pf.y, s, bb);

    const cat = item.category;
    const fillC = item.fill;
    const strokeC = item.stroke;
    const sw = 1.2; // stroke width

    // All furniture drawn as seen FROM ABOVE (architectural plan view)

    const isHovered = hoveredFurnIdx === i;

    return (
      <Group key={`f-${i}`} x={pos.x} y={pos.y} offsetX={rw / 2} offsetY={rh / 2} rotation={pf.rotation} opacity={isHovered ? 1 : 0.88}
        onMouseEnter={() => { setHoveredFurnIdx(i); onFurnitureHover?.({ name: item.name, room: pf.room }); }}
        onMouseLeave={() => { setHoveredFurnIdx(null); onFurnitureHover?.(null); }}
      >

        {/* ============ SOFA 3-SEATER (top-down) ============ */}
        {pf.itemId === "sofa-3-seater" && (
          <>
            {/* Backrest — thick darker band at the back (wall side) */}
            <Rect x={0} y={0} width={rw} height={rh * 0.28} fill={strokeC} stroke={strokeC} strokeWidth={sw} cornerRadius={[4, 4, 0, 0]} opacity={0.7} />
            {/* Seat cushion area */}
            <Rect x={0} y={rh * 0.28} width={rw} height={rh * 0.72} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={[0, 0, 4, 4]} />
            {/* Left armrest */}
            <Rect x={0} y={rh * 0.28} width={rw * 0.1} height={rh * 0.72} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} cornerRadius={[0, 0, 0, 4]} />
            {/* Right armrest */}
            <Rect x={rw * 0.9} y={rh * 0.28} width={rw * 0.1} height={rh * 0.72} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} cornerRadius={[0, 0, 4, 0]} />
            {/* Three cushion seams */}
            <Line points={[rw * 0.33, rh * 0.32, rw * 0.33, rh * 0.92]} stroke={strokeC} strokeWidth={0.7} opacity={0.4} />
            <Line points={[rw * 0.66, rh * 0.32, rw * 0.66, rh * 0.92]} stroke={strokeC} strokeWidth={0.7} opacity={0.4} />
          </>
        )}

        {/* ============ SOFA 2-SEATER (top-down) ============ */}
        {pf.itemId === "sofa-2-seater" && (
          <>
            <Rect x={0} y={0} width={rw} height={rh * 0.28} fill={strokeC} stroke={strokeC} strokeWidth={sw} cornerRadius={[4, 4, 0, 0]} opacity={0.7} />
            <Rect x={0} y={rh * 0.28} width={rw} height={rh * 0.72} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={[0, 0, 4, 4]} />
            <Rect x={0} y={rh * 0.28} width={rw * 0.1} height={rh * 0.72} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} cornerRadius={[0, 0, 0, 4]} />
            <Rect x={rw * 0.9} y={rh * 0.28} width={rw * 0.1} height={rh * 0.72} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} cornerRadius={[0, 0, 4, 0]} />
            <Line points={[rw * 0.5, rh * 0.32, rw * 0.5, rh * 0.92]} stroke={strokeC} strokeWidth={0.7} opacity={0.4} />
          </>
        )}

        {/* ============ ARMCHAIR (top-down) ============ */}
        {pf.itemId === "armchair" && (
          <>
            {/* Square seat with armrests on both sides and thick back */}
            <Rect x={0} y={0} width={rw} height={rh * 0.25} fill={strokeC} stroke={strokeC} strokeWidth={sw} cornerRadius={[4, 4, 0, 0]} opacity={0.7} />
            <Rect x={0} y={rh * 0.25} width={rw} height={rh * 0.75} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={[0, 0, 4, 4]} />
            <Rect x={0} y={rh * 0.25} width={rw * 0.12} height={rh * 0.75} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} />
            <Rect x={rw * 0.88} y={rh * 0.25} width={rw * 0.12} height={rh * 0.75} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} />
          </>
        )}

        {/* ============ DINING CHAIR (top-down) ============ */}
        {pf.itemId === "dining-chair" && (
          <>
            {/* Seat square + thin backrest visible at one edge */}
            <Rect x={0} y={rh * 0.08} width={rw} height={rh * 0.84} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            <Rect x={rw * 0.1} y={0} width={rw * 0.8} height={rh * 0.12} fill={strokeC} stroke={strokeC} strokeWidth={0.5} cornerRadius={[3, 3, 0, 0]} opacity={0.6} />
            {/* 4 tiny leg dots at corners */}
            <Circle x={rw * 0.2} y={rh * 0.9} radius={rw * 0.06} fill={strokeC} opacity={0.4} />
            <Circle x={rw * 0.8} y={rh * 0.9} radius={rw * 0.06} fill={strokeC} opacity={0.4} />
          </>
        )}

        {/* ============ OFFICE CHAIR (top-down) ============ */}
        {pf.itemId === "office-chair" && (
          <>
            {/* Circular base */}
            <Circle x={rw / 2} y={rh * 0.6} radius={rw * 0.42} fill="none" stroke={strokeC} strokeWidth={1} opacity={0.4} />
            {/* 5-spoke base lines */}
            {[0, 72, 144, 216, 288].map((deg, j) => {
              const rad = (deg * Math.PI) / 180;
              return (
                <Line key={`spoke-${j}`}
                  points={[rw / 2, rh * 0.6, rw / 2 + Math.cos(rad) * rw * 0.38, rh * 0.6 + Math.sin(rad) * rw * 0.38]}
                  stroke={strokeC} strokeWidth={0.6} opacity={0.3} />
              );
            })}
            {/* Seat cushion */}
            <Rect x={rw * 0.15} y={rh * 0.15} width={rw * 0.7} height={rh * 0.4} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={5} />
            {/* Backrest */}
            <Rect x={rw * 0.2} y={0} width={rw * 0.6} height={rh * 0.2} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={[5, 5, 0, 0]} />
          </>
        )}

        {/* ============ DINING TABLE (top-down) ============ */}
        {(pf.itemId === "dining-table-6" || pf.itemId === "dining-table-4") && (
          <>
            <Rect x={rw * 0.02} y={rh * 0.02} width={rw * 0.96} height={rh * 0.96} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={6} />
            {/* Wood grain lines */}
            <Line points={[rw * 0.08, rh * 0.3, rw * 0.92, rh * 0.3]} stroke={strokeC} strokeWidth={0.6} opacity={0.25} />
            <Line points={[rw * 0.08, rh * 0.5, rw * 0.92, rh * 0.5]} stroke={strokeC} strokeWidth={0.6} opacity={0.25} />
            <Line points={[rw * 0.08, rh * 0.7, rw * 0.92, rh * 0.7]} stroke={strokeC} strokeWidth={0.6} opacity={0.25} />
          </>
        )}

        {/* ============ COFFEE TABLE (top-down) ============ */}
        {pf.itemId === "coffee-table" && (
          <>
            {/* Table top */}
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={5} />
            {/* Lower shelf visible through/under */}
            <Rect x={rw * 0.12} y={rh * 0.12} width={rw * 0.76} height={rh * 0.76} fill={fillC} stroke={strokeC} strokeWidth={0.8} cornerRadius={4} opacity={0.5} />
            {/* 4 tiny leg dots */}
            <Circle x={rw * 0.1} y={rh * 0.1} radius={rw * 0.04} fill={strokeC} opacity={0.3} />
            <Circle x={rw * 0.9} y={rh * 0.1} radius={rw * 0.04} fill={strokeC} opacity={0.3} />
            <Circle x={rw * 0.1} y={rh * 0.9} radius={rw * 0.04} fill={strokeC} opacity={0.3} />
            <Circle x={rw * 0.9} y={rh * 0.9} radius={rw * 0.04} fill={strokeC} opacity={0.3} />
          </>
        )}

        {/* ============ SIDE TABLE (top-down) ============ */}
        {pf.itemId === "side-table" && (
          <>
            <Circle x={rw / 2} y={rh / 2} radius={Math.min(rw, rh) * 0.45} fill={fillC} stroke={strokeC} strokeWidth={sw} />
            <Circle x={rw / 2} y={rh / 2} radius={Math.min(rw, rh) * 0.15} fill={strokeC} opacity={0.2} />
          </>
        )}

        {/* ============ DESK (top-down) ============ */}
        {pf.itemId === "desk" && (
          <>
            {/* Main desk surface */}
            <Rect x={0} y={0} width={rw} height={rh * 0.85} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={4} />
            {/* Front overhang (where person sits) */}
            <Rect x={rw * 0.05} y={rh * 0.78} width={rw * 0.9} height={rh * 0.22} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} cornerRadius={2} opacity={0.6} />
            {/* Chair tucked under — small hint */}
            <Rect x={rw * 0.3} y={rh * 0.85} width={rw * 0.4} height={rh * 0.15} fill={strokeC} stroke={strokeC} strokeWidth={0.5} cornerRadius={3} opacity={0.2} />
          </>
        )}

        {/* ============ BED (top-down) ============ */}
        {(pf.itemId === "bed-single" || pf.itemId === "bed-double" || pf.itemId === "bed-queen" || pf.itemId === "bed-king") && (
          <>
            {/* Headboard — thin edge against the wall */}
            <Rect x={0} y={0} width={rw} height={rh * 0.04} fill={strokeC} stroke={strokeC} strokeWidth={sw} />
            {/* Mattress — main rectangle */}
            <Rect x={rw * 0.03} y={rh * 0.04} width={rw * 0.94} height={rh * 0.88} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={5} />
            {/* Two pillows at the head end */}
            <Rect x={rw * 0.08} y={rh * 0.08} width={rw * 0.36} height={rh * 0.14} fill="#FFFFFF" stroke={strokeC} strokeWidth={0.6} cornerRadius={5} />
            <Rect x={rw * 0.56} y={rh * 0.08} width={rw * 0.36} height={rh * 0.14} fill="#FFFFFF" stroke={strokeC} strokeWidth={0.6} cornerRadius={5} />
            {/* Duvet fold line ~⅔ down the bed */}
            <Line points={[rw * 0.08, rh * 0.62, rw * 0.92, rh * 0.62]} stroke={strokeC} strokeWidth={0.7} opacity={0.3} />
            {/* Duvet texture — subtle cross-hatch */}
            <Line points={[rw * 0.15, rh * 0.7, rw * 0.15, rh * 0.88]} stroke={strokeC} strokeWidth={0.4} opacity={0.15} />
            <Line points={[rw * 0.5, rh * 0.7, rw * 0.5, rh * 0.88]} stroke={strokeC} strokeWidth={0.4} opacity={0.15} />
            <Line points={[rw * 0.85, rh * 0.7, rw * 0.85, rh * 0.88]} stroke={strokeC} strokeWidth={0.4} opacity={0.15} />
          </>
        )}

        {/* ============ TOILET (top-down) ============ */}
        {pf.itemId === "toilet" && (
          <>
            {/* Cistern tank — rectangular water tank against the wall, darker than bowl */}
            <Rect x={rw * 0.2} y={0} width={rw * 0.6} height={rh * 0.2} fill="#D8D8D8" stroke={strokeC} strokeWidth={sw} cornerRadius={[4, 4, 0, 0]} />
            {/* Flush button on top of cistern */}
            <Rect x={rw * 0.4} y={rh * 0.04} width={rw * 0.2} height={rh * 0.08} fill="#C0C0C0" stroke={strokeC} strokeWidth={0.5} cornerRadius={2} />
            {/* Bowl base — elongated oval, porcelain */}
            <Circle x={rw / 2} y={rh * 0.58} radius={rw * 0.36} fill={fillC} stroke={strokeC} strokeWidth={sw} scaleX={1} scaleY={1.8} />
            {/* Seat / lid — white oval on top of bowl, slightly smaller */}
            <Circle x={rw / 2} y={rh * 0.56} radius={rw * 0.26} fill="#FAFAFA" stroke="#D0D0D0" strokeWidth={0.8} scaleX={1} scaleY={1.7} />
            {/* Seat hinge gap — dark line where seat meets tank */}
            <Line points={[rw * 0.28, rh * 0.22, rw * 0.72, rh * 0.22]} stroke={strokeC} strokeWidth={0.6} opacity={0.4} />
          </>
        )}

        {/* ============ BATHROOM SINK (top-down) ============ */}
        {pf.itemId === "sink-bathroom" && (
          <>
            {/* Counter/vanity top */}
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={4} />
            {/* Basin — oval cutout */}
            <Circle x={rw / 2} y={rh * 0.38} radius={rw * 0.32} fill="#E8ECEF" stroke={strokeC} strokeWidth={0.8} scaleY={rh / rw * 0.35} />
            {/* Faucet — small circle at the back of basin */}
            <Circle x={rw / 2} y={rh * 0.15} radius={rw * 0.07} fill={strokeC} />
            {/* Drain */}
            <Circle x={rw * 0.55} y={rh * 0.4} radius={rw * 0.04} fill="#999" />
          </>
        )}

        {/* ============ BATHTUB (top-down) ============ */}
        {pf.itemId === "bathtub" && (
          <>
            {/* Tub rim */}
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={10} />
            {/* Inner basin */}
            <Rect x={rw * 0.07} y={rh * 0.07} width={rw * 0.86} height={rh * 0.86} fill="#D8E8F0" stroke={strokeC} strokeWidth={0.8} cornerRadius={8} />
            {/* Sloped backrest end (angled line at head) */}
            <Line points={[rw * 0.12, rh * 0.18, rw * 0.35, rh * 0.08, rw * 0.65, rh * 0.08, rw * 0.88, rh * 0.18]} stroke={strokeC} strokeWidth={0.6} opacity={0.3} fill="#C0D4E4" closed />
            {/* Faucet */}
            <Circle x={rw / 2} y={rh * 0.03} radius={rw * 0.06} fill={strokeC} />
          </>
        )}

        {/* ============ SHOWER (top-down) ============ */}
        {pf.itemId === "shower" && (
          <>
            {/* Tray */}
            <Rect x={rw * 0.02} y={rh * 0.02} width={rw * 0.96} height={rh * 0.96} fill="#D8D8D8" stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Glass enclosure — 3 walls, open on one side */}
            <Line points={[0, 0, rw, 0]} stroke="#B0D4E8" strokeWidth={2} opacity={0.6} />
            <Line points={[0, 0, 0, rh]} stroke="#B0D4E8" strokeWidth={2} opacity={0.6} />
            <Line points={[rw, 0, rw, rh]} stroke="#B0D4E8" strokeWidth={2} opacity={0.6} />
            {/* Door gap on the open side (bottom) */}
            <Line points={[rw * 0.25, rh, rw * 0.75, rh]} stroke="#D8D8D8" strokeWidth={2.5} />
            {/* Shower head — circle in center-top */}
            <Circle x={rw / 2} y={rh * 0.15} radius={rw * 0.13} fill="#88BBEE" stroke={strokeC} strokeWidth={0.6} />
            {/* Drain in center */}
            <Circle x={rw / 2} y={rh * 0.55} radius={rw * 0.06} fill="#999" />
          </>
        )}

        {/* ============ KITCHEN COUNTER (top-down) ============ */}
        {(pf.itemId === "kitchen-counter-straight" || pf.itemId === "kitchen-counter-corner") && !pf.itemId.includes("island") && (
          <>
            {/* Worktop surface */}
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Front edge highlight (overhang) */}
            <Line points={[0, rh, rw, rh]} stroke={strokeC} strokeWidth={1.5} opacity={0.5} />
            {/* Subtle cabinet divisions below (dashed lines on surface) */}
            <Line points={[rw * 0.33, rh * 0.2, rw * 0.33, rh * 0.8]} stroke={strokeC} strokeWidth={0.5} opacity={0.2} dash={[2, 3]} />
            <Line points={[rw * 0.66, rh * 0.2, rw * 0.66, rh * 0.8]} stroke={strokeC} strokeWidth={0.5} opacity={0.2} dash={[2, 3]} />
          </>
        )}

        {/* ============ STOVE / OVEN (top-down) ============ */}
        {pf.itemId === "stove-4-burner" && (
          <>
            {/* Stove body */}
            <Rect x={0} y={0} width={rw} height={rh} fill="#3A3A3A" stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Cooktop surface */}
            <Rect x={rw * 0.05} y={rh * 0.05} width={rw * 0.9} height={rh * 0.9} fill="#2A2A2A" stroke="#555" strokeWidth={0.8} cornerRadius={2} />
            {/* 4 burners — circles with cross marks */}
            {[[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([bx, by], bi) => (
              <Group key={`burner-${bi}`}>
                <Circle x={rw * bx} y={rh * by} radius={rw * 0.1} fill="#444" stroke="#666" strokeWidth={0.5} />
                <Circle x={rw * bx} y={rh * by} radius={rw * 0.04} fill="#555" />
                <Line points={[rw * (bx - 0.08), rh * by, rw * (bx + 0.08), rh * by]} stroke="#555" strokeWidth={0.3} />
                <Line points={[rw * bx, rh * (by - 0.08), rw * bx, rh * (by + 0.08)]} stroke="#555" strokeWidth={0.3} />
              </Group>
            ))}
          </>
        )}

        {/* ============ REFRIGERATOR (top-down) ============ */}
        {pf.itemId === "refrigerator" && (
          <>
            <Rect x={0} y={0} width={rw} height={rh} fill="#E8E8E8" stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Door gap line */}
            <Line points={[rw * 0.06, rh * 0.5, rw * 0.94, rh * 0.5]} stroke="#CCC" strokeWidth={0.6} />
            {/* Condenser coils hint on back */}
            <Line points={[rw * 0.1, rh * 0.05, rw * 0.1, rh * 0.95]} stroke="#BBB" strokeWidth={0.4} opacity={0.3} />
            <Line points={[rw * 0.3, rh * 0.05, rw * 0.3, rh * 0.95]} stroke="#BBB" strokeWidth={0.4} opacity={0.3} />
            <Line points={[rw * 0.5, rh * 0.05, rw * 0.5, rh * 0.95]} stroke="#BBB" strokeWidth={0.4} opacity={0.3} />
          </>
        )}

        {/* ============ KITCHEN SINK (top-down) ============ */}
        {pf.itemId === "kitchen-sink" && (
          <>
            {/* Sink rim — sits in counter cutout */}
            <Rect x={0} y={0} width={rw} height={rh} fill="#D0D0D0" stroke={strokeC} strokeWidth={sw} cornerRadius={4} />
            {/* Basin depression */}
            <Rect x={rw * 0.08} y={rh * 0.08} width={rw * 0.84} height={rh * 0.84} fill="#B8C0C8" stroke="#999" strokeWidth={0.6} cornerRadius={3} />
            {/* Drain */}
            <Circle x={rw * 0.65} y={rh * 0.7} radius={rw * 0.06} fill="#888" />
            {/* Faucet base */}
            <Circle x={rw / 2} y={0} radius={rw * 0.07} fill={strokeC} />
          </>
        )}

        {/* ============ KITCHEN ISLAND (top-down) ============ */}
        {pf.itemId === "kitchen-island" && (
          <>
            {/* Main worktop */}
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={4} />
            {/* Overhang on one long side (seating side) */}
            <Rect x={0} y={rh * 0.12} width={rw} height={rh * 0.88} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} cornerRadius={[0, 0, 3, 3]} opacity={0.6} />
            {/* Stool indicators — small rectangles along overhang edge */}
            <Rect x={rw * 0.12} y={rh * 0.18} width={rw * 0.16} height={rh * 0.2} fill={strokeC} cornerRadius={3} opacity={0.3} />
            <Rect x={rw * 0.42} y={rh * 0.18} width={rw * 0.16} height={rh * 0.2} fill={strokeC} cornerRadius={3} opacity={0.3} />
            <Rect x={rw * 0.72} y={rh * 0.18} width={rw * 0.16} height={rh * 0.2} fill={strokeC} cornerRadius={3} opacity={0.3} />
          </>
        )}

        {/* ============ WARDROBE (top-down) ============ */}
        {pf.itemId === "wardrobe" && (
          <>
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Door seam — handles NOT visible from directly above */}
            <Line points={[rw * 0.5, rh * 0.06, rw * 0.5, rh * 0.94]} stroke={strokeC} strokeWidth={0.8} opacity={0.4} />
          </>
        )}

        {/* ============ BOOKSHELF (top-down) ============ */}
        {pf.itemId === "bookshelf" && (
          <>
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={2} />
            {/* Shelf dividers — horizontal lines */}
            <Line points={[rw * 0.05, rh * 0.33, rw * 0.95, rh * 0.33]} stroke={strokeC} strokeWidth={0.8} opacity={0.5} />
            <Line points={[rw * 0.05, rh * 0.66, rw * 0.95, rh * 0.66]} stroke={strokeC} strokeWidth={0.8} opacity={0.5} />
            {/* Book spines — colorful thin rectangles seen edge-on from above */}
            <Rect x={rw * 0.08} y={rh * 0.05} width={rw * 0.06} height={rh * 0.22} fill="#D44" cornerRadius={0.5} />
            <Rect x={rw * 0.16} y={rh * 0.05} width={rw * 0.05} height={rh * 0.25} fill="#48B" cornerRadius={0.5} />
            <Rect x={rw * 0.23} y={rh * 0.05} width={rw * 0.07} height={rh * 0.19} fill="#4A4" cornerRadius={0.5} />
            <Rect x={rw * 0.32} y={rh * 0.05} width={rw * 0.04} height={rh * 0.24} fill="#E94" cornerRadius={0.5} />
            <Rect x={rw * 0.1} y={rh * 0.38} width={rw * 0.06} height={rh * 0.21} fill="#68B" cornerRadius={0.5} />
            <Rect x={rw * 0.18} y={rh * 0.38} width={rw * 0.05} height={rh * 0.2} fill="#A4A" cornerRadius={0.5} />
            <Rect x={rw * 0.25} y={rh * 0.38} width={rw * 0.08} height={rh * 0.22} fill="#8B4" cornerRadius={0.5} />
            <Rect x={rw * 0.08} y={rh * 0.71} width={rw * 0.06} height={rh * 0.2} fill="#DB7" cornerRadius={0.5} />
            <Rect x={rw * 0.16} y={rh * 0.71} width={rw * 0.07} height={rh * 0.22} fill="#C55" cornerRadius={0.5} />
          </>
        )}

        {/* ============ CABINET (top-down) ============ */}
        {pf.itemId === "cabinet" && (
          <>
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Door seam only — knobs not visible from above */}
            <Line points={[rw * 0.5, rh * 0.06, rw * 0.5, rh * 0.94]} stroke={strokeC} strokeWidth={0.8} opacity={0.4} />
          </>
        )}

        {/* ============ RUG (top-down) ============ */}
        {pf.itemId === "rug-large" && (
          <>
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={1} cornerRadius={6} opacity={0.75} />
            {/* Border pattern */}
            <Rect x={rw * 0.04} y={rh * 0.04} width={rw * 0.92} height={rh * 0.92} fill="none" stroke={strokeC} strokeWidth={0.8} cornerRadius={4} opacity={0.35} />
            <Rect x={rw * 0.08} y={rh * 0.08} width={rw * 0.84} height={rh * 0.84} fill="none" stroke={strokeC} strokeWidth={0.5} cornerRadius={2} opacity={0.25} />
            {/* Center motif — diamond */}
            <Line points={[rw / 2, rh * 0.2, rw * 0.8, rh / 2, rw / 2, rh * 0.8, rw * 0.2, rh / 2]} closed fill={strokeC} stroke={strokeC} strokeWidth={0.3} opacity={0.15} />
          </>
        )}

        {/* ============ INDOOR PLANT (top-down) ============ */}
        {pf.itemId === "plant-indoor" && (
          <>
            {/* Pot — circle */}
            <Circle x={rw / 2} y={rh * 0.65} radius={rw * 0.38} fill="#C4956A" stroke="#8B6535" strokeWidth={sw} />
            {/* Foliage — overlapping green circles */}
            <Circle x={rw * 0.5} y={rh * 0.25} radius={rw * 0.32} fill="#4CAF50" stroke="#2E7D32" strokeWidth={0.6} opacity={0.8} />
            <Circle x={rw * 0.25} y={rh * 0.35} radius={rw * 0.25} fill="#66BB6A" stroke="#388E3C" strokeWidth={0.4} opacity={0.7} />
            <Circle x={rw * 0.75} y={rh * 0.3} radius={rw * 0.22} fill="#81C784" stroke="#43A047" strokeWidth={0.4} opacity={0.65} />
            <Circle x={rw * 0.5} y={rh * 0.12} radius={rw * 0.2} fill="#A5D6A7" stroke="#66BB6A" strokeWidth={0.3} opacity={0.75} />
          </>
        )}

        {/* ============ TV UNIT (top-down) ============ */}
        {pf.itemId === "tv-unit" && (
          <>
            {/* Console/stand */}
            <Rect x={0} y={rh * 0.6} width={rw} height={rh * 0.4} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* TV screen — thin rectangle protruding from wall */}
            <Rect x={rw * 0.1} y={rh * 0.05} width={rw * 0.8} height={rh * 0.55} fill="#1A1A2E" stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Screen bezel */}
            <Rect x={rw * 0.12} y={rh * 0.07} width={rw * 0.76} height={rh * 0.5} fill="#16213E" stroke="#333" strokeWidth={0.4} cornerRadius={2} />
            {/* Stand neck — small rectangle connecting TV to console */}
            <Rect x={rw * 0.4} y={rh * 0.55} width={rw * 0.2} height={rh * 0.08} fill={strokeC} cornerRadius={1} />
          </>
        )}

        {/* ============ OUTDOOR FURNITURE (top-down) ============ */}
        {(pf.itemId === "outdoor-table" || pf.itemId === "outdoor-chair") && (
          <>
            <Rect x={rw * 0.03} y={rh * 0.03} width={rw * 0.94} height={rh * 0.94} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={5} />
            <Line points={[rw * 0.1, rh * 0.5, rw * 0.9, rh * 0.5]} stroke={strokeC} strokeWidth={0.5} opacity={0.3} />
            {/* Umbrella hole center dot for table */}
            {pf.itemId === "outdoor-table" && (
              <Circle x={rw / 2} y={rh / 2} radius={rw * 0.05} fill="#555" />
            )}
          </>
        )}

        {/* ============ FALLBACK: simple colored rect with label ============ */}
        {!pf.itemId.match(/sofa|armchair|dining-chair|office-chair|dining-table|coffee-table|side-table|desk|bed-|toilet|sink-bathroom|bathtub|shower|kitchen-counter|stove|refrigerator|kitchen-sink|kitchen-island|wardrobe|bookshelf|cabinet|rug-large|plant-indoor|tv-unit|outdoor/) && (
          <>
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={4} />
            <Text x={0} y={rh * 0.3} width={rw} height={rh * 0.4} text={item.name.substring(0, 12)} fontSize={Math.min(rw, rh) * 0.18} fill="#555" align="center" verticalAlign="middle" fontFamily="system-ui" />
          </>
        )}

        {/* Hover tooltip — floating label above the furniture */}
        {isHovered && (
          <>
            <Rect x={-rw * 0.5} y={-rh * 0.55} width={rw * 2} height={rh * 0.4} fill="#1A1A2E" cornerRadius={4} opacity={0.85} />
            <Text x={-rw * 0.45} y={-rh * 0.52} width={rw * 1.9} height={rh * 0.34}
              text={item.name} fontSize={Math.min(rw, rh) * 0.22} fill="#FFFFFF"
              align="center" verticalAlign="middle" fontFamily="system-ui, sans-serif" fontStyle="bold" />
            {/* Highlight border on the item */}
            <Rect x={-2} y={-2} width={rw + 4} height={rh + 4} fill="none" stroke="#3B82F6" strokeWidth={2} cornerRadius={5} dash={[4, 2]} />
          </>
        )}
      </Group>
    );
  }, [s, bb, hoveredFurnIdx, onFurnitureHover]);

  return (
    <div className="relative w-full aspect-square max-w-[700px] mx-auto
                    bg-[#fcfcf9] rounded-xl border border-zinc-300 shadow-sm overflow-hidden"
         style={{ touchAction: "none" }}>
      <Stage width={STAGE_W} height={STAGE_H}
             style={{ width: "100%", height: "100%" }}>
        {/* ======== LAYER 0: Grid ======== */}
        <Layer listening={false}>
          {grid1mLines}
          {grid5mLines}
        </Layer>

        {/* ======== LAYER 1: Rooms + Doors + Windows ======== */}
        <Layer>
          {grouped.map(([key, parts]) => {
            const name = parts[0].name;
            const center = roomCenter(parts[0]);
            const cPx = toCanvas(center.x, center.y, s, bb);
            const isHall = /hallway|corridor|foyer/i.test(name);
            const isHovered = hoveredKey === key;
            const totalArea = parts.reduce((sum, p) => sum + p.area, 0);

            return (
              <Group key={key}
                onMouseEnter={() => { setHoveredKey(key); onRoomHover?.(parts[0]); }}
                onMouseLeave={() => { setHoveredKey(null); onRoomHover?.(null); }}
              >
                {/* Room polygons */}
                {parts.map((room, pi) => {
                  const poly = rectToScreenFlat(room, s, bb);
                  return (
                    <Group key={pi}>
                      <Line points={poly} closed
                        fill={fill(room.name)}
                        stroke={isHall ? "#8a8a9a" : "#3a3a4a"}
                        strokeWidth={isHall ? 2 : WALL}
                        lineJoin="round"
                        shadowColor={isHovered ? "#3b82f6" : undefined}
                        shadowBlur={isHovered ? 10 : 0}
                        shadowOpacity={isHovered ? 0.35 : 0}
                      />

                      {/* Door gaps */}
                      {doors.filter(d => d.room === room.name && !isHall).map((door, di) => {
                        const dp = doorGapPoly(room, door);
                        if (dp.length === 0) return null;
                        const fp = worldToScreenFlat(dp, s, bb);
                        return <Line key={`dg-${di}`} points={fp} closed fill="#fcfcf9" stroke="none" />;
                      })}

                      {/* Window markers */}
                      {windows.filter(w => w.room === room.name).map((win, wi) => {
                        const { x: rx, y: ry, width: rw, height: rh } = room;
                        const off = win.offset;
                        const ww = (win.width * s) / 2;
                        const isVert = win.wall === "left" || win.wall === "right";
                        let wx: number, wy: number;
                        switch (win.wall) {
                          case "bottom": { const p = toCanvas(rx + off, ry, s, bb); wx = p.x; wy = p.y; break; }
                          case "top": { const p = toCanvas(rx + off, ry + rh, s, bb); wx = p.x; wy = p.y; break; }
                          case "left": { const p = toCanvas(rx, ry + off, s, bb); wx = p.x; wy = p.y; break; }
                          case "right": { const p = toCanvas(rx + rw, ry + off, s, bb); wx = p.x; wy = p.y; break; }
                          default: wx = 0; wy = 0;
                        }
                        return (
                          <Group key={`win-${wi}`}>
                            <Rect x={isVert ? wx - 2 : wx - ww} y={isVert ? wy - ww : wy - 2}
                              width={isVert ? 4 : ww * 2} height={isVert ? ww * 2 : 4}
                              fill="#fcfcf9" stroke="none" />
                            <Line points={isVert ? [wx - 1, wy - ww, wx - 1, wy + ww] : [wx - ww, wy - 1, wx + ww, wy - 1]}
                              stroke="#88aacc" strokeWidth={1.2} />
                            <Line points={isVert ? [wx + 1, wy - ww, wx + 1, wy + ww] : [wx - ww, wy + 1, wx + ww, wy + 1]}
                              stroke="#88aacc" strokeWidth={1.2} />
                          </Group>
                        );
                      })}
                    </Group>
                  );
                })}

                {/* Door swing arcs */}
                {doors.filter(d => {
                  const room = roomMap.get(d.room);
                  return room && parts.some(p => p.name === room.name) && !/hallway|corridor|foyer/i.test(d.room);
                }).map((door, di) => {
                  const room = roomMap.get(door.room)!;
                  const { x: rx, y: ry, width: rw, height: rh } = room;
                  const off = door.offset;
                  const dw = (door.width * s) / 2;
                  let ax: number, ay: number;
                  switch (door.wall) {
                    case "bottom": { const p = toCanvas(rx + off, ry, s, bb); ax = p.x; ay = p.y; break; }
                    case "top": { const p = toCanvas(rx + off, ry + rh, s, bb); ax = p.x; ay = p.y; break; }
                    case "left": { const p = toCanvas(rx, ry + off, s, bb); ax = p.x; ay = p.y; break; }
                    case "right": { const p = toCanvas(rx + rw, ry + off, s, bb); ax = p.x; ay = p.y; break; }
                    default: ax = 0; ay = 0;
                  }
                  return (
                    <Line key={`dsw-${di}`} stroke="#999" strokeWidth={1} dash={[3, 2]}
                      points={
                        door.wall === "left" || door.wall === "right"
                          ? [ax, ay - dw, ax - dw, ay - dw]
                          : [ax - dw, ay, ax - dw, ay - dw]
                      } />
                  );
                })}

                {/* Room label */}
                <Text x={cPx.x - 55} y={cPx.y - 16} width={110} height={16}
                  text={name} fontSize={11} fontStyle="bold" fill="#2d2d3f"
                  align="center" verticalAlign="middle" fontFamily="system-ui, sans-serif" />
                <Text x={cPx.x - 55} y={cPx.y + 2} width={110} height={14}
                  text={`${totalArea.toFixed(1)} m²`} fontSize={9} fill="#888"
                  align="center" verticalAlign="middle" fontFamily="system-ui, sans-serif" />
              </Group>
            );
          })}
        </Layer>

        {/* ======== LAYER 2: Furniture ======== */}
        {placedFurniture && placedFurniture.length > 0 && (
          <Layer>
            {placedFurniture.map((pf, i) => renderFurnitureItem(pf, i))}
          </Layer>
        )}

        {/* ======== LAYER 3: Annotations ======== */}
        <Layer listening={false}>
          {/* North arrow */}
          <Group x={STAGE_W - 38} y={28}>
            <Line points={[0, -8, -7, 6, 7, 6]} closed fill="#3a3a4a" />
            <Text x={-5} y={11} text="N" fontSize={10} fontStyle="bold" fill="#3a3a4a" width={10} align="center" />
          </Group>

          {/* Scale bar */}
          <Group x={16} y={STAGE_H - 20}>
            <Line points={[0, 0, 5 * s, 0]} stroke="#3a3a4a" strokeWidth={1.5} />
            <Line points={[0, -6, 0, 6]} stroke="#3a3a4a" strokeWidth={1} />
            <Line points={[5 * s, -6, 5 * s, 6]} stroke="#3a3a4a" strokeWidth={1} />
            <Text x={2.5 * s - 10} y={10} text="5m" fontSize={10} fill="#999" width={20} align="center" />
          </Group>
        </Layer>
      </Stage>

      {viewMode === "3d" && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-sm z-10 rounded-xl">
          <div className="text-center text-zinc-500">
            <svg className="w-10 h-10 mx-auto mb-2 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <p className="font-medium">3D View</p><p className="text-sm">Coming soon</p>
          </div>
        </div>
      )}
    </div>
  );
}
