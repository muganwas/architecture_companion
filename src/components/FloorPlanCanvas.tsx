"use client";

import React, { useMemo, useState, useCallback } from "react";
import { Stage, Layer, Group, Rect, Line, Circle, Text, Arc } from "react-konva";
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
  buildingPolygon?: Array<{ x: number; y: number }>;
  /** For apartments: where the building corridor/stairwell connects */
  entranceApproach?: { eHallX: number; eHallY: number; doorX: number; doorY: number; wall: Door["wall"] };
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

const BBOX_MARGIN = 1.5; // extra world-space margin so exterior labels aren't cut off

function computeBBox(rooms: GeneratedRoom[], poly?: Array<{ x: number; y: number }>): BBox {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rooms) {
    if (r.x < x1) x1 = r.x; if (r.y < y1) y1 = r.y;
    if (r.x + r.width > x2) x2 = r.x + r.width;
    if (r.y + r.height > y2) y2 = r.y + r.height;
  }
  // Include building polygon extent
  if (poly) {
    for (const p of poly) {
      if (p.x < x1) x1 = p.x; if (p.y < y1) y1 = p.y;
      if (p.x > x2) x2 = p.x; if (p.y > y2) y2 = p.y;
    }
  }
  // Add margin so exterior markers (E.Hallway, porch/balcony labels) aren't clipped
  x1 -= BBOX_MARGIN; y1 -= BBOX_MARGIN;
  x2 += BBOX_MARGIN; y2 += BBOX_MARGIN;
  return { x: x1, y: y1, w: x2 - x1 || 10, h: y2 - y1 || 10 };
}

