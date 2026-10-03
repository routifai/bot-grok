# Muse design

The Muse edition should feel calm, personal, and quietly capable: ChatGPT's restraint, Wispr Flow's warmth and spacing, and the richness of the Aiden concept's cards (a deck preview, "finished while you were away", "one yes before I send this"). Light-first, with a matching dark theme. Muse is Aiden's only edition now (the old multi-bot mode has been retired); the styling here is still scoped under `[data-product="muse"]`, which the app sets unconditionally.

## The Muse

The Muse is **Aiden**, drawn as a single round, friendly face (`BotAvatar` with `face="muse"`, `packages/ui-web/src/bot-avatar.tsx`). The body is a soft rounded blob filled with the bot's identity color (sky by default) and shaded with a subtle depth gradient (lighter top-left, slightly deeper bottom-right, built only from the illustration's own ink/shine constants layered over that color — never a new hex), plus a soft rim light along the top edge and a gentle contact shadow underneath. Two dark oval eyes with glints, blush cheeks, and a small gold spark on top complete the silhouette; it reads at 24–32px and is delightful at 96–160px (welcome 160px, onboarding 120px, auth 88px).

His face changes with `data-muse-state` (`idle | thinking | working | waiting`, derived by `museAvatarState`, never a free string):
- **idle** — relaxed smile, a slow blink, the spark floating.
- **thinking** — eyes glance up-right, one eyebrow raised, a small "hmm" mouth, three thought dots pulsing.
- **working** — eyes slightly narrowed, a small determined smile, a gentle sway, the spark spinning.
- **waiting** — both eyebrows up, an open happy mouth, a small waving hand at one side, a hop, and the existing Ask-count badge.

Expressions are structural (conditional SVG keyed on state, so they still show under `prefers-reduced-motion`); the breathing, blinking, swaying, hopping, spinning and waving are CSS animations on top, all turned off under reduced motion. He is our own character, not a bank's logo.

**Bloop.** Wherever the Muse's face appears, `BotAvatar face="muse"` draws it as a 3D jelly drop, `BloopAvatar` in `apps/web/src/components/ai/bloop/`, supplied app-wide through `LiveMuseFaceProvider` so no surface changes its own call. The four states and the Ask badge are the same as the static face. The body takes the Muse's identity color (top, bottom and rim shades derived from it); the eyes, brows and cheeks reuse the face constants above, and the thought cloud, work spinner and "…" bubble are drawn from the `--card`, `--border` and `--foreground` tokens, so both themes work. Props appear from 32px up; smaller faces are framed tighter without them. One shared WebGL renderer (`live.ts`) draws every face onto its own 2D canvas, so a page never holds more than one WebGL context; a face claims one of 12 live slots when it scrolls into view and the rest stay static. The static SVG face renders first and stays when WebGL is unavailable; three.js loads lazily, like the aurora. Under `prefers-reduced-motion` each face draws a still frame.

## Foundations

**Color.** Semantic tokens only (`@aiden/ui-tokens`: `museLightTokens`, `museDarkTokens`). White surfaces, hairline borders, ink primary. The app stays monochrome: the Muse's identity color (gold `#F2B233` by default, Aiden's ring) is the only brand color and appears only on the Muse face. Status colors are semantic: `warning` = waiting on you, `success` = done or live, `destructive` = failed. Never hardcode a hex in a component.

**Type.** One scale (`MUSE_TYPE` in `apps/web/src/pages/muse/ui`), Instrument Sans everywhere in-app — it's the edition's inherited body font, never set explicitly per component:
- `chromeTitle` (15.5px semibold): the screen's name in the shared top bar.
- `pageTitle` (28px semibold): a screen that reads like its own page (Ideas' hero, a Goal's own title).
- `sectionTitle` (15px semibold): a group heading inside a screen ("Plan", "Paused", "Productivity").
- `cardTitle` (16px semibold): a card's or row's own title (a Goal, a Post, a Library item, an Idea).
- `body` (15px, relaxed leading): reading text inside a card or row.
- `meta` (13px, muted): a quiet fact line — dates, counts, sources.
- `label` (`font-mono`, 11px, uppercase, `tracking-[0.08em]`): a small tag, sparingly — never a whole heading.

Instrument Serif (`font-display`) is reserved for the signed-out welcome and auth screens; it never appears on an in-app section header or empty state.

**Space and shape.** Content in a centered 720px column (`MuseColumn`) or, for screens that fill the panel (Goals, Library), a wide left-aligned one (`MuseWideColumn`); 32px side padding on desktop, 20px on phones. Cards: 16px radius, 1px border, 16–20px padding, no shadow at rest. Elevation (`shadow-float`) only for things that float: the composer, popovers, sheets, hovered interactive cards. Gaps between cards 12px; between sections 40px.

**Motion.** 150ms color/border transitions; nothing bounces except the Muse face. Respect `prefers-reduced-motion`.

