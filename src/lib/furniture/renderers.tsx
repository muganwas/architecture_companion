/* ------------------------------------------------------------------ */
/*  Furniture renderers — each draws to a Konva Group at (w)×(h)      */
/*  Coordinates are in meters (real-world scale).                      */
/* ------------------------------------------------------------------ */

import React from "react";
import { Group, Rect, Circle, Ellipse, Line, Text, RegularPolygon } from "react-konva";
import { FurnitureItem } from "./types";

interface RenderContext {
  /** Item metadata */
  item: FurnitureItem;
  /** Target width in scene units (meters) */
  w: number;
  /** Target height in scene units (meters) */
  h: number;
}

/**
 * Main render dispatcher — returns a Konva <Group> for the given item.
 */
export function renderFurniture(item: FurnitureItem, w: number, h: number): React.ReactElement {
  const ctx: RenderContext = { item, w, h };
  const fn = renderers[item.renderer];
  if (!fn) {
    // Fallback: simple colored rectangle with label
    return (
      <Group>
        <Rect x={0} y={0} width={w} height={h} fill={item.fill} stroke={item.stroke} strokeWidth={0.02} cornerRadius={0.05} />
        <Text x={0} y={0} width={w} height={h} text={item.name} fontSize={0.12} fill="#333" align="center" verticalAlign="middle" />
      </Group>
    );
  }
  return fn(ctx);
}

/* ================================================================== */
/*  Individual renderers                                               */
/* ================================================================== */

