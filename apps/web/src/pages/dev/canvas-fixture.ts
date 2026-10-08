import type { CanvasNode } from "@nova/contracts";

/**
 * Dev-only proof fixture for Nova Canvas (see AGENTS task: the Canadian credit-card
 * comparison the agent should have answered with a canvas instead of a failing chart spec
 * and a hand-written HTML page). All numbers are illustrative, not current rates.
 */
export const CREDIT_CARD_CANVAS_FIXTURE: CanvasNode = {
  type: "stack",
  props: { gap: "lg" },
  children: [
    { type: "heading", props: { text: "Best Canadian travel credit cards" } },
    {
      type: "callout",
      props: {
        tone: "info",
        text: "Example data for illustration — rates and bonuses change; confirm current terms with each issuer.",
      },
    },
    {
      type: "grid",
      props: { columns: 3, minColumnWidth: 220 },
      children: [
        {
          type: "item_card",
          props: {
            title: "Scotiabank Passport Visa Infinite",
            subtitle: "Visa Infinite · Travel",
            highlight: "Best for lounge access",
            stats: [
              { label: "Annual fee", value: "$139" },
              { label: "Welcome bonus", value: "30,000 pts" },
            ],
            pros: ["No foreign transaction fee", "6 Priority Pass lounge visits/year"],
            cons: ["$139 annual fee"],
            ctaLabel: "See details",
            ctaUrl: "https://example.com/scotiabank-passport",
          },
        },
        {
          type: "item_card",
          props: {
            title: "American Express Cobalt",
            subtitle: "Amex · Everyday spend",
            highlight: "Best for groceries & dining",
            stats: [
              { label: "Annual fee", value: "$155.88" },
              { label: "Welcome bonus", value: "15,000 pts" },
            ],
            pros: ["5x points on food & drink", "Monthly billing, no big upfront fee"],
            cons: ["Amex acceptance is narrower"],
            ctaLabel: "See details",
            ctaUrl: "https://example.com/amex-cobalt",
          },
        },
        {
          type: "item_card",
          props: {
            title: "TD First Class Travel Visa Infinite",
            subtitle: "Visa Infinite · Travel",
            stats: [
              { label: "Annual fee", value: "$139" },
              { label: "Welcome bonus", value: "50,000 pts" },
            ],
            pros: ["Large first-year bonus", "Trip cancellation insurance"],
            cons: ["2.5% foreign transaction fee"],
            ctaLabel: "See details",
            ctaUrl: "https://example.com/td-first-class",
          },
        },
        {
          type: "item_card",
          props: {
            title: "Rogers Red World Elite Mastercard",
            subtitle: "World Elite · No annual fee",
            highlight: "Best value",
            stats: [
              { label: "Annual fee", value: "$0" },
              { label: "Welcome bonus", value: "$0" },
            ],
            pros: ["No annual fee, ever", "1.5% cash back in USD"],
            cons: ["No lounge access", "No travel insurance"],
            ctaLabel: "See details",
            ctaUrl: "https://example.com/rogers-red",
          },
        },
        {
          type: "item_card",
          props: {
            title: "Tangerine Money-Back",
            subtitle: "Mastercard · No annual fee",
            stats: [
              { label: "Annual fee", value: "$0" },
              { label: "Welcome bonus", value: "$0" },
            ],
            pros: ["Choose your own 2% cash-back categories", "No annual fee"],
            cons: ["No travel perks"],
            ctaLabel: "See details",
            ctaUrl: "https://example.com/tangerine-money-back",
          },
        },
      ],
    },
    { type: "heading", props: { text: "Side by side", level: 3 } },
    {
      type: "comparison_table",
      props: {
        columns: [
          { id: "scotia", label: "Scotia Passport" },
          { id: "amex", label: "Amex Cobalt" },
          { id: "td", label: "TD First Class" },
          { id: "rogers", label: "Rogers Red" },
          { id: "tangerine", label: "Tangerine" },
        ],
        rows: [
          {
            label: "Annual fee",
            cells: [
              { columnId: "scotia", value: "$139" },
              { columnId: "amex", value: "$155.88" },
              { columnId: "td", value: "$139" },
              { columnId: "rogers", value: "$0", winner: true },
              { columnId: "tangerine", value: "$0", winner: true },
            ],
          },
          {
            label: "Welcome bonus",
            cells: [
              { columnId: "scotia", value: "30,000 pts" },
              { columnId: "amex", value: "15,000 pts" },
              { columnId: "td", value: "50,000 pts", winner: true },
              { columnId: "rogers", value: "$0" },
              { columnId: "tangerine", value: "$0" },
            ],
          },
          {
            label: "Earn rate",
            cells: [
              { columnId: "scotia", value: "3x dining/entertainment" },
              { columnId: "amex", value: "5x food & drink", winner: true },
              { columnId: "td", value: "2x travel" },
              { columnId: "rogers", value: "1.5% cash back" },
              { columnId: "tangerine", value: "2% chosen categories" },
            ],
          },
          {
            label: "FX fee",
            cells: [
              { columnId: "scotia", value: "0%", winner: true },
              { columnId: "amex", value: "2.5%" },
              { columnId: "td", value: "2.5%" },
              { columnId: "rogers", value: "0% (USD card)", winner: true },
              { columnId: "tangerine", value: "2.5%" },
            ],
          },
          {
            label: "Lounge access",
            cells: [
              { columnId: "scotia", value: true },
              { columnId: "amex", value: false },
              { columnId: "td", value: false },
              { columnId: "rogers", value: false },
              { columnId: "tangerine", value: false },
            ],
          },
          {
            label: "Best for",
            cells: [
              { columnId: "scotia", value: "Frequent flyers" },
              { columnId: "amex", value: "Everyday spend" },
              { columnId: "td", value: "Big first-year bonus" },
              { columnId: "rogers", value: "No-fee simplicity" },
              { columnId: "tangerine", value: "Flexible cash back" },
            ],
          },
        ],
        footer: "Example data — confirm current rates and terms with each issuer before applying.",
      },
    },
    { type: "heading", props: { text: "Annual fee at a glance", level: 3 } },
    {
      type: "chart",
      props: {
        kind: "bar",
        title: "Annual fee (example data)",
        unit: "$",
        series: [
          {
            data: [
              { label: "Scotia", value: 139 },
              { label: "Amex", value: 155.88 },
              { label: "TD", value: 139 },
              { label: "Rogers", value: 0 },
              { label: "Tangerine", value: 0 },
            ],
          },
        ],
      },
    },
    {
      type: "source_list",
      props: {
        sources: [
          {
            title: "Scotiabank Passport Visa Infinite — example rates page",
            url: "https://example.com/scotiabank-passport",
          },
          {
            title: "American Express Cobalt — example rates page",
            url: "https://example.com/amex-cobalt",
          },
          {
            title: "TD First Class Travel Visa Infinite — example rates page",
            url: "https://example.com/td-first-class",
          },
        ],
      },
    },
  ],
};
