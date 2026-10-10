/** The ground's faint contour lines, behind everything. */
const CONTOURS = [
  "M-40 90 C 300 10, 620 250, 980 130 S 1380 40, 1500 160",
  "M-40 170 C 280 90, 640 330, 990 210 S 1370 120, 1500 240",
  "M-40 250 C 260 170, 660 410, 1000 290 S 1360 200, 1500 320",
  "M-40 330 C 240 250, 680 490, 1010 370 S 1350 280, 1500 400",
  "M-40 410 C 220 330, 700 570, 1020 450 S 1340 360, 1500 480",
  "M-40 490 C 200 410, 720 650, 1030 530 S 1330 440, 1500 560",
  "M-40 570 C 180 490, 740 730, 1040 610 S 1320 520, 1500 640",
  "M-40 650 C 160 570, 760 810, 1050 690 S 1310 600, 1500 720",
  "M-40 730 C 140 650, 780 890, 1060 770 S 1300 680, 1500 800",
  "M-40 810 C 120 730, 800 970, 1070 850 S 1290 760, 1500 880",
];

export function ContourGround() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1440 900"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 size-full text-foreground"
    >
      <g fill="none" stroke="currentColor" strokeOpacity="0.045" strokeWidth="1.5">
        {CONTOURS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