const renderers: Record<string, (ctx: RenderContext) => React.ReactElement> = {

  /* ---------- SOFA 3-SEATER ---------- */
  "sofa-3": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const armW = w * 0.12;
    const backH = h * 0.3;
    return (
      <Group>
        {/* Backrest */}
        <Rect x={0} y={0} width={w} height={backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0.06, 0.06, 0, 0]} />
        {/* Seat cushions */}
        <Rect x={armW} y={backH} width={w - armW * 2} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.04} />
        {/* Left armrest */}
        <Rect x={0} y={backH} width={armW} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0, 0, 0.04, 0.04]} />
        {/* Right armrest */}
        <Rect x={w - armW} y={backH} width={armW} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0, 0, 0.04, 0.04]} />
        {/* Cushion lines */}
        <Line points={[w * 0.38, backH, w * 0.38, h]} stroke={stroke} strokeWidth={0.01} opacity={0.4} />
        <Line points={[w * 0.62, backH, w * 0.62, h]} stroke={stroke} strokeWidth={0.01} opacity={0.4} />
      </Group>
    );
  },

  /* ---------- SOFA 2-SEATER ---------- */
  "sofa-2": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const armW = w * 0.12;
    const backH = h * 0.3;
    return (
      <Group>
        <Rect x={0} y={0} width={w} height={backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0.06, 0.06, 0, 0]} />
        <Rect x={armW} y={backH} width={w - armW * 2} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.04} />
        <Rect x={0} y={backH} width={armW} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0, 0, 0.04, 0.04]} />
        <Rect x={w - armW} y={backH} width={armW} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0, 0, 0.04, 0.04]} />
        <Line points={[w * 0.5, backH, w * 0.5, h]} stroke={stroke} strokeWidth={0.01} opacity={0.4} />
      </Group>
    );
  },

  /* ---------- ARMCHAIR ---------- */
  "armchair": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const pad = w * 0.1;
    const backH = h * 0.28;
    return (
      <Group>
        <Rect x={0} y={0} width={w} height={backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0.08, 0.08, 0, 0]} />
        <Rect x={pad} y={backH} width={w - pad * 2} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.05} />
        <Rect x={0} y={backH} width={pad} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0, 0, 0.05, 0.05]} />
        <Rect x={w - pad} y={backH} width={pad} height={h - backH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0, 0, 0.05, 0.05]} />
      </Group>
    );
  },

  /* ---------- DINING CHAIR ---------- */
  "dining-chair": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const seatH = h * 0.35;
    const backW = w * 0.15;
    return (
      <Group>
        {/* Seat */}
        <Rect x={0} y={seatH} width={w} height={h - seatH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.04} />
        {/* Backrest */}
        <Rect x={0} y={0} width={backW} height={seatH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0.04, 0, 0, 0]} />
        {/* Legs (4 dots) */}
        <Circle x={w * 0.2} y={h - 0.05} radius={0.03} fill={stroke} />
        <Circle x={w * 0.8} y={h - 0.05} radius={0.03} fill={stroke} />
        <Circle x={w * 0.2} y={seatH + 0.05} radius={0.03} fill={stroke} />
        <Circle x={w * 0.8} y={seatH + 0.05} radius={0.03} fill={stroke} />
      </Group>
    );
  },

  /* ---------- OFFICE CHAIR ---------- */
  "office-chair": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Base (circle) */}
        <Circle x={w / 2} y={h * 0.75} radius={w * 0.35} fill={stroke} opacity={0.3} />
        {/* Seat */}
        <Rect x={w * 0.1} y={h * 0.35} width={w * 0.8} height={h * 0.35} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.06} />
        {/* Backrest */}
        <Rect x={w * 0.05} y={0} width={w * 0.2} height={h * 0.45} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0.06, 0.06, 0, 0]} />
        {/* Center pole */}
        <Line points={[w / 2, h * 0.7, w / 2, h * 0.85]} stroke={stroke} strokeWidth={0.015} />
      </Group>
    );
  },

  /* ---------- DINING TABLE (RECTANGULAR) ---------- */
  "dining-table-rect": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Table top */}
        <Rect x={w * 0.05} y={h * 0.05} width={w * 0.9} height={h * 0.9} fill={fill} stroke={stroke} strokeWidth={0.025} cornerRadius={0.06} />
        {/* Wood grain line */}
        <Line points={[w * 0.1, h * 0.5, w * 0.9, h * 0.5]} stroke={stroke} strokeWidth={0.008} opacity={0.3} />
      </Group>
    );
  },

  /* ---------- COFFEE TABLE ---------- */
  "coffee-table": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Legs */}
        <Rect x={0.03} y={0.03} width={0.06} height={0.06} fill={stroke} />
        <Rect x={w - 0.09} y={0.03} width={0.06} height={0.06} fill={stroke} />
        <Rect x={0.03} y={h - 0.09} width={0.06} height={0.06} fill={stroke} />
        <Rect x={w - 0.09} y={h - 0.09} width={0.06} height={0.06} fill={stroke} />
        {/* Top */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.05} />
        {/* Lower shelf hint */}
        <Rect x={w * 0.1} y={h * 0.5} width={w * 0.8} height={h * 0.45} fill={fill} stroke={stroke} strokeWidth={0.01} cornerRadius={0.03} opacity={0.5} />
      </Group>
    );
  },

  /* ---------- SIDE TABLE ---------- */
  "side-table": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Leg */}
        <Rect x={w * 0.4} y={h * 0.3} width={w * 0.2} height={h * 0.7} fill={stroke} />
        {/* Base */}
        <Circle x={w / 2} y={h * 0.95} radius={w * 0.35} fill={stroke} opacity={0.5} />
        {/* Top */}
        <Circle x={w / 2} y={h * 0.2} radius={w * 0.45} fill={fill} stroke={stroke} strokeWidth={0.02} />
      </Group>
    );
  },

  /* ---------- DESK ---------- */
  "desk": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const topH = h * 0.15;
    return (
      <Group>
        {/* Desk surface */}
        <Rect x={0} y={0} width={w} height={topH} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.03} />
        {/* Left drawer stack */}
        <Rect x={w * 0.05} y={topH} width={w * 0.25} height={h - topH} fill={fill} stroke={stroke} strokeWidth={0.015} cornerRadius={0.02} />
        <Line points={[w * 0.05, topH + (h - topH) * 0.33, w * 0.3, topH + (h - topH) * 0.33]} stroke={stroke} strokeWidth={0.01} opacity={0.4} />
        <Line points={[w * 0.05, topH + (h - topH) * 0.66, w * 0.3, topH + (h - topH) * 0.66]} stroke={stroke} strokeWidth={0.01} opacity={0.4} />
        {/* Right leg */}
        <Rect x={w * 0.7} y={topH} width={w * 0.06} height={h - topH} fill={stroke} />
      </Group>
    );
  },

  /* ---------- BED (with mattress + pillows) ---------- */
  "bed": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const headboardW = w * 0.08;
    return (
      <Group>
        {/* Headboard */}
        <Rect x={0} y={0} width={w} height={headboardW} fill={stroke} stroke={stroke} strokeWidth={0.015} cornerRadius={[0.04, 0.04, 0, 0]} />
        {/* Mattress */}
        <Rect x={w * 0.03} y={headboardW} width={w * 0.94} height={h * 0.55} fill={fill} stroke={stroke} strokeWidth={0.015} cornerRadius={0.04} />
        {/* Pillows */}
        <Rect x={w * 0.1} y={headboardW + 0.02} width={w * 0.35} height={h * 0.12} fill="#FFFFFF" stroke={stroke} strokeWidth={0.01} cornerRadius={0.05} />
        <Rect x={w * 0.55} y={headboardW + 0.02} width={w * 0.35} height={h * 0.12} fill="#FFFFFF" stroke={stroke} strokeWidth={0.01} cornerRadius={0.05} />
        {/* Blanket fold line */}
        <Line points={[w * 0.03, headboardW + h * 0.4, w * 0.97, headboardW + h * 0.4]} stroke={stroke} strokeWidth={0.01} opacity={0.3} />
      </Group>
    );
  },

  /* ---------- TOILET ---------- */
  "toilet": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Cistern */}
        <Rect x={w * 0.15} y={0} width={w * 0.7} height={h * 0.25} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0.06, 0.06, 0, 0]} />
        {/* Bowl */}
        <Ellipse x={w / 2} y={h * 0.5} radiusX={w * 0.35} radiusY={h * 0.25} fill={fill} stroke={stroke} strokeWidth={0.02} />
        {/* Seat */}
        <Ellipse x={w / 2} y={h * 0.62} radiusX={w * 0.3} radiusY={h * 0.18} fill="#FAFAFA" stroke={stroke} strokeWidth={0.015} />
      </Group>
    );
  },

  /* ---------- BATHROOM SINK ---------- */
  "sink-bathroom": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Counter */}
        <Rect x={0} y={0} width={w} height={h * 0.3} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.04} />
        {/* Basin */}
        <Ellipse x={w / 2} y={h * 0.25} radiusX={w * 0.3} radiusY={h * 0.18} fill="#E8ECEF" stroke={stroke} strokeWidth={0.015} />
        {/* Faucet dot */}
        <Circle x={w / 2} y={h * 0.12} radius={0.03} fill={stroke} />
        {/* Pedestal */}
        <Rect x={w * 0.35} y={h * 0.35} width={w * 0.3} height={h * 0.65} fill={fill} stroke={stroke} strokeWidth={0.015} cornerRadius={0.03} />
      </Group>
    );
  },

  /* ---------- BATHTUB ---------- */
  "bathtub": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Tub body (rounded rect shape via ellipse) */}
        <Rect x={0} y={h * 0.1} width={w} height={h * 0.8} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.12} />
        {/* Inner tub */}
        <Rect x={w * 0.08} y={h * 0.15} width={w * 0.84} height={h * 0.7} fill="#E8ECEF" stroke={stroke} strokeWidth={0.015} cornerRadius={0.08} />
        {/* Faucet end */}
        <Rect x={w * 0.35} y={0} width={w * 0.3} height={h * 0.12} fill={stroke} cornerRadius={[0.03, 0.03, 0, 0]} />
        <Circle x={w / 2} y={h * 0.08} radius={0.025} fill="#88BBEE" />
      </Group>
    );
  },

  /* ---------- SHOWER ---------- */
  "shower": ({ item, w, h }) => {
    const stroke = item.stroke;
    return (
      <Group>
        {/* Tray */}
        <Rect x={0} y={h * 0.85} width={w} height={h * 0.15} fill="#D0D0D0" stroke={stroke} strokeWidth={0.015} cornerRadius={0.03} />
        {/* Glass walls */}
        <Line points={[0, 0, 0, h * 0.85]} stroke="#AAD4F0" strokeWidth={0.025} opacity={0.6} />
        <Line points={[w, 0, w, h * 0.85]} stroke="#AAD4F0" strokeWidth={0.025} opacity={0.6} />
        <Line points={[0, 0, w, 0]} stroke="#AAD4F0" strokeWidth={0.02} opacity={0.4} />
        {/* Shower head */}
        <Circle x={w / 2} y={h * 0.1} radius={w * 0.12} fill="#88BBEE" stroke={stroke} strokeWidth={0.01} />
        {/* Dots for spray */}
        <Circle x={w * 0.35} y={h * 0.1} radius={0.015} fill="#AAD4F0" />
        <Circle x={w / 2} y={h * 0.1} radius={0.015} fill="#AAD4F0" />
        <Circle x={w * 0.65} y={h * 0.1} radius={0.015} fill="#AAD4F0" />
      </Group>
    );
  },

  /* ---------- KITCHEN COUNTER (STRAIGHT) ---------- */
  "kitchen-counter": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Counter top */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.03} />
        {/* Worktop edge highlight */}
        <Rect x={0} y={0} width={w} height={h * 0.15} fill={fill} stroke={stroke} strokeWidth={0.015} cornerRadius={[0.03, 0.03, 0, 0]} opacity={0.6} />
        {/* Drawer/cabinet lines */}
        <Line points={[w * 0.33, h * 0.2, w * 0.33, h]} stroke={stroke} strokeWidth={0.01} opacity={0.3} />
        <Line points={[w * 0.66, h * 0.2, w * 0.66, h]} stroke={stroke} strokeWidth={0.01} opacity={0.3} />
      </Group>
    );
  },

  /* ---------- KITCHEN COUNTER (L-SHAPED) ---------- */
  "kitchen-counter-l": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const thick = w * 0.3;
    return (
      <Group>
        {/* Vertical leg */}
        <Rect x={0} y={0} width={thick} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0.03, 0, 0, 0.03]} />
        {/* Horizontal leg */}
        <Rect x={thick} y={h - thick} width={w - thick} height={thick} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={[0, 0.03, 0.03, 0]} />
      </Group>
    );
  },

  /* ---------- STOVE/OVEN ---------- */
  "stove": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Body */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.025} cornerRadius={0.04} />
        {/* Top cook surface */}
        <Rect x={w * 0.05} y={h * 0.05} width={w * 0.9} height={h * 0.35} fill="#333" stroke={stroke} strokeWidth={0.015} cornerRadius={0.03} />
        {/* Burners */}
        <Circle x={w * 0.25} y={h * 0.2} radius={w * 0.1} fill="#444" stroke="#666" strokeWidth={0.01} />
        <Circle x={w * 0.75} y={h * 0.2} radius={w * 0.1} fill="#444" stroke="#666" strokeWidth={0.01} />
        <Circle x={w * 0.25} y={h * 0.2} radius={w * 0.04} fill="#555" />
        <Circle x={w * 0.75} y={h * 0.2} radius={w * 0.04} fill="#555" />
        {/* Oven window */}
        <Rect x={w * 0.1} y={h * 0.5} width={w * 0.8} height={h * 0.35} fill="#222" stroke="#555" strokeWidth={0.015} cornerRadius={0.03} />
        {/* Oven handle */}
        <Rect x={w * 0.25} y={h * 0.48} width={w * 0.5} height={h * 0.04} fill="#888" cornerRadius={0.01} />
        {/* Knobs */}
        <Circle x={w * 0.15} y={h * 0.9} radius={0.03} fill="#666" />
        <Circle x={w * 0.4} y={h * 0.9} radius={0.03} fill="#666" />
        <Circle x={w * 0.65} y={h * 0.9} radius={0.03} fill="#666" />
        <Circle x={w * 0.85} y={h * 0.9} radius={0.03} fill="#666" />
      </Group>
    );
  },

  /* ---------- REFRIGERATOR ---------- */
  "refrigerator": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Body */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.025} cornerRadius={0.04} />
        {/* Freezer door (top) */}
        <Rect x={w * 0.05} y={h * 0.03} width={w * 0.9} height={h * 0.3} fill="#F0F0F0" stroke="#CCC" strokeWidth={0.01} cornerRadius={0.02} />
        {/* Fridge door (bottom) */}
        <Rect x={w * 0.05} y={h * 0.37} width={w * 0.9} height={h * 0.58} fill="#F8F8F8" stroke="#CCC" strokeWidth={0.01} cornerRadius={0.02} />
        {/* Handles */}
        <Rect x={w * 0.75} y={h * 0.12} width={w * 0.1} height={h * 0.08} fill="#999" cornerRadius={0.01} />
        <Rect x={w * 0.75} y={h * 0.55} width={w * 0.1} height={h * 0.08} fill="#999" cornerRadius={0.01} />
      </Group>
    );
  },

  /* ---------- KITCHEN SINK ---------- */
  "kitchen-sink": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Rim */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.04} />
        {/* Basin */}
        <Rect x={w * 0.08} y={h * 0.08} width={w * 0.84} height={h * 0.84} fill="#C0C8D0" stroke={stroke} strokeWidth={0.015} cornerRadius={0.03} />
        {/* Drain */}
        <Circle x={w * 0.7} y={h * 0.65} radius={w * 0.06} fill="#999" />
        {/* Faucet base */}
        <Circle x={w / 2} y={0} radius={0.03} fill={stroke} />
      </Group>
    );
  },

  /* ---------- KITCHEN ISLAND ---------- */
  "kitchen-island": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    const overhang = w * 0.04;
    return (
      <Group>
        {/* Overhang wrapping */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.025} cornerRadius={0.04} />
        {/* Worktop surface */}
        <Rect x={overhang} y={overhang} width={w - overhang * 2} height={h - overhang * 2} fill={fill} stroke={stroke} strokeWidth={0.015} cornerRadius={0.03} opacity={0.7} />
        {/* Stool seating on one long side */}
        <Rect x={w * 0.1} y={h * 0.15} width={w * 0.12} height={h * 0.15} fill={stroke} opacity={0.4} cornerRadius={0.03} />
        <Rect x={w * 0.4} y={h * 0.15} width={w * 0.12} height={h * 0.15} fill={stroke} opacity={0.4} cornerRadius={0.03} />
        <Rect x={w * 0.7} y={h * 0.15} width={w * 0.12} height={h * 0.15} fill={stroke} opacity={0.4} cornerRadius={0.03} />
      </Group>
    );
  },

  /* ---------- WARDROBE ---------- */
  "wardrobe": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Body */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.03} />
        {/* Left door */}
        <Rect x={w * 0.04} y={h * 0.03} width={w * 0.44} height={h * 0.94} fill={fill} stroke={stroke} strokeWidth={0.01} cornerRadius={0.02} opacity={0.7} />
        {/* Right door */}
        <Rect x={w * 0.52} y={h * 0.03} width={w * 0.44} height={h * 0.94} fill={fill} stroke={stroke} strokeWidth={0.01} cornerRadius={0.02} opacity={0.7} />
        {/* Handles */}
        <Rect x={w * 0.44} y={h * 0.35} width={w * 0.04} height={h * 0.1} fill={stroke} cornerRadius={0.01} />
        <Rect x={w * 0.52} y={h * 0.35} width={w * 0.04} height={h * 0.1} fill={stroke} cornerRadius={0.01} />
      </Group>
    );
  },

  /* ---------- BOOKSHELF ---------- */
  "bookshelf": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Frame */}
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.02} />
        {/* Shelves */}
        <Line points={[0, h * 0.33, w, h * 0.33]} stroke={stroke} strokeWidth={0.015} />
        <Line points={[0, h * 0.66, w, h * 0.66]} stroke={stroke} strokeWidth={0.015} />
        {/* Book spines (top shelf) */}
        <Rect x={w * 0.05} y={h * 0.05} width={w * 0.06} height={h * 0.22} fill="#D44" cornerRadius={0.005} />
        <Rect x={w * 0.13} y={h * 0.05} width={w * 0.05} height={h * 0.25} fill="#48B" cornerRadius={0.005} />
        <Rect x={w * 0.2} y={h * 0.05} width={w * 0.07} height={h * 0.2} fill="#4A4" cornerRadius={0.005} />
        <Rect x={w * 0.29} y={h * 0.05} width={w * 0.04} height={h * 0.24} fill="#E94" cornerRadius={0.005} />
        {/* Book spines (middle shelf) */}
        <Rect x={w * 0.06} y={h * 0.38} width={w * 0.06} height={h * 0.22} fill="#68B" cornerRadius={0.005} />
        <Rect x={w * 0.14} y={h * 0.38} width={w * 0.05} height={h * 0.2} fill="#A4A" cornerRadius={0.005} />
        <Rect x={w * 0.21} y={h * 0.38} width={w * 0.08} height={h * 0.23} fill="#8B4" cornerRadius={0.005} />
      </Group>
    );
  },

  /* ---------- CABINET ---------- */
  "cabinet": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.03} />
        {/* Doors */}
        <Rect x={w * 0.04} y={h * 0.04} width={w * 0.44} height={h * 0.92} fill={fill} stroke={stroke} strokeWidth={0.01} cornerRadius={0.02} opacity={0.6} />
        <Rect x={w * 0.52} y={h * 0.04} width={w * 0.44} height={h * 0.92} fill={fill} stroke={stroke} strokeWidth={0.01} cornerRadius={0.02} opacity={0.6} />
        {/* Knobs */}
        <Circle x={w * 0.42} y={h * 0.5} radius={0.02} fill={stroke} />
        <Circle x={w * 0.58} y={h * 0.5} radius={0.02} fill={stroke} />
      </Group>
    );
  },

  /* ---------- WALL CABINET (UPPER, MOUNTED) ---------- */
  "wall-cabinet": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.03} />
        {/* Doors */}
        <Rect x={w * 0.05} y={h * 0.08} width={w * 0.42} height={h * 0.84} fill={fill} stroke={stroke} strokeWidth={0.01} cornerRadius={0.02} opacity={0.7} />
        <Rect x={w * 0.53} y={h * 0.08} width={w * 0.42} height={h * 0.84} fill={fill} stroke={stroke} strokeWidth={0.01} cornerRadius={0.02} opacity={0.7} />
        {/* Knobs */}
        <Circle x={w * 0.42} y={h * 0.5} radius={0.02} fill={stroke} />
        <Circle x={w * 0.58} y={h * 0.5} radius={0.02} fill={stroke} />
      </Group>
    );
  },

  /* ---------- RUG ---------- */
  "rug": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        <Rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.06} opacity={0.8} />
        {/* Border pattern */}
        <Rect x={w * 0.04} y={h * 0.04} width={w * 0.92} height={h * 0.92} fill="none" stroke={stroke} strokeWidth={0.015} cornerRadius={0.04} opacity={0.4} />
        <Rect x={w * 0.08} y={h * 0.08} width={w * 0.84} height={h * 0.84} fill="none" stroke={stroke} strokeWidth={0.01} cornerRadius={0.03} opacity={0.3} />
        {/* Center diamond */}
        <Line points={[w / 2, h * 0.2, w * 0.8, h / 2, w / 2, h * 0.8, w * 0.2, h / 2]} closed fill={fill} stroke={stroke} strokeWidth={0.01} opacity={0.3} />
      </Group>
    );
  },

  /* ---------- INDOOR PLANT ---------- */
  "plant": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Pot */}
        <RegularPolygon sides={4} x={w / 2} y={h * 0.75} radius={w * 0.35} fill="#C4956A" stroke="#8B6535" strokeWidth={0.015} />
        {/* Leaves (circles overlapping) */}
        <Circle x={w * 0.5} y={h * 0.35} radius={w * 0.25} fill={fill} stroke={stroke} strokeWidth={0.01} />
        <Circle x={w * 0.3} y={h * 0.45} radius={w * 0.22} fill={fill} stroke={stroke} strokeWidth={0.01} opacity={0.8} />
        <Circle x={w * 0.7} y={h * 0.4} radius={w * 0.2} fill={fill} stroke={stroke} strokeWidth={0.01} opacity={0.7} />
        <Circle x={w * 0.5} y={h * 0.2} radius={w * 0.18} fill={fill} stroke={stroke} strokeWidth={0.01} opacity={0.9} />
        {/* Stem */}
        <Line points={[w / 2, h * 0.65, w / 2, h * 0.4]} stroke={stroke} strokeWidth={0.015} />
      </Group>
    );
  },

  /* ---------- TV UNIT ---------- */
  "tv-unit": ({ item, w, h }) => {
    const fill = item.fill;
    const stroke = item.stroke;
    return (
      <Group>
        {/* Stand/console */}
        <Rect x={0} y={h * 0.6} width={w} height={h * 0.4} fill={fill} stroke={stroke} strokeWidth={0.02} cornerRadius={0.03} />
        {/* Screen */}
        <Rect x={w * 0.05} y={h * 0.05} width={w * 0.9} height={h * 0.55} fill="#1A1A2E" stroke={stroke} strokeWidth={0.02} cornerRadius={0.04} />
        {/* Screen reflection */}
        <Rect x={w * 0.1} y={h * 0.1} width={w * 0.3} height={h * 0.15} fill="#FFFFFF" opacity={0.06} cornerRadius={0.02} />
        {/* Stand legs */}
        <Rect x={w * 0.1} y={h * 0.88} width={w * 0.08} height={h * 0.12} fill={stroke} cornerRadius={0.01} />
        <Rect x={w * 0.82} y={h * 0.88} width={w * 0.08} height={h * 0.12} fill={stroke} cornerRadius={0.01} />
      </Group>
    );
  },
};
