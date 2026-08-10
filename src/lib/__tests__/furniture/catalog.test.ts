/* ------------------------------------------------------------------ */
/*  Tests for furniture catalog integrity                              */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import {
  furnitureCatalog,
  getFurnitureById,
  getFurnitureForRoom,
  getFurnitureByCategory,
} from "../../furniture/catalog";

describe("Furniture catalog", () => {
  it("has no duplicate IDs", () => {
    const ids = furnitureCatalog.map((item) => item.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("every item has required fields", () => {
    for (const item of furnitureCatalog) {
      expect(item.id).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(item.category).toBeTruthy();
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
      expect(item.suitableRooms.length).toBeGreaterThan(0);
      expect(item.renderer).toBeTruthy();
      expect(item.fill).toBeTruthy();
      expect(item.stroke).toBeTruthy();
      expect(Array.isArray(item.tags)).toBe(true);
    }
  });

  it("bed dimensions are realistic", () => {
    const beds = furnitureCatalog.filter((item) => item.category === "bed");
    for (const bed of beds) {
      // Beds should be longer than wide (head-to-foot > width)
      expect(bed.height).toBeGreaterThan(bed.width);
      // Reasonable bed sizes
      expect(bed.width).toBeGreaterThanOrEqual(0.9);
      expect(bed.width).toBeLessThanOrEqual(2.5);
      expect(bed.height).toBeGreaterThanOrEqual(1.8);
      expect(bed.height).toBeLessThanOrEqual(2.5);
    }
  });

  it("wardrobe has correct proportions for wall placement", () => {
    const wardrobe = getFurnitureById("wardrobe");
    expect(wardrobe).toBeDefined();
    // Wardrobe should be wider than deep (long side against wall)
    expect(wardrobe!.width).toBeGreaterThan(wardrobe!.height);
    expect(wardrobe!.width).toBe(1.2);
    expect(wardrobe!.height).toBe(0.6);
    expect(wardrobe!.rotatable).toBe(true);
  });

  it("sofa is wider than deep", () => {
    const sofa = getFurnitureById("sofa-3-seater");
    expect(sofa).toBeDefined();
    expect(sofa!.width).toBeGreaterThan(sofa!.height);
    expect(sofa!.width).toBeGreaterThanOrEqual(1.5);
  });

  it("dining table dimensions are realistic", () => {
    const table6 = getFurnitureById("dining-table-6");
    expect(table6).toBeDefined();
    expect(table6!.width).toBeGreaterThanOrEqual(1.5);
    expect(table6!.height).toBeGreaterThanOrEqual(0.8);
    expect(table6!.height).toBeLessThanOrEqual(table6!.width);
  });

  it("bathroom fixtures are compact", () => {
    const toilet = getFurnitureById("toilet");
    const sink = getFurnitureById("sink-bathroom");
    const shower = getFurnitureById("shower");

    expect(toilet!.width).toBeLessThanOrEqual(0.7);
    expect(toilet!.height).toBeLessThanOrEqual(0.9);
    expect(sink!.width).toBeLessThanOrEqual(0.8);
    expect(shower!.width).toBeLessThanOrEqual(1.0);
  });

  it("getFurnitureById returns undefined for invalid ID", () => {
    expect(getFurnitureById("nonexistent-furniture")).toBeUndefined();
  });

  it("getFurnitureById returns correct item", () => {
    const bed = getFurnitureById("bed-queen");
    expect(bed).toBeDefined();
    expect(bed!.name).toBe("Queen Bed");
  });

  it("getFurnitureForRoom filters by room type", () => {
    const bedroomItems = getFurnitureForRoom("Master Bedroom");
    expect(bedroomItems.some((i) => i.id.startsWith("bed-"))).toBe(true);
    expect(bedroomItems.some((i) => i.id === "wardrobe")).toBe(true);

    const kitchenItems = getFurnitureForRoom("Kitchen");
    expect(kitchenItems.some((i) => i.id.includes("kitchen"))).toBe(true);
  });

  it("getFurnitureByCategory returns correct category", () => {
    const seating = getFurnitureByCategory("seating");
    expect(seating.length).toBeGreaterThan(0);
    for (const item of seating) {
      expect(item.category).toBe("seating");
    }
  });

  it("all rotatable items have rotatable=true", () => {
    const rotatable = furnitureCatalog.filter((i) => i.rotatable);
    for (const item of rotatable) {
      expect(item.rotatable).toBe(true);
    }
  });
});
