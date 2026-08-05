export { furnitureCatalog, getFurnitureById, getFurnitureForRoom, getFurnitureByCategory } from "./catalog";
export type { FurnitureItem, PlacedFurniture, FurnitureCategory, FurnitureOrientation } from "./types";

// renderFurniture is client-only (uses react-konva) — import directly from renderers in client components