function computeScale(rooms: GeneratedRoom[], poly?: Array<{ x: number; y: number }>): { s: number; bb: BBox } {
  const bb = computeBBox(rooms, poly);
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

/** Render a single door as a proper architectural floor-plan symbol.
 *  Standard door: partially-open panel (60°) + swing arc from panel tip to latch.
 *  Garage door: sliding symbol (no swing). */
function renderDoor(
  room: GeneratedRoom, door: Door, s: number, bb: BBox
): React.ReactNode {
  const { x: rx, y: ry, width: rw, height: rh } = room;
  const gapHw = door.width / 2;
  const off = door.offset;
  const isGarage = door.width >= 2.0;
  const stopLen = 0.06;

  // Hinge is always on the LEFT side of the gap (standard convention)
  // Latch is on the RIGHT side
  let hingeX: number, hingeY: number, latchX: number, latchY: number;
  let inDirX: number, inDirY: number; // unit vector pointing INTO the room from the wall
  let alongDirX: number, alongDirY: number; // unit vector along the wall (hinge→latch direction)

  switch (door.wall) {
    case "bottom":
      hingeX = rx + off - gapHw; hingeY = ry;
      latchX = rx + off + gapHw; latchY = ry;
      inDirX = 0; inDirY = 1; // into room = up
      alongDirX = 1; alongDirY = 0; // along wall = right
      break;
    case "top":
      hingeX = rx + off - gapHw; hingeY = ry + rh;
      latchX = rx + off + gapHw; latchY = ry + rh;
      inDirX = 0; inDirY = -1; // into room = down
      alongDirX = 1; alongDirY = 0;
      break;
    case "left":
      hingeX = rx; hingeY = ry + off - gapHw;
      latchX = rx; latchY = ry + off + gapHw;
      inDirX = 1; inDirY = 0; // into room = right
      alongDirX = 0; alongDirY = 1; // along wall = up
      break;
    case "right":
      hingeX = rx + rw; hingeY = ry + off - gapHw;
      latchX = rx + rw; latchY = ry + off + gapHw;
      inDirX = -1; inDirY = 0; // into room = left
      alongDirX = 0; alongDirY = 1;
      break;
    default: return null;
  }

  const swingIn = door.swing !== "out";
  const inSign = swingIn ? 1 : -1;
  const doorLen = door.width;

  const hinge = toCanvas(hingeX, hingeY, s, bb);
  const arcR = doorLen * s;

  // ── Screen-space direction vectors ──
  // toCanvas flips Y: screenY = STAGE_H - PAD - (worldY - bb.y) * s
  // so a world vector (dx, dy) → screen vector (dx*s, -dy*s). Normalising: (dx, -dy).
  const alongDX = alongDirX;           // X unchanged
  const alongDY = -alongDirY;          // Y flipped for screen
  const inDX = inDirX;
  const inDY = -inDirY;

  // ── Latch position in screen coords (relative to hinge) ──
  const latchRelX = arcR * alongDX;
  const latchRelY = arcR * alongDY;

  // ── Door tip: 45° from closed direction toward room interior ──
  const cos45 = Math.cos(Math.PI / 4);
  const sin45 = Math.sin(Math.PI / 4);
  const tipRelX = arcR * (cos45 * alongDX + inSign * sin45 * inDX);
  const tipRelY = arcR * (cos45 * alongDY + inSign * sin45 * inDY);

  // ── Arc: 45° sweep from latch (closed) to tip (open), centred at hinge ──
  const angleClosed = Math.atan2(alongDY, alongDX);       // direction of latch
  const angleOpen   = Math.atan2(tipRelY / arcR, tipRelX / arcR); // direction of tip

  const arcSteps = 12;
  const arcPoints: number[] = [];
  for (let i = 0; i <= arcSteps; i++) {
    const t = i / arcSteps;
    const a = angleClosed + (angleOpen - angleClosed) * t;
    arcPoints.push(arcR * Math.cos(a), arcR * Math.sin(a));
  }

  // Wall gap — absolute screen coords
  const gapPoints = doorGapPoly(room, door);
  const gapFlat = worldToScreenFlat(gapPoints, s, bb);

  // ── Garage door: sectional panel symbol ──
  // Completely distinct from windows: grey filled panel with horizontal
  // section lines, thick frame, and slide-direction arrows at the sides.
  if (isGarage) {
    const isHoriz = door.wall === "bottom" || door.wall === "top";
    const doorW = doorLen * s;                   // total door width in px
    const doorH = isHoriz ? 8 : doorW;           // panel height (thick)
    const panelW = isHoriz ? doorW : 8;          // panel width
    const hingePx = hinge;
    const sections = 4; // number of horizontal/vertical panel sections

    return (
      <Group key={`door-${door.room}-${door.wall}`}>
        {/* Gap in wall for the opening */}
        {gapFlat.length > 0 && (
          <Line points={gapFlat} closed fill="#f0ece4" stroke="#999" strokeWidth={0.8} />
        )}
        {/* Garage door panel — filled grey rectangle (NOT dashed like windows) */}
        <Rect
          x={isHoriz ? hingePx.x : hingePx.x - panelW / 2}
          y={isHoriz ? hingePx.y - doorH / 2 : hingePx.y}
          width={isHoriz ? doorW : panelW}
          height={isHoriz ? doorH : doorW}
          fill="#d5d0c8"
          stroke="#777"
          strokeWidth={1.2}
          cornerRadius={0.5}
        />
        {/* Sectional panel lines */}
        {Array.from({ length: sections - 1 }, (_, i) => {
          const t = (i + 1) / sections;
          const x1 = isHoriz ? hingePx.x + t * doorW : hingePx.x - panelW / 2;
          const y1 = isHoriz ? hingePx.y - doorH / 2 : hingePx.y + t * doorW;
          const x2 = isHoriz ? hingePx.x + t * doorW : hingePx.x + panelW / 2;
          const y2 = isHoriz ? hingePx.y + doorH / 2 : hingePx.y + t * doorW;
          return <Line key={`sec-${i}`} points={[x1, y1, x2, y2]} stroke="#bbb" strokeWidth={0.6} />;
        })}
        {/* Slide-direction arrows at both ends of the door — thick, distinct from window lines */}
        {[0, 1].map(side => {
          const cx = isHoriz
            ? hingePx.x + (side === 0 ? -10 : doorW + 10)
            : hingePx.x;
          const cy = isHoriz
            ? hingePx.y
            : hingePx.y + (side === 0 ? -10 : doorW + 10);
          return (
            <Group key={`arr-${side}`} x={cx} y={cy}>
              {isHoriz ? (
                <>
                  <Line points={[0, -5, 0, 5]} stroke="#555" strokeWidth={1.2} />
                  <Line points={[side === 0 ? 0 : 0, -3, side === 0 ? -4 : 4, 0]} stroke="#555" strokeWidth={1.2} />
                  <Line points={[side === 0 ? 0 : 0, 3, side === 0 ? -4 : 4, 0]} stroke="#555" strokeWidth={1.2} />
                </>
              ) : (
                <>
                  <Line points={[-5, 0, 5, 0]} stroke="#555" strokeWidth={1.2} />
                  <Line points={[-3, side === 0 ? 0 : 0, 0, side === 0 ? -4 : 4]} stroke="#555" strokeWidth={1.2} />
                  <Line points={[3, side === 0 ? 0 : 0, 0, side === 0 ? -4 : 4]} stroke="#555" strokeWidth={1.2} />
                </>
              )}
            </Group>
          );
        })}
      </Group>
    );
  }

  // ── Standard swing door ──
  return (
    <Group key={`door-${door.room}-${door.wall}`}>
      {/* Wall gap — white fill + thin outline so the doorway opening is always visible */}
      {gapFlat.length > 0 && (
        <>
          <Line points={gapFlat} closed fill="#fcfcf9" stroke="#bbb" strokeWidth={0.5} />
          {/* Doorframe ticks at each end of the gap */}
          <Line points={[gapFlat[0], gapFlat[1], gapFlat[6], gapFlat[7]]} stroke="#666" strokeWidth={1} />
          <Line points={[gapFlat[2], gapFlat[3], gapFlat[4], gapFlat[5]]} stroke="#666" strokeWidth={1} />
        </>
      )}
      {/* Door geometry — all relative to hinge position */}
      <Group x={hinge.x} y={hinge.y}>
        {/* Doorway plane (closed position): hinge → latch, subtle dashed reference line */}
        <Line points={[0, 0, latchRelX, latchRelY]} stroke="#aaa" strokeWidth={0.8} dash={[4, 4]} />
        {/* Door panel (open position): hinge → tip, 45° from doorway plane */}
        <Line points={[0, 0, tipRelX, tipRelY]} stroke="#333" strokeWidth={2} />
        {/* Swing arc: latch → tip, the 45° sweep */}
        <Line points={arcPoints} stroke="#e63946" strokeWidth={2.5} dash={[5, 3]} tension={0.5} />
        {/* Small hinge dot */}
        <Circle x={0} y={0} radius={2} fill="#333" stroke="none" />
      </Group>
    </Group>
  );
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
  rooms, doors, windows, placedFurniture, buildingPolygon, entranceApproach, viewMode, onRoomHover, onFurnitureHover,
}: FloorPlanCanvasProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [hoveredFurnIdx, setHoveredFurnIdx] = useState<number | null>(null);

  const { s, bb } = useMemo(() => computeScale(rooms, buildingPolygon), [rooms, buildingPolygon]);
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
        {(pf.itemId === "bed-single" || pf.itemId === "bed-double" || pf.itemId === "bed-queen" || pf.itemId === "bed-king") && (() => {
          // Headboard is always on the shorter side (item.width < item.height for all beds)
          // After rotation: rw = rendered width, rh = rendered height
          const isRotatedHead = rw > rh; // headboard should be on the shorter dimension
          const hbW = isRotatedHead ? rh : rw;
          const hbH = isRotatedHead ? rw : rh;
          return (
          <>
            {/* Headboard — thin edge spanning the shorter side */}
            {isRotatedHead ? (
              <Rect x={0} y={0} width={hbH * 0.04} height={hbW} fill={strokeC} stroke={strokeC} strokeWidth={sw} />
            ) : (
              <Rect x={0} y={0} width={hbW} height={hbH * 0.04} fill={strokeC} stroke={strokeC} strokeWidth={sw} />
            )}
            {/* Mattress — main rectangle */}
            {isRotatedHead ? (
              <Rect x={hbH * 0.04} y={hbW * 0.03} width={hbH * 0.88} height={hbW * 0.94} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={5} />
            ) : (
              <Rect x={hbW * 0.03} y={hbH * 0.04} width={hbW * 0.94} height={hbH * 0.88} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={5} />
            )}
            {/* Two pillows at the head end */}
            {isRotatedHead ? (
              <>
                <Rect x={hbH * 0.08} y={hbW * 0.08} width={hbH * 0.14} height={hbW * 0.36} fill="#FFFFFF" stroke={strokeC} strokeWidth={0.6} cornerRadius={5} />
                <Rect x={hbH * 0.08} y={hbW * 0.56} width={hbH * 0.14} height={hbW * 0.36} fill="#FFFFFF" stroke={strokeC} strokeWidth={0.6} cornerRadius={5} />
              </>
            ) : (
              <>
                <Rect x={hbW * 0.08} y={hbH * 0.08} width={hbW * 0.36} height={hbH * 0.14} fill="#FFFFFF" stroke={strokeC} strokeWidth={0.6} cornerRadius={5} />
                <Rect x={hbW * 0.56} y={hbH * 0.08} width={hbW * 0.36} height={hbH * 0.14} fill="#FFFFFF" stroke={strokeC} strokeWidth={0.6} cornerRadius={5} />
              </>
            )}
            {/* Duvet fold line ~⅔ down the bed */}
            {isRotatedHead ? (
              <Line points={[hbH * 0.62, hbW * 0.08, hbH * 0.62, hbW * 0.92]} stroke={strokeC} strokeWidth={0.7} opacity={0.3} />
            ) : (
              <Line points={[hbW * 0.08, hbH * 0.62, hbW * 0.92, hbH * 0.62]} stroke={strokeC} strokeWidth={0.7} opacity={0.3} />
            )}
          </>
          );
        })()}

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

        {/* ============ KITCHEN COUNTER with built-in stove + sink ============ */}
        {(pf.itemId === "kitchen-counter-straight" || pf.itemId === "kitchen-counter-small") && !pf.itemId.includes("island") && (() => {
          // Counter is long-and-thin: stove + sink sit side-by-side along the LONG edge.
          // Horizontal (rw >= rh): stove left, sink right, spanning the depth (rh).
          // Vertical (rw < rh):   stove top, sink bottom, spanning the depth (rw).
          const isVert = rw < rh;
          return (
          <>
            {/* Main worktop surface */}
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={3} />
            {/* Stove — with hover */}
            <Group
              onMouseEnter={(e) => { e.cancelBubble = true; onFurnitureHover?.({ name: "4-Burner Stove", room: pf.room }); }}
              onMouseLeave={() => onFurnitureHover?.(null)}
            >
              {isVert ? (
                <>
                  <Rect x={rw * 0.1} y={rh * 0.04} width={rw * 0.8} height={rh * 0.38} fill="#2A2A2A" stroke="#555" strokeWidth={1} cornerRadius={3} />
                  {[[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([bx, by], bi) => (
                    <Group key={`cv-${bi}`}>
                      <Circle x={rw * (0.1 + 0.8 * bx)} y={rh * (0.04 + 0.38 * by)} radius={rw * 0.065} fill="#444" stroke="#777" strokeWidth={0.7} />
                      <Circle x={rw * (0.1 + 0.8 * bx)} y={rh * (0.04 + 0.38 * by)} radius={rw * 0.028} fill="#666" />
                      <Line points={[rw * (0.1 + 0.8 * bx - 0.05), rh * (0.04 + 0.38 * by), rw * (0.1 + 0.8 * bx + 0.05), rh * (0.04 + 0.38 * by)]} stroke="#666" strokeWidth={0.4} />
                      <Line points={[rw * (0.1 + 0.8 * bx), rh * (0.04 + 0.38 * by - 0.05), rw * (0.1 + 0.8 * bx), rh * (0.04 + 0.38 * by + 0.05)]} stroke="#666" strokeWidth={0.4} />
                    </Group>
                  ))}
                </>
              ) : (
                <>
                  <Rect x={rw * 0.04} y={rh * 0.08} width={rw * 0.38} height={rh * 0.84} fill="#2A2A2A" stroke="#555" strokeWidth={1} cornerRadius={3} />
                  {[[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([bx, by], bi) => (
                    <Group key={`ch-${bi}`}>
                      <Circle x={rw * (0.04 + 0.38 * bx)} y={rh * (0.08 + 0.84 * by)} radius={rw * 0.055} fill="#444" stroke="#777" strokeWidth={0.7} />
                      <Circle x={rw * (0.04 + 0.38 * bx)} y={rh * (0.08 + 0.84 * by)} radius={rw * 0.022} fill="#666" />
                      <Line points={[rw * (0.04 + 0.38 * bx - 0.04), rh * (0.08 + 0.84 * by), rw * (0.04 + 0.38 * bx + 0.04), rh * (0.08 + 0.84 * by)]} stroke="#666" strokeWidth={0.4} />
                      <Line points={[rw * (0.04 + 0.38 * bx), rh * (0.08 + 0.84 * by - 0.04), rw * (0.04 + 0.38 * bx), rh * (0.08 + 0.84 * by + 0.04)]} stroke="#666" strokeWidth={0.4} />
                    </Group>
                  ))}
                </>
              )}
            </Group>
            {/* Sink — with hover */}
            <Group
              onMouseEnter={(e) => { e.cancelBubble = true; onFurnitureHover?.({ name: "Kitchen Sink", room: pf.room }); }}
              onMouseLeave={() => onFurnitureHover?.(null)}
            >
              {isVert ? (
                <>
                  <Rect x={rw * 0.1} y={rh * 0.58} width={rw * 0.8} height={rh * 0.34} fill="#C0C8D0" stroke="#999" strokeWidth={0.8} cornerRadius={4} />
                  <Rect x={rw * 0.13} y={rh * 0.62} width={rw * 0.74} height={rh * 0.26} fill="#A8B4BC" stroke="#888" strokeWidth={0.4} cornerRadius={2} />
                  <Circle x={rw * 0.5} y={rh * 0.72} radius={rw * 0.04} fill="#777" />
                  <Circle x={rw * 0.85} y={rh * 0.56} radius={rw * 0.03} fill={strokeC} />
                </>
              ) : (
                <>
                  <Rect x={rw * 0.58} y={rh * 0.1} width={rw * 0.38} height={rh * 0.8} fill="#C0C8D0" stroke="#999" strokeWidth={0.8} cornerRadius={4} />
                  <Rect x={rw * 0.61} y={rh * 0.14} width={rw * 0.32} height={rh * 0.72} fill="#A8B4BC" stroke="#888" strokeWidth={0.4} cornerRadius={2} />
                  <Circle x={rw * 0.8} y={rh * 0.55} radius={rw * 0.035} fill="#777" />
                  <Circle x={rw * 0.78} y={rh * 0.08} radius={rw * 0.03} fill={strokeC} />
                  <Rect x={rw * 0.775} y={0} width={rw * 0.01} height={rh * 0.08} fill={strokeC} />
                </>
              )}
            </Group>
            {/* Counter edge highlight */}
            <Line points={[0, rh, rw, rh]} stroke={strokeC} strokeWidth={1.5} opacity={0.5} />
          </>
          );
        })()}

        {/* ============ KITCHEN ISLAND with built-in stove + sink ============ */}
        {pf.itemId === "kitchen-island" && (
          <>
            {/* Main worktop */}
            <Rect x={0} y={0} width={rw} height={rh} fill={fillC} stroke={strokeC} strokeWidth={sw} cornerRadius={4} />
            {/* Stove — embedded with hover */}
            <Group
              onMouseEnter={(e) => { e.cancelBubble = true; onFurnitureHover?.({ name: "4-Burner Stove", room: pf.room }); }}
              onMouseLeave={() => onFurnitureHover?.(null)}
            >
              <Rect x={rw * 0.06} y={rh * 0.1} width={rw * 0.32} height={rh * 0.38} fill="#2A2A2A" stroke="#555" strokeWidth={0.8} cornerRadius={3} />
              {[[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]].map(([bx, by], bi) => (
                <Group key={`ib-${bi}`}>
                  <Circle x={rw * (0.06 + 0.32 * bx)} y={rh * (0.1 + 0.38 * by)} radius={rw * 0.05} fill="#444" stroke="#777" strokeWidth={0.6} />
                  <Circle x={rw * (0.06 + 0.32 * bx)} y={rh * (0.1 + 0.38 * by)} radius={rw * 0.02} fill="#666" />
                </Group>
              ))}
            </Group>
            {/* Sink — embedded with hover */}
            <Group
              onMouseEnter={(e) => { e.cancelBubble = true; onFurnitureHover?.({ name: "Kitchen Sink", room: pf.room }); }}
              onMouseLeave={() => onFurnitureHover?.(null)}
            >
              <Rect x={rw * 0.62} y={rh * 0.12} width={rw * 0.26} height={rh * 0.35} fill="#C0C8D0" stroke="#999" strokeWidth={0.7} cornerRadius={4} />
              <Rect x={rw * 0.65} y={rh * 0.16} width={rw * 0.2} height={rh * 0.27} fill="#A8B4BC" stroke="#888" strokeWidth={0.3} cornerRadius={2} />
              <Circle x={rw * 0.77} y={rh * 0.34} radius={rw * 0.025} fill="#777" />
              <Circle x={rw * 0.74} y={rh * 0.1} radius={rw * 0.025} fill={strokeC} />
            </Group>
            {/* Overhang on bottom side (seating) */}
            <Rect x={0} y={rh * 0.6} width={rw} height={rh * 0.4} fill={fillC} stroke={strokeC} strokeWidth={sw / 2} cornerRadius={[0, 0, 3, 3]} opacity={0.6} />
            {/* Stool indicators */}
            <Rect x={rw * 0.12} y={rh * 0.68} width={rw * 0.16} height={rh * 0.2} fill={strokeC} cornerRadius={3} opacity={0.3} />
            <Rect x={rw * 0.42} y={rh * 0.68} width={rw * 0.16} height={rh * 0.2} fill={strokeC} cornerRadius={3} opacity={0.3} />
            <Rect x={rw * 0.72} y={rh * 0.68} width={rw * 0.16} height={rh * 0.2} fill={strokeC} cornerRadius={3} opacity={0.3} />
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

  if (rooms.length === 0) return null;

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
            const displayName = parts[0].displayLabel || parts[0].name;
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

                      {/* Doors — proper architectural symbols */}
                {doors.filter(d => {
                  const room = roomMap.get(d.room);
                  return room && parts.some(p => p.name === room.name);
                }).map((door, di) => {
                  const room = roomMap.get(door.room)!;
                  if (/hallway|corridor|foyer/i.test(room.name)) return null;
                  return renderDoor(room, door, s, bb);
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

                {/* Room label — moved to Layer 4 */}
              </Group>
            );
          })}
        </Layer>

        {/* ======== LAYER 2a: Rugs (below other furniture) ======== */}
        {placedFurniture && placedFurniture.length > 0 && (
          <Layer>
            {placedFurniture.filter(pf => pf.itemId.includes("rug")).map((pf, i) => renderFurnitureItem(pf, i))}
          </Layer>
        )}

        {/* ======== LAYER 2b: All other furniture ======== */}
        {placedFurniture && placedFurniture.length > 0 && (
          <Layer>
            {placedFurniture.filter(pf => !pf.itemId.includes("rug")).map((pf, i) => renderFurnitureItem(pf, i))}
          </Layer>
        )}

        {/* ======== LAYER 3: Annotations ======== */}
        <Layer listening={false}>
          {/* Building perimeter outline */}
          {buildingPolygon && buildingPolygon.length >= 3 && (() => {
            const pts = buildingPolygon.flatMap(p => {
              const sp = toCanvas(p.x, p.y, s, bb);
              return [sp.x, sp.y];
            });
            pts.push(pts[0], pts[1]);
            return (
              <Line
                points={pts}
                stroke="#c8c0b4" strokeWidth={2} dash={[8, 4]}
                fill="rgba(0,0,0,0)" lineJoin="round" tension={0} opacity={0.6}
              />
            );
          })()}

          {/* North arrow */}
          <Group x={STAGE_W - 38} y={28}>
            <Line points={[0, -8, -7, 6, 7, 6]} closed fill="#3a3a4a" />
            <Text x={-5} y={11} text="N" fontSize={10} fontStyle="bold" fill="#3a3a4a" width={10} align="center" />
          </Group>

          {/* E.Hallway marker — building shared corridor (apartments only) */}
          {entranceApproach && (() => {
            const ePos = toCanvas(entranceApproach.eHallX, entranceApproach.eHallY, s, bb);
            return (
              <Group>
                {/* E.Hallway label — small rectangle outside the building, near the main entrance */}
                <Rect
                  x={ePos.x - 30} y={ePos.y - 10}
                  width={60} height={18}
                  fill="#fef3c7" stroke="#e67e22" strokeWidth={1.2}
                  cornerRadius={4}
                />
                <Text
                  x={ePos.x - 28} y={ePos.y - 8}
                  text="E.Hallway" fontSize={9} fontStyle="bold" fill="#b45309"
                  width={56} height={14} align="center" verticalAlign="middle"
                />
              </Group>
            );
          })()}

          {/* Scale bar */}
          <Group x={16} y={STAGE_H - 20}>
            <Line points={[0, 0, 5 * s, 0]} stroke="#3a3a4a" strokeWidth={1.5} />
            <Line points={[0, -6, 0, 6]} stroke="#3a3a4a" strokeWidth={1} />
            <Line points={[5 * s, -6, 5 * s, 6]} stroke="#3a3a4a" strokeWidth={1} />
            <Text x={2.5 * s - 10} y={10} text="5m" fontSize={10} fill="#999" width={20} align="center" />
          </Group>
        </Layer>

        {/* ======== LAYER 4: Text on top of everything ======== */}
        <Layer listening={false}>
          {grouped.map(([key, parts]) => {
            const center = roomCenter(parts[0]);
            const cPx = toCanvas(center.x, center.y, s, bb);
            const displayName = parts[0].displayLabel || parts[0].name;
            const totalArea = parts.reduce((sum, p) => sum + p.area, 0);
            return (
              <Group key={`label-${key}`}>
                <Text x={cPx.x - 55} y={cPx.y - 20} width={110} height={18}
                  text={displayName} fontSize={11} fontStyle="bold" fill="#2d2d3f"
                  align="center" verticalAlign="middle" fontFamily="system-ui, sans-serif"
                  shadowColor="#ffffff" shadowBlur={3} shadowOpacity={0.8} />
                <Text x={cPx.x - 55} y={cPx.y} width={110} height={14}
                  text={`${totalArea.toFixed(1)} m²`} fontSize={9} fill="#666"
                  align="center" verticalAlign="middle" fontFamily="system-ui, sans-serif"
                  shadowColor="#ffffff" shadowBlur={2} shadowOpacity={0.7} />
              </Group>
            );
          })}
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
