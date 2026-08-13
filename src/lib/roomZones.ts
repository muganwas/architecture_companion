/* ------------------------------------------------------------------ */
/*  Room zones — imaginary walls that cut rooms into color-coded      */
/*  functional areas (bed / living / kitchen).                        */
/*                                                                     */
/*  Ratio rules (space is measured AFTER the ensuite/bathroom has been */
/*  cut out — zones never overlap the ensuite or each other):          */
/*                                                                     */
/*   One-bedroom home WITHOUT a dedicated kitchen (open-plan living):  */
/*     kitchen area : living area = 13 : 27                             */
/*                                                                     */
/*   Studio:                                                           */
/*     large enough → bed : kitchen : living = 15 : 7 : 18             */
/*       (10% of the living share was moved into the cooking share)    */
/*     smaller       → bed : living         = 1 : 2                    */
/*     too small     → the whole space is the sleeping (bed) area      */
/*                                                                     */
/*  Zones are plain RECTANGLES — each zone is a single rectangle (rooms   */
/*  with invisible walls, no L-shapes or split pieces). One zone may get  */
/*  a slightly different area when a carved bathroom forces the free     */
/*  space into multiple pieces; the ratios stay exact whenever a single  */
/*  piece hosts all the zones.                                           */
/*                                                                     */
/*  Studio door rules (applied when doors are known):                  */
/*    the living zone must sit at the main entrance (kitchen stays    */
/*    north), and the bed zone must be closest to the carved          */
/*    bathroom's door.                                                */
/* ------------------------------------------------------------------ */

import { GeneratedRoom, Door, Window } from "./ai-client";
import { PlacedFurniture } from "./furniture";

export type ZoneKind = "bed" | "living" | "kitchen";

