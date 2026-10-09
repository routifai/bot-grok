# Vendored: dom-to-pptx (browser UMD bundle)

`dom-to-pptx.bundle.js.gz` is the compressed **browser UMD build** of
[`dom-to-pptx`](https://github.com/atharva9167j/dom-to-pptx) (MIT, see `LICENSE`), copied unchanged
from nexu-io/open-design `apps/desktop/vendor/dom-to-pptx/` at commit 802708f (Apache-2.0), the same
way Open Design vendors it.

- **Version:** 2.0.1
- **Source file:** `dist/dom-to-pptx.bundle.js` from the npm package
- **Global:** exposes `window.domToPptx.exportToPptx(elementOrSelector, options)`
- **Use:** `../../../nova-deck-export` injects it into a headless Chromium page; the Computer image
  expands it with `gzip -dc` at build time (`infra/sandboxes/computer/Dockerfile`), and the helper
  also reads the `.gz` directly when the expanded file is absent (tests, a checkout).

It walks a rendered slide's live DOM and emits native PowerPoint shapes, text and images (not a
screenshot) via PptxGenJS. The npm package is not installed because its Node entry pulls in
puppeteer; only this self-contained browser bundle is used.

## Updating

Re-copy `dist/dom-to-pptx.bundle.js` from the target npm version, regenerate the `.gz` with
`gzip -n -c`, bump the version above, and re-run `infra/sandboxes/computer/test_deck_export.py`
and `deck-export/*.test.ts`. Do not edit the bundle by hand.
