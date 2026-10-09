import { describe, expect, it } from "vitest";
import { darkTokens, lightTokens, museDarkTokens, museLightTokens } from "./index.js";

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

// WCAG 1.4.11: a mark that carries data needs 3:1 against the surface it is drawn on.
const SETS = { lightTokens, darkTokens, museLightTokens, museDarkTokens };

describe("chart palette", () => {
  for (const [name, set] of Object.entries(SETS)) {
    it(`${name}: every series color reads at 3:1 on the background and the card`, () => {
      const weak: string[] = [];
      for (let n = 1; n <= 8; n++) {
        const color = set[`chart-${n}` as keyof typeof set] as string;
        for (const surface of [set.background, set.card] as string[]) {
          const ratio = contrast(color, surface);
          if (ratio < 3) weak.push(`chart-${n} ${color} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
      expect(weak).toEqual([]);
    });
  }
});