/** One rectangle of a zone's contiguous region. */
export interface ZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A color-coded functional zone inside a room (imaginary walls). */
export interface RoomZone {
  room: string;
  kind: ZoneKind;
  /** The zone's rectangles — together ONE contiguous space. */
  rects: ZoneRect[];
  /** Bounding box (label anchor / quick checks). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Minimum usable (post-ensuite) area thresholds for studio zone counts. */
const STUDIO_THREE_ZONE_MIN = 16; // m² — bed + kitchen + living (1:1:2)
const STUDIO_TWO_ZONE_MIN = 9;    // m² — bed + living (1:2); below → bed only

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SlotRect extends Rect {
  piece: number; // which free-space piece this rect was carved from
}

interface Slot {
  rects: SlotRect[];
}

function rectArea(r: Rect): number {
  return r.w * r.h;
}

function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Squared distance from a point to the nearest rectangle in `rects`. */
function distToRects(p: { x: number; y: number }, rects: Rect[]): number {
  let best = Infinity;
  for (const r of rects) {
    const cx = Math.max(r.x, Math.min(p.x, r.x + r.w));
    const cy = Math.max(r.y, Math.min(p.y, r.y + r.h));
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

export function isBedItemId(id: string): boolean {
  return id.startsWith("bed-");
}

export function isKitchenItemId(id: string): boolean {
  return /kitchen-counter|kitchen-island|refrigerator|stove|kitchen-sink|wall-cabinet/.test(id);
}

export function isLivingItemId(id: string): boolean {
  return /sofa-|coffee-table|tv-unit|armchair|side-table|rug-/.test(id);
}

/**
 * True when an axis-aligned box (x, y = bottom-left corner, w/h = size)
 * lies FULLY inside the zone's rectangles (the union of the rects).
 * Used by the furniture placer to enforce zone separation.
 */
export function boxInsideZone(
  x: number, y: number, w: number, h: number,
  rects: ZoneRect[]
): boolean {
  if (rects.length === 0) return false;
  // Subtract the zone rects from the box — nothing may remain uncovered.
  const holes: Rect[] = rects.map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
  return subtractHoles({ x, y, w, h }, holes).length === 0;
}

/** Axis-aligned rectangles of `room` minus the holes (carved ensuite/bathroom). */
function subtractHoles(room: Rect, holes: Rect[]): Rect[] {
  let pieces: Rect[] = [room];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const p of pieces) {
      const ix = Math.max(p.x, h.x);
      const iy = Math.max(p.y, h.y);
      const ix2 = Math.min(p.x + p.w, h.x + h.w);
      const iy2 = Math.min(p.y + p.h, h.y + h.h);
      if (ix >= ix2 || iy >= iy2) {
        next.push(p); // no intersection with this hole
        continue;
      }
      // Slice the piece around the hole intersection (4 strips).
      if (iy > p.y) next.push({ x: p.x, y: p.y, w: p.w, h: iy - p.y });
      if (iy2 < p.y + p.h) next.push({ x: p.x, y: iy2, w: p.w, h: p.y + p.h - iy2 });
      if (ix > p.x) next.push({ x: p.x, y: iy, w: ix - p.x, h: iy2 - iy });
      if (ix2 < p.x + p.w) next.push({ x: ix2, y: iy, w: p.x + p.w - ix2, h: iy2 - iy });
    }
    pieces = next;
  }
  return pieces.filter(p => rectArea(p) > 1e-6);
}

/**
 * Carve the free pieces into kindless slots whose areas follow the weights,
 * in a deterministic spatial order (splits along the longer axis).
 *
 * When a slot continues into a NEW piece, the band is carved from the side
 * of that piece that borders the slot's existing rects — so a zone always
 * stays ONE contiguous space (zones behave like rooms with invisible walls).
 */
function carveSlots(pieces: Rect[], weights: number[]): Slot[] {
  const totalW = weights.reduce((s, w) => s + w, 0);
  const totalA = pieces.reduce((s, p) => s + rectArea(p), 0);
  const avail: Array<{ rect: Rect; piece: number }> = pieces.map((p, i) => ({ rect: { ...p }, piece: i }));
  const slots: Slot[] = [];
  const EPS = 1e-6;

  for (const w of weights) {
    let target = (w / totalW) * totalA;
    const rects: SlotRect[] = [];
    while (target > EPS && avail.length > 0) {
      const p = avail[0].rect;
      const pieceIdx = avail[0].piece;
      const pa = rectArea(p);
      if (pa <= target + EPS) {
        rects.push({ ...p, piece: pieceIdx });
        avail.shift();
        target -= pa;
        continue;
      }

      // Does this slot already own rects? Carve the new band from the side
      // of THIS piece that borders them (bottom/top/left/right), so the
      // continuation stays attached to the zone's existing space.
      let side: "bottom" | "top" | "left" | "right" | null = null;
      if (rects.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const r of rects) {
          minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
        }
        if (maxY <= p.y + EPS) side = "bottom";
        else if (minY >= p.y + p.h - EPS) side = "top";
        else if (maxX <= p.x + EPS) side = "left";
        else if (minX >= p.x + p.w - EPS) side = "right";
      }

      if (side === "bottom") {
        const h1 = target / p.w;
        rects.push({ x: p.x, y: p.y, w: p.w, h: h1, piece: pieceIdx });
        avail[0] = { rect: { x: p.x, y: p.y + h1, w: p.w, h: p.h - h1 }, piece: pieceIdx };
      } else if (side === "top") {
        const h1 = target / p.w;
        rects.push({ x: p.x, y: p.y + p.h - h1, w: p.w, h: h1, piece: pieceIdx });
        avail[0] = { rect: { x: p.x, y: p.y, w: p.w, h: p.h - h1 }, piece: pieceIdx };
      } else if (side === "left") {
        const w1 = target / p.h;
        rects.push({ x: p.x, y: p.y, w: w1, h: p.h, piece: pieceIdx });
        avail[0] = { rect: { x: p.x + w1, y: p.y, w: p.w - w1, h: p.h }, piece: pieceIdx };
      } else if (side === "right") {
        const w1 = target / p.h;
        rects.push({ x: p.x + p.w - w1, y: p.y, w: w1, h: p.h, piece: pieceIdx });
        avail[0] = { rect: { x: p.x, y: p.y, w: p.w - w1, h: p.h }, piece: pieceIdx };
      } else {
        const splitX = p.w >= p.h;
        if (splitX) {
          const w1 = target / p.h;
          rects.push({ x: p.x, y: p.y, w: w1, h: p.h, piece: pieceIdx });
          avail[0] = { rect: { x: p.x + w1, y: p.y, w: p.w - w1, h: p.h }, piece: pieceIdx };
        } else {
          const h1 = target / p.w;
          rects.push({ x: p.x, y: p.y, w: p.w, h: h1, piece: pieceIdx });
          avail[0] = { rect: { x: p.x, y: p.y + h1, w: p.w, h: p.h - h1 }, piece: pieceIdx };
        }
      }
      target = 0;
    }
    slots.push({ rects });
  }
  return slots;
}

