/* Portions modified from getnao/nao apps/shared/src/chart-style.ts@5bde830, Apache-2.0; changes: none beyond formatting. */
import { createContext, useContext } from "react";

export interface ChartStyle {
  barRadius: number;
}

export const DEFAULT_CHART_STYLE: ChartStyle = { barRadius: 4 };

export const ChartStyleContext = createContext<ChartStyle>(DEFAULT_CHART_STYLE);

export function useChartStyle(): ChartStyle {
  return useContext(ChartStyleContext);
}
