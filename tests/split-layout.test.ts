import { describe, it, expect } from "vitest";
import { dropFromSplit, inSplit, openSplit, switchInSplit } from "../src/split-layout";

describe("split layout", () => {
  it("pairs the active tab with another one", () => {
    expect(openSplit("a", "b")).toEqual({ left: "a", right: "b" });
    expect(openSplit("a", "a")).toBeNull();
    expect(openSplit(null, "b")).toBeNull();
  });

  it("keeps the pair when switching between its two tabs", () => {
    const pair = { left: "a", right: "b" };
    expect(switchInSplit(pair, "a", "b")).toBe(pair);
  });

  it("swaps an outside tab into the active side", () => {
    const pair = { left: "a", right: "b" };
    expect(switchInSplit(pair, "a", "c")).toEqual({ left: "c", right: "b" });
    expect(switchInSplit(pair, "b", "c")).toEqual({ left: "a", right: "c" });
    expect(switchInSplit(null, "a", "c")).toBeNull();
  });

  it("ends the split when either side closes", () => {
    const pair = { left: "a", right: "b" };
    expect(dropFromSplit(pair, "b")).toBeNull();
    expect(dropFromSplit(pair, "c")).toBe(pair);
    expect(inSplit(pair, "a")).toBe(true);
    expect(inSplit(null, "a")).toBe(false);
  });
});
