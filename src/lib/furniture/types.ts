/* ------------------------------------------------------------------ */
/*  Furniture types — shared across the app                           */
/* ------------------------------------------------------------------ */

export type FurnitureCategory =
  | "seating"
  | "table"
  | "storage"
  | "bed"
  | "bathroom"
  | "kitchen"
  | "appliance"
  | "decorative"
  | "outdoor";

/** Supported rotations — includes 45° diagonals for corner arrangements. */
export type FurnitureOrientation = 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315;

export interface FurnitureItem {
  /** Unique catalog id, e.g. "sofa-3-seater" */
  id: string;
  /** Display name */
  name: string;
  category: FurnitureCategory;
  /** Nominal width in meters (unscaled) */
  width: number;
  /** Nominal height in meters (unscaled) */
  height: number;
  /** Which rooms this item typically belongs in */
  suitableRooms: string[];
  /** SVG-like path data or a renderer key */
  renderer: string;
  /** Default fill color */
  fill: string;
  /** Stroke color */
  stroke: string;
  /** Whether the item can be rotated */
  rotatable: boolean;
  /** Tags for filtering */
  tags: string[];
}

export interface PlacedFurniture {
  /** Which catalog item is placed */
  itemId: string;
  /** Room name this furniture belongs to */
  room: string;
  /** Center x in world meters */
  x: number;
  /** Center y in world meters */
  y: number;
  /** Rotation in degrees (0, 90, 180, 270) */
  rotation: FurnitureOrientation;
  /** Scale multiplier (1.0 = default) */
  scale: number;
}