/**
 * Reshape thin continuation slivers: a zone that continues from one free
 * piece into another currently leaves a narrow vertical slice. That slice
 * becomes a FULL-WIDTH horizontal band at the top of the piece, and the
 * other slots in the piece are compressed below it (widths scaled so each
 * slot keeps its exact area). The result is one contiguous space per zone.
 */
/** Do two zone rectangles share an edge? */
function touches(r: SlotRect, o: SlotRect): boolean {
  const EPS = 1e-6;
  return (
    (Math.abs(r.x + r.w - o.x) < EPS || Math.abs(o.x + o.w - r.x) < EPS) &&
    r.y < o.y + o.h - EPS && o.y < r.y + r.h - EPS
  ) || (
    (Math.abs(r.y + r.h - o.y) < EPS || Math.abs(o.y + o.h - r.y) < EPS) &&
    r.x < o.x + o.w - EPS && o.x < r.x + r.w - EPS
  );
}

/**
 * Reshape thin continuation slivers AND disconnected zone pieces: a zone
 * that continues from one free piece into another must stay ONE contiguous
 * space. The offending rect becomes a full-length band on the side that
 * borders the zone's other rects, and the other slots in the piece are
 * compressed (cross-dimensions scaled so every slot keeps its exact area).
 */
function reshapeSliverStrips(slots: Slot[], pieces: Rect[]): void {
  const SLIVER_MAX = 1.0; // min dimension below which a rect counts as a sliver
  const EPS = 1e-6;
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[k];
    const entries: Array<{ slot: number; rect: SlotRect }> = [];
    slots.forEach((s, si) => s.rects.forEach(r => { if (r.piece === k) entries.push({ slot: si, rect: r }); }));
    if (entries.length < 2) continue;

    const continuesElsewhere = new Set(
      entries
        .filter(e => slots[e.slot].rects.some(r => r.piece !== k))
        .map(e => e.slot)
    );
    // Reshape a slot's rect here when it is a thin sliver OR disconnected
    // from that slot's other rects (isolated piece of the same zone).
    const target = entries.find(e => {
      if (!continuesElsewhere.has(e.slot)) return false;
      const others = slots[e.slot].rects.filter(r => r.piece !== k);
      const isSliver = Math.min(e.rect.w, e.rect.h) < SLIVER_MAX;
      const disconnected = !others.some(o => touches(e.rect, o));
      return isSliver || disconnected;
    });
    if (!target) continue;

    // Which side of THIS piece borders the slot's other rects? The band must
    // sit there so the zone stays ONE contiguous space.
    const otherRects = slots[target.slot].rects.filter(r => r.piece !== k);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of otherRects) {
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    let side: "bottom" | "top" | "left" | "right" = "top";
    if (Math.abs(maxY - piece.y) < EPS) side = "bottom";
    else if (Math.abs(minY - (piece.y + piece.h)) < EPS) side = "top";
    else if (Math.abs(maxX - piece.x) < EPS) side = "left";
    else if (Math.abs(minX - (piece.x + piece.w)) < EPS) side = "right";

    const targetArea = rectArea(target.rect);
    const horizontal = side === "top" || side === "bottom";
    const stripLen = horizontal ? piece.w : piece.h;
    const MIN_THICKNESS = 0.25;
    let bandThickness = targetArea / stripLen;
    let bandLen = stripLen;
    if (bandThickness < MIN_THICKNESS) {
      // The area is too small for a full-length band — use a partial-length
      // band (odd shapes are fine) with at least the minimum thickness.
      bandThickness = MIN_THICKNESS;
      bandLen = targetArea / bandThickness;
    }

    // Convert the rect into a band on the bordering side. Partial bands are
    // aligned with the x/y overlap of the zone's other rects.
    if (horizontal) {
      let bx = piece.x;
      if (bandLen < piece.w - 1e-9) {
        const x1 = Math.max(piece.x, minX);
        const x2 = Math.min(piece.x + piece.w, maxX);
        bx = (x1 + x2) / 2 - bandLen / 2;
        bx = Math.max(piece.x, Math.min(piece.x + piece.w - bandLen, bx));
      }
      target.rect.x = bx;
      target.rect.w = bandLen;
      target.rect.h = bandThickness;
      target.rect.y = side === "top" ? piece.y + piece.h - bandThickness : piece.y;
    } else {
      let by = piece.y;
      if (bandLen < piece.h - 1e-9) {
        const y1 = Math.max(piece.y, minY);
        const y2 = Math.min(piece.y + piece.h, maxY);
        by = (y1 + y2) / 2 - bandLen / 2;
        by = Math.max(piece.y, Math.min(piece.y + piece.h - bandLen, by));
      }
      target.rect.y = by;
      target.rect.h = bandLen;
      target.rect.w = bandThickness;
      target.rect.x = side === "right" ? piece.x + piece.w - bandThickness : piece.x;
    }

    // Compress the other slots' rects in this piece into the remaining part.
    // Each keeps its EXACT area: width = area / newH (horizontal) — this is
    // exact regardless of the rects' original shapes, so the partition can
    // never overflow the piece.
    const others = entries
      .filter(e => e !== target)
      .sort((a, b) => (horizontal ? a.rect.x - b.rect.x : a.rect.y - b.rect.y));
    // Scale so the others exactly fill the leftover strip (a partial band
    // leaves a corner gap that must be absorbed).
    const totalOthersArea = others.reduce((s, e) => s + rectArea(e.rect), 0);
    if (horizontal) {
      const newH = piece.h - bandThickness;
      const availableArea = piece.w * newH;
      const scale = totalOthersArea > 0 ? availableArea / totalOthersArea : 1;
      const y0 = side === "top" ? piece.y : piece.y + bandThickness;
      let cursor = piece.x;
      for (const e of others) {
        const w2 = (rectArea(e.rect) / newH) * scale;
        if (w2 < 0.4) continue; // too narrow — its area is absorbed by the band
        e.rect.x = cursor;
        e.rect.y = y0;
        e.rect.w = w2;
        e.rect.h = newH;
        cursor += w2;
      }
    } else {
      const newW = piece.w - bandThickness;
      const availableArea = piece.h * newW;
      const scale = totalOthersArea > 0 ? availableArea / totalOthersArea : 1;
      const x0 = side === "left" ? piece.x + bandThickness : piece.x;
      let cursor = piece.y;
      for (const e of others) {
        const h2 = (rectArea(e.rect) / newW) * scale;
        if (h2 < 0.4) continue;
        e.rect.x = x0;
        e.rect.y = cursor;
        e.rect.w = newW;
        e.rect.h = h2;
        cursor += h2;
      }
    }
  }
}

