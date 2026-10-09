/** The film grain laid over the whole night surface. The oversized layer is clipped to the
 * screen so it never widens the page on a phone. */
export function Grain() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-60 overflow-hidden">
      <div className="welcome-grain absolute -inset-1/2 opacity-7" />
    </div>
  );
}
