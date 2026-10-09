import bridgeSource from "./bridge.js?raw";

/** A fresh nonce for one edit frame; the bridge only answers messages that carry it. */
export function makeEditNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The deck with the edit bridge as the first script of `<head>`, so its capture listeners run
 * before the deck's own click and key handlers. Only the copy handed to the viewer changes; the
 * source file never contains the bridge.
 */
export function injectEditBridge(html: string, nonce: string): string {
  const script = `<script data-nova-edit-bridge>${bridgeSource.split("__NOVA_NONCE__").join(nonce)}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length)
    );
  return script + html;
}