**Background wash.** The signed-in shell sits on a soft, static wash — a very light base tinted with a few large, heavily blurred color blobs (`wash-1..3`: Aiden's sky blue plus a faint lilac and cyan; plain CSS radial gradients, no filter blur, so it paints once and stays cheap). The sidebar, the main content area, and the right context/computer panels float above it as separate `glass`-filled panels (`glass`, `glass-border`, `~74%` opacity, `backdrop-blur-xl`, a hairline light border, `shadow-float`), rounded and gapped 8px apart with room around the edges — full-bleed with no gaps on phones. Cards inside a panel (a Goal, a Post, a Library item, an Ask) stay the plain opaque `Surface`/`bg-card` from Card patterns below, so a panel always reads as two depths: translucent glass, then solid cards on top.

## Building blocks

Import from `apps/web/src/pages/muse/ui`: `MuseScreen` (takes an optional `header`), `ScreenHeader` (the one top chrome bar — same height, border and title style everywhere, shared by the Conversation and every other section), `MuseColumn`, `MuseWideColumn`, `Section`, `Eyebrow`, `Surface` (`default | attention | quiet`, `interactive`), `StatusPill` (`neutral | live | attention | done`), `Chip`, `DetailRows`, `Progress`, `EmptyState` (the Muse's face, a headline, one line, and optional suggestion chips that start a Conversation). Use them before writing new chrome. Buttons, inputs, tabs, sheets, dialogs come from `@aiden/ui-web`. Icons: `lucide-react`, 16px, `strokeWidth={1.75}`.

## Card patterns (from the Aiden concept)

- **Waiting on you (Ask).** `Surface tone="attention"`. Header row: small icon + a plain-language title in the Muse's voice ("One yes before I send this", "Which evenings work?"). For approvals, show what will happen with `DetailRows` (To, Subject, Attached, Body…) parsed from the Ask's `detail` when it has `Key: value` lines, otherwise the detail as quiet text. Actions: the primary choice as a solid ink button ("Send it"), the rest as outline/ghost ("Let me edit first", "Not now"). Source (Goal title or "Conversation") as a mono eyebrow.
- **Finished while you were away (Goal report Post).** `Surface` with a 2px `warning` left edge, mono eyebrow "Finished while you were away · Tue" (relative day), the report in the Muse's voice, and a quiet link to the Goal.
- **Found for you (Followed-topic Post).** `Surface`, eyebrow with the topic and source host, title, two-line summary, "Read" link opening the source.
- **Proposal.** `Surface tone="attention"`: reason in one sentence, the proposed plan as a numbered list with added items marked and removed items struck through, "Accept plan" (solid) and "Keep current" (ghost).
- **Ideas.** Under a "Things I could start now" eyebrow: `Chip`s, grouped by area only when there are more than six.
- **Status.** Nothing while idle. While thinking/working: a small animated face plus a shimmering verb next to the Muse's name or under it ("Thinking…", "Browsing…", "Running code…", "Writing a file…") — no border, no counters, no timestamps. While an Ask is open: a clickable `StatusPill` ("Needs you", `attention` tone) that opens Waiting. See `apps/web/src/pages/muse/chrome/useMuseLiveState.ts` and `MuseLiveStatus.tsx`.

## Screens

Every section shares one `ScreenHeader` chrome bar at the top (same height, padding, border and title style as the Conversation's, with a right-side actions slot) and the same column widths and top spacing below it.

- **Rail.** A glass panel (see Background wash), the Muse face (40px, with its state and Ask badge) at the top, then Conversation, Goals, Feed, Ideas, Library as icon + 10.5px label, active item on a soft tinted `primary/10` pill with ink icon. Settings at the bottom.
- **Conversation.** `ScreenHeader` with the Muse's name and the status pill inline. Messages in the 720px column; the person's messages in soft `chat-user` bubbles on the right, the Muse's replies without a bubble. The composer floats (`shadow-float`, 24px radius) with placeholder "Message Nova…". Empty: the shared `EmptyState`.
- **Goals.** `ScreenHeader` "Goals". Each Goal is an interactive `Surface`: title, next Task, `Progress` (done/total), due date, and a `StatusPill` for its state (working / waiting on you / paused). Detail: title in the page-title scale, the plan as a vertical timeline (status icon per Task, notes in muted text), the Proposal card on top when open, Check-ins and the Goal log below. Empty: the shared `EmptyState` with a few Goal suggestions.
- **Feed.** `ScreenHeader` "Feed", single centered column. Open Asks first (attention cards), then "Today" / "Earlier" sections of Posts as plain cards (no accent bar; the Muse's own face marks a Goal report, a quiet source line marks a topic finding), then Followed topics as a chip row with a trailing "Follow a topic" chip. Empty (no Asks, no Posts): the shared `EmptyState`.
- **Ideas.** `ScreenHeader` "Ideas" with a refresh action. A big page title and a one-line first-person subtitle, then Ideas grouped by area under a sentence-case heading: a quiet icon tile, the idea's own text as the row's title, and a hover arrow. Tapping a row starts a Conversation with it.
- **Library.** `ScreenHeader` "Library" with a search field and facet `Chip`s (All, Pages, Documents, Decks, Images, …, with counts). A responsive grid (2–3 columns) of preview cards: a 16:10 preview area (thumbnail or a large type icon on `bg-muted`), a mono type eyebrow, title, "Updated 2h ago · from Goal X", and quiet actions on hover. Empty: the shared `EmptyState` with a few Library suggestions.
- **Waiting on you.** A right sheet with the same Ask cards as the Feed, newest first.
- **Onboarding.** One centered 440px column, serif question as the title ("What should I call you?"), one input, one ink button; the Muse face large on the color step.

## Copy

The Muse speaks in the first person and plainly ("I have not booked anything.", "One yes before I send this"). Labels are short. No explainer paragraphs; empty states are one line.