function slotArea(slot: Slot): number {
  return slot.rects.reduce((s, r) => s + rectArea(r), 0);
}

function slotCentroid(slot: Slot): { x: number; y: number } {
  const a = slotArea(slot);
  if (a <= 0) return { x: 0, y: 0 };
  const x = slot.rects.reduce((s, r) => s + rectCenter(r).x * rectArea(r), 0) / a;
  const y = slot.rects.reduce((s, r) => s + rectCenter(r).y * rectArea(r), 0) / a;
  return { x, y };
}

function slotBbox(slot: Slot): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of slot.rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

/**
 * Assign kinds to the carved slots. The kitchen takes the slot FARTHEST
 * from the bathroom; bed and living may sit closer (an exchange is allowed
 * as long as free space exists somewhere). Slot sizes follow the weights —
 * the size penalty dominates, so the ratios stay exact.
 */
function assignKinds(
  roomName: string,
  slots: Slot[],
  kinds: Array<{ kind: ZoneKind; weight: number; centroid: { x: number; y: number } }>,
  keepAwayFrom: Rect[]
): RoomZone[] {
  const emit = (slot: Slot, kind: ZoneKind): RoomZone => {
    const bbox = slotBbox(slot);
    return {
      room: roomName,
      kind,
      rects: slot.rects.map(r => ({ x: r.x, y: r.y, width: r.w, height: r.h })),
      x: bbox.x,
      y: bbox.y,
      width: bbox.w,
      height: bbox.h,
    };
  };

  if (kinds.length === 1) {
    return slots.map(s => emit(s, kinds[0].kind));
  }

  const totalW = kinds.reduce((s, k) => s + k.weight, 0);
  const totalA = slots.reduce((s, sl) => s + slotArea(sl), 0);
  const targetOf = (k: (typeof kinds)[0]) => (k.weight / totalW) * totalA;
  const SIZE_PENALTY = 50; // area mismatch penalty — keeps the ratios exact

  let best: { perm: number[]; cost: number } | null = null;
  for (const perm of permutations(kinds.map((_, i) => i))) {
    let cost = 0;
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[perm[i]];
      const slot = slots[i];
      const c = slotCentroid(slot);
      const sizePen = Math.abs(slotArea(slot) - targetOf(k)) * SIZE_PENALTY;
      let posPen: number;
      if (k.kind === "kitchen" && keepAwayFrom.length > 0) {
        // Farther from the bathroom is better (negative cost).
        posPen = -distToRects(c, keepAwayFrom);
      } else {
        posPen = (c.x - k.centroid.x) ** 2 + (c.y - k.centroid.y) ** 2;
      }
      cost += posPen + sizePen;
    }
    if (!best || cost < best.cost) best = { perm, cost };
  }

  const zones: RoomZone[] = [];
  for (let i = 0; i < slots.length; i++) {
    zones.push(emit(slots[i], kinds[best!.perm[i]].kind));
  }
  return zones;
}

