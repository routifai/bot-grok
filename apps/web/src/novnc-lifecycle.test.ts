import { describe, expect, it } from "vitest";
import { injectScreenLifecycle, SCREEN_DISCONNECTED_MESSAGE } from "./novnc-html";

describe("injectScreenLifecycle", () => {
  it("reports noVNC disconnects to the parent right after the connection is created", () => {
    const html = `<script type="module">\n      const rfb = new RFB(document.getElementById("screen"), url);\n      rfb.viewOnly = true;\n</script>`;
    const out = injectScreenLifecycle(html);
    expect(out).toContain('rfb.addEventListener("disconnect"');
    expect(out).toContain(SCREEN_DISCONNECTED_MESSAGE);
    expect(out.indexOf("addEventListener")).toBeLessThan(out.indexOf("rfb.viewOnly"));
  });

  it("leaves other documents unchanged", () => {
    const html = "<html><body>vnc.html</body></html>";
    expect(injectScreenLifecycle(html)).toBe(html);
  });
});
