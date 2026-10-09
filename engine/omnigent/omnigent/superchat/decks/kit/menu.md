Layouts (put the layout class and one surface class on each `<section class="slide ...">`):

| layout | use it for | notes |
|---|---|---|
| `l-cover` | the opening slide | kicker, `h1.title` (8 words max), `p.lead`, `p.meta` |
| `l-section` | a chapter break | `.num` (01), `h2.title` |
| `l-statement` | one sentence that matters | `.kicker`, `h2.statement` (14 words max) |
| `l-points` | up to three ideas | `.kicker`, `h2.title`, `.grid` of 3 `.point` (`.num`, `h3`, `p` of 20 words max) |
| `l-split` | two sides of one idea | `.kicker`, `h2.title`, `.cols` of 2 `.col` (`h3`, `p`, or `.panel` with `p`s) |
| `l-stats` | up to three real figures | `.kicker`, `h2.title`, `.grid` of 3 `.stat` (`.value`, `.label`); use only numbers you were given |
| `l-quote` | a quotation | `.kicker`, `blockquote.quote`, `.by` |
| `l-closing` | the ask or next step | `.kicker`, `h2.title`, `p.lead`, `p.contact` |

Surfaces: `t-a`, `t-b`, `t-c` (the template's three backgrounds). Alternate them for rhythm; cover and closing use `t-b`.

Every slide ends with `<div class="foot" data-nova-id="NAME-foot"><span data-nova-id="NAME-foot-left">Deck name</span><span data-nova-id="NAME-foot-page">02</span></div>`.

Example slide:

```html
<section class="slide t-a l-points" data-screen-label="03 Three ideas" data-nova-id="ideas">
  <div class="kicker" data-nova-id="ideas-kicker">What we found</div>
  <h2 class="title" data-nova-id="ideas-title">Three things moved</h2>
  <div class="grid" data-nova-id="ideas-grid">
    <div class="point" data-nova-id="ideas-a"><div class="num" data-nova-id="ideas-a-num">01</div><h3 data-nova-id="ideas-a-h">Short heading</h3><p data-nova-id="ideas-a-p">One short sentence.</p></div>
    <div class="point" data-nova-id="ideas-b"><div class="num" data-nova-id="ideas-b-num">02</div><h3 data-nova-id="ideas-b-h">Short heading</h3><p data-nova-id="ideas-b-p">One short sentence.</p></div>
    <div class="point" data-nova-id="ideas-c"><div class="num" data-nova-id="ideas-c-num">03</div><h3 data-nova-id="ideas-c-h">Short heading</h3><p data-nova-id="ideas-c-p">One short sentence.</p></div>
  </div>
  <div class="foot" data-nova-id="ideas-foot"><span data-nova-id="ideas-foot-left">Deck name</span><span data-nova-id="ideas-foot-page">03</span></div>
</section>
```
