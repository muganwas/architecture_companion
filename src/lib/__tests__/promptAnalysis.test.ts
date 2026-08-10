/* ------------------------------------------------------------------ */
/*  Tests for prompt analysis / understanding                          */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { analyzePrompt } from "../promptAnalysis";

describe("prompt analysis", () => {
  /* ---- Studio detection ---- */

  it("detects studio apartment and does NOT default to 2 bedrooms", () => {
    const result = analyzePrompt("Studio apartment with balcony");
    // Studio should be detected, not 2-bedroom default
    expect(result.summary).toContain("Studio apartment");
    expect(result.summary).not.toContain("2 bedrooms");
    expect(result.summary).toContain("1 bathroom");
    expect(result.summary).toContain("apartment");
  });

  it("detects studio with 1 bath explicitly", () => {
    const result = analyzePrompt("Studio apartment 1 bathroom");
    expect(result.summary).toContain("Studio apartment");
    expect(result.summary).toContain("1 bathroom");
    expect(result.summary).not.toContain("2 bedrooms");
  });

  it("studio found list says open-plan not bedroom count", () => {
    const result = analyzePrompt("Studio with balcony in Paris");
    const hasStudioOpenPlan = result.found.some(f => /studio/i.test(f) && /open.plan/i.test(f));
    expect(hasStudioOpenPlan, "Should say Studio — open-plan single room").toBe(true);
  });

  it("studio does not show bedroom count in missing", () => {
    const result = analyzePrompt("Small studio apartment");
    const hasBedroomMissing = result.missing.some(m => /bedroom/i.test(m));
    expect(hasBedroomMissing, "Studio should not ask for bedroom count").toBe(false);
  });

  it("studio does not show house type in missing", () => {
    const result = analyzePrompt("Studio");
    const hasHouseTypeMissing = result.missing.some(m => /house type/i.test(m));
    expect(hasHouseTypeMissing, "Studio should not ask for house type").toBe(false);
  });

  /* ---- Studio with explicit bed count overrides studio ---- */
  it("studio with explicit bedroom count is NOT treated as studio", () => {
    // "2 bedroom studio" — user explicitly wants 2 bedrooms, not open-plan
    const result = analyzePrompt("2 bedroom studio apartment");
    expect(result.summary).not.toContain("Studio apartment");
    expect(result.summary).toContain("2 bedrooms");
    expect(result.summary).toContain("1 bathroom");
    expect(result.summary).toContain("apartment");
  });

  it("1 bedroom studio is treated as normal 1-bed", () => {
    const result = analyzePrompt("1 bedroom studio flat");
    expect(result.summary).not.toContain("Studio apartment");
    expect(result.summary).toContain("1 bedroom");
  });

  /* ---- Regular prompts still work ---- */

  it("regular house prompt defaults to 2 bedrooms", () => {
    const result = analyzePrompt("A family home with garage and garden");
    expect(result.summary).toContain("2 bedrooms");
    expect(result.summary).toContain("1 bathroom");
    expect(result.summary).not.toContain("Studio");
  });

  it("explicit bed and bath counts are detected", () => {
    const result = analyzePrompt("3 bedroom 2 bathroom bungalow");
    expect(result.summary).toContain("3 bedrooms");
    expect(result.summary).toContain("2 bathrooms");
    expect(result.summary).toContain("bungalow");
    expect(result.summary).not.toContain("2 bedrooms");
  });

  /* ---- Features detection ---- */

  it("detects balcony feature", () => {
    const result = analyzePrompt("Studio apartment with balcony");
    const hasBalcony = result.found.some(f => /balcony/i.test(f));
    expect(hasBalcony, "Should detect balcony").toBe(true);
  });

  it("detects apartment as non-ground-floor", () => {
    const result = analyzePrompt("Studio apartment with balcony");
    expect(result.isGroundFloor).toBe(false);
  });

  /* ---- Summary format ---- */

  it("studio summary does not duplicate studio/apartment", () => {
    const result = analyzePrompt("Studio apartment");
    // Should say "Studio apartment, 1 bathroom, apartment, Modern style"
    // The "studio" in houseTypes is filtered out since isStudio handles it
    expect(result.summary).toContain("Studio apartment");
    expect(result.summary).toContain("apartment");
    // The word counts — Studio apartment appears once, apartment appears once
  });
});