/**
 * Merged boundary outline of a zone's rectangles (one contiguous space).
 * Shared interior edges cancel out; the remaining edges form closed loops.
 */
export function zoneOutlineLoops(rects: ZoneRect[]): Array<Array<{ x: number; y: number }>> {
  const key = (v: number) => Math.round(v * 1000) / 1000;
  interface Edge { ax: number; ay: number; bx: number; by: number; }
  const edges: Edge[] = [];
  for (const r of rects) {
    const x1 = r.x, y1 = r.y, x2 = r.x + r.width, y2 = r.y + r.height;
    edges.push(
      { ax: x1, ay: y1, bx: x2, by: y1 },
      { ax: x2, ay: y1, bx: x2, by: y2 },
      { ax: x2, ay: y2, bx: x1, by: y2 },
      { ax: x1, ay: y2, bx: x1, by: y1 },
    );
  }
  const eKey = (e: Edge) => `${key(e.ax)},${key(e.ay)}|${key(e.bx)},${key(e.by)}`;
  const rKey = (e: Edge) => `${key(e.bx)},${key(e.by)}|${key(e.ax)},${key(e.ay)}`;
  const counts = new Map<string, number>();
  const inc = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const dec = (k: string) => counts.set(k, (counts.get(k) ?? 1) - 1);
  for (const e of edges) inc(eKey(e));

  const remaining: Edge[] = [];
  for (const e of edges) {
    const kf = eKey(e);
    const kr = rKey(e);
    if ((counts.get(kf) ?? 0) > 0 && (counts.get(kr) ?? 0) > 0) {
      dec(kf); dec(kr);
    } else {
      remaining.push(e);
    }
  }

  const startMap = new Map<string, Edge[]>();
  for (const e of remaining) {
    const k = `${key(e.ax)},${key(e.ay)}`;
    const list = startMap.get(k);
    if (list) list.push(e); else startMap.set(k, [e]);
  }

  const loops: Array<Array<{ x: number; y: number }>> = [];
  const used = new Set<Edge>();
  for (const e of remaining) {
    if (used.has(e)) continue;
    const loop: Array<{ x: number; y: number }> = [];
    let cur: Edge | null = e;
    let guard = 0;
    while (cur && !used.has(cur) && guard < 1000) {
      guard++;
      used.add(cur);
      loop.push({ x: cur.ax, y: cur.ay });
      const nextKey: string = `${key(cur.bx)},${key(cur.by)}`;
      cur = (startMap.get(nextKey) ?? []).find(c => !used.has(c)) ?? null;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Centroid of a furniture group, or the room center when empty. */
function groupCentroid(items: PlacedFurniture[], fallback: { x: number; y: number }): { x: number; y: number } {
  if (items.length === 0) return fallback;
  const cx = items.reduce((s, pf) => s + pf.x, 0) / items.length;
  const cy = items.reduce((s, pf) => s + pf.y, 0) / items.length;
  return { x: cx, y: cy };
}

/** World position of a door on its room's wall (on the boundary line). */
function doorWorldPoint(door: Door, room: GeneratedRoom | undefined): { x: number; y: number } | null {
  if (!door || !room) return null;
  switch (door.wall) {
    case "bottom": return { x: room.x + door.offset, y: room.y };
    case "top": return { x: room.x + door.offset, y: room.y + room.height };
    case "left": return { x: room.x, y: room.y + door.offset };
    case "right": return { x: room.x + room.width, y: room.y + door.offset };
  }
}

/** Squared distance from a point to the nearest rectangle of a zone. */
function pointToZoneDist(p: { x: number; y: number }, z: RoomZone): number {
  let best = Infinity;
  for (const r of z.rects) {
    const cx = Math.max(r.x, Math.min(p.x, r.x + r.width));
    const cy = Math.max(r.y, Math.min(p.y, r.y + r.height));
    best = Math.min(best, (p.x - cx) ** 2 + (p.y - cy) ** 2);
  }
  return best === Infinity ? 0 : best;
}

/** All ways to split a sequence of `k` items into `p` consecutive non-empty groups. */
function compositions(k: number, p: number): number[][] {
  if (p > k || p < 1 || k < 1) return [];
  if (p === 1) return [[k]];
  const out: number[][] = [];
  for (let first = 1; first <= k - (p - 1); first++) {
    for (const rest of compositions(k - first, p - 1)) {
      out.push([first, ...rest]);
    }
  }
  return out;
}

/**
 * Carve the pieces into bands along each piece's longer axis so EVERY zone
 * is a SINGLE rectangle (zones are plain rooms with invisible walls — no
 * L-shapes, no split pieces). `groupSizes[p]` says how many kinds piece `p`
 * hosts; kinds are assigned in `kindOrder` sequence.
 */
function buildRectZones(
  roomName: string,
  pieces: Rect[],
  kinds: Array<{ kind: ZoneKind; weight: number }>,
  pieceOrder: number[],
  kindOrder: number[],
  groupSizes: number[]
): RoomZone[] {
  const zones: RoomZone[] = [];
  let ki = 0;
  for (let p = 0; p < pieceOrder.length; p++) {
    const piece = pieces[pieceOrder[p]];
    const group = kindOrder.slice(ki, ki + groupSizes[p]);
    ki += groupSizes[p];
    const totalW = group.reduce((s, gi) => s + kinds[gi].weight, 0) || 1;
    const horizontal = piece.w >= piece.h;
    const longer = horizontal ? piece.w : piece.h;
    const shorter = horizontal ? piece.h : piece.w;
    let cursor = 0;
    for (let i = 0; i < group.length; i++) {
      const gi = group[i];
      const frac = kinds[gi].weight / totalW;
      const len = i === group.length - 1 ? longer - cursor : frac * longer;
      const rect: ZoneRect = horizontal
        ? { x: piece.x + cursor, y: piece.y, width: len, height: shorter }
        : { x: piece.x, y: piece.y + cursor, width: shorter, height: len };
      cursor += len;
      const kind = kinds[gi].kind;
      zones.push({
        room: roomName, kind, rects: [rect],
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      });
    }
  }
  return zones;
}

/**
 * Choose the rectangular zone arrangement.
 * Studios with doors obey the hard rules (living at the entrance, kitchen
 * north, bed nearest the bathroom door). Every arrangement is then scored
 * on how many of each kind's CORE items (sofa/TV/coffee, beds, counters)
 * sit inside their zone, then on the ratio areas. Every piece order ×
 * kind order × group split is tried.
 */
function computeRectangularZones(
  room: GeneratedRoom,
  pieces: Rect[],
  kinds: Array<{ kind: ZoneKind; weight: number; centroid: { x: number; y: number } }>,
  coreGroups: Record<ZoneKind, PlacedFurniture[]>,
  entrancePoint: { x: number; y: number } | null,
  bathDoorPoint: { x: number; y: number } | null
): RoomZone[] {
  const totalA = pieces.reduce((s, p) => s + rectArea(p), 0);
  const totalW = kinds.reduce((s, k) => s + k.weight, 0) || 1;
  const targetArea = (k: typeof kinds[0]) => (k.weight / totalW) * totalA;
  const MUST = 1e6;        // hard door-rule penalty (dominates everything else)
  const FIT_PENALTY = 1e4; // one core item outside its zone (dominates area dev)
  const AREA_PENALTY = 1;  // per m² mismatch — keeps the ratios as exact as possible

  let best: { zones: RoomZone[]; score: number } | null = null;

  for (const pieceOrder of permutations(pieces.map((_, i) => i))) {
    for (const kindOrder of permutations(kinds.map((_, i) => i))) {
      for (const groupSizes of compositions(kinds.length, pieceOrder.length)) {
        const zones = buildRectZones(room.name, pieces, kinds, pieceOrder, kindOrder, groupSizes);
        let score = 0;

        const nearestTo = (p: { x: number; y: number }): RoomZone => {
          let nearest = zones[0];
          let bestDist = Infinity;
          for (const z of zones) {
            const d = pointToZoneDist(p, z);
            if (d < bestDist) { bestDist = d; nearest = z; }
          }
          return nearest;
        };

        if (entrancePoint) {
          const n = nearestTo(entrancePoint);
          if (kinds.some(k => k.kind === "living")) {
            // The living zone owns the main entrance (kitchen stays north).
            if (n.kind !== "living") score += MUST;
          } else if (n.kind === "bed") {
            score += MUST; // bed must NEVER own the entrance
          }
        }
        if (bathDoorPoint) {
          if (nearestTo(bathDoorPoint).kind !== "bed") score += MUST; // bed owns the bathroom side
        }

        // Furniture fit: each kind's core items should sit INSIDE their zone.
        for (const z of zones) {
          for (const it of coreGroups[z.kind] ?? []) {
            const d = pointToZoneDist(it, z);
            if (d > 1e-9) score += FIT_PENALTY + Math.sqrt(d);
          }
        }

        // Area ratios stay as close to the targets as the rectangles allow.
        for (const k of kinds) {
          const area = zones
            .filter(z => z.kind === k.kind)
            .reduce((s, z) => s + z.width * z.height, 0);
          score += AREA_PENALTY * Math.abs(area - targetArea(k));
        }

        if (!best || score < best.score) best = { zones, score };
      }
    }
  }
  return best ? best.zones : [];
}

/**
 * Compute the color-coded functional zones.
 * Called AFTER furniture placement — each zone is sized by the ratios above
 * over the space remaining after the ensuite/bathroom is cut out, and its
 * cut order follows the furniture so zones line up with their items.
 */
export function computeRoomZones(
  rooms: GeneratedRoom[],
  doors: Door[],
  _windows: Window[],
  furniture: PlacedFurniture[]
): RoomZone[] {
  const zones: RoomZone[] = [];
  const bedRoomCount = rooms.filter(
    r => /bedroom|master|guest|kids/i.test(r.name) && !/ensuite|studio/i.test(r.name)
  ).length;
  const hasDedicatedKitchen = rooms.some(r => /kitchen|kitchenette|cooking|pantry/i.test(r.name));

  for (const room of rooms) {
    const isStudioRoom = /studio/i.test(room.name);
    const isLivingRoom = /living|lounge|family|media/i.test(room.name) && !isStudioRoom;
    const oneBedOpenPlanLiving = isLivingRoom && bedRoomCount === 1 && !hasDedicatedKitchen && room.hasKitchenZone;
    if (!isStudioRoom && !oneBedOpenPlanLiving) continue;

    const roomRect: Rect = { x: room.x, y: room.y, w: room.width, h: room.height };

    // Holes: ensuite/bathroom carved from the room. Zones NEVER overlap them.
    const holes: Rect[] = rooms
      .filter(r => r !== room && /bathroom|ensuite|powder|wc/i.test(r.name))
      .map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))
      .filter(h => h.x < roomRect.x + roomRect.w && h.x + h.w > roomRect.x &&
                    h.y < roomRect.y + roomRect.h && h.y + h.h > roomRect.y);

    const pieces = subtractHoles(roomRect, holes);
    const usableArea = pieces.reduce((s, p) => s + rectArea(p), 0);
    if (usableArea < 1) continue;

    const inRoom = furniture.filter(pf => pf.room === room.name);
    const beds = inRoom.filter(pf => isBedItemId(pf.itemId));
    const kitchenItems = inRoom.filter(pf => isKitchenItemId(pf.itemId));

    // Rugs and side tables: in a studio they belong to the bed group when
    // near a bed, otherwise to the living group.
    const bedCentroids = beds.map(b => ({ x: b.x, y: b.y }));
    const nearAnyBed = (pf: PlacedFurniture) =>
      bedCentroids.some(b => Math.abs(pf.x - b.x) < 1.8 && Math.abs(pf.y - b.y) < 1.8);
    const livingItems = inRoom.filter(pf => {
      if (!isLivingItemId(pf.itemId)) return false;
      if (!isStudioRoom) return true;
      if (pf.itemId === "side-table" || pf.itemId.startsWith("rug-")) return nearAnyBed(pf);
      return true;
    });

    const center = rectCenter(roomRect);
    const kinds: Array<{ kind: ZoneKind; weight: number; centroid: { x: number; y: number } }> = [];

    if (isStudioRoom) {
      if (usableArea >= STUDIO_THREE_ZONE_MIN) {
        // Living carved FIRST → it takes the band the living set actually
        // occupies (TV against the bottom wall); bed carved LAST → the top
        // band where the bed sits. This keeps zones aligned with furniture
        // so the placer's zone enforcement never has to relocate the set.
        kinds.push(
          { kind: "living", weight: 18, centroid: groupCentroid(livingItems, center) },
          { kind: "kitchen", weight: 7, centroid: groupCentroid(kitchenItems, center) },
          { kind: "bed", weight: 15, centroid: groupCentroid(beds, center) },
        );
      } else if (usableArea >= STUDIO_TWO_ZONE_MIN) {
        kinds.push(
          { kind: "living", weight: 2, centroid: groupCentroid(livingItems, center) },
          { kind: "bed", weight: 1, centroid: groupCentroid(beds, center) },
        );
      } else {
        // Too small for anything else — the whole space is the sleeping area.
        kinds.push({ kind: "bed", weight: 1, centroid: groupCentroid(beds, center) });
      }
    } else {
      // One-bedroom open-plan living room: kitchen : living = 13 : 27.
      // Living carved first so it follows the TV wall arrangement.
      kinds.push(
        { kind: "living", weight: 27, centroid: groupCentroid(livingItems, center) },
        { kind: "kitchen", weight: 13, centroid: groupCentroid(kitchenItems, center) },
      );
    }

    // All zones are plain RECTANGLES — one rectangle per zone, like rooms
    // with invisible walls (no L-shapes, no split pieces). The best
    // piece/kind/band arrangement is chosen:
    //   - studios with doors: living/kitchen at the entrance, bed nearest
    //     the bathroom door (hard rules);
    //   - otherwise: zones stay closest to their furniture, with the ratio
    //     areas kept as exact as the geometry allows.
    let entrancePoint: { x: number; y: number } | null = null;
    let bathDoorPoint: { x: number; y: number } | null = null;
    if (isStudioRoom) {
      const entranceDoor = doors.find(d => d.room === room.name);
      entrancePoint = entranceDoor ? doorWorldPoint(entranceDoor, room) : null;
      const bathRoom = rooms.find(r => r !== room &&
        /bathroom|ensuite|powder|wc/i.test(r.name) &&
        r.x < roomRect.x + roomRect.w && r.x + r.width > roomRect.x &&
        r.y < roomRect.y + roomRect.h && r.y + r.height > roomRect.y);
      const bathDoor = bathRoom ? doors.find(d => d.room === bathRoom.name) : undefined;
      bathDoorPoint = bathDoor ? doorWorldPoint(bathDoor, bathRoom) : null;
    }

    if (compositions(kinds.length, pieces.length).length > 0) {
      // Core items drive the zone placement: sofa/TV/coffee for the living
      // zone, beds for the bed zone, counters/appliances for the kitchen.
      const coreGroups: Record<ZoneKind, PlacedFurniture[]> = {
        bed: beds,
        kitchen: kitchenItems,
        living: livingItems.filter(pf =>
          pf.itemId.startsWith("sofa-") ||
          pf.itemId === "tv-unit" ||
          pf.itemId === "coffee-table"),
      };
      zones.push(...computeRectangularZones(room, pieces, kinds, coreGroups, entrancePoint, bathDoorPoint));
    } else {
      // More free-space pieces than zones (rare/impossible for carved corner
      // bathrooms) — fall back to the contiguous-band cut.
      const slots = carveSlots(pieces, kinds.map(k => k.weight));
      reshapeSliverStrips(slots, pieces);
      zones.push(...assignKinds(room.name, slots, kinds, holes));
    }
  }

  return zones;
}
