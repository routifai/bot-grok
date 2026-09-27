# Muse design

The Muse edition should feel calm, personal, and quietly capable: ChatGPT's restraint, Wispr Flow's warmth and spacing, and the richness of the Aiden concept's cards (a deck preview, "finished while you were away", "one yes before I send this"). Light-first, with a matching dark theme. Everything here applies only in Muse mode (`[data-product="muse"]`); upstream Rakazo keeps its look.

## The Muse

The Muse is **Aiden**, drawn as a single round, friendly face (`BotAvatar` with `face="muse"`, `packages/ui-web/src/bot-avatar.tsx`). The body is a soft rounded blob filled with the bot's identity color (sky by default) and shaded with a subtle depth gradient (lighter top-left, slightly deeper bottom-right, built only from the illustration's own ink/shine constants layered over that color — never a new hex), plus a soft rim light along the top edge and a gentle contact shadow underneath. Two dark oval eyes with glints, blush cheeks, and a small gold spark on top complete the silhouette; it reads at 24–32px and is delightful at 96–160px (welcome 160px, onboarding 120px, auth 88px).

His face changes with `data-muse-state` (`idle | thinking | working | waiting`, derived by `museAvatarState`, never a free string):
- **idle** — relaxed smile, a slow blink, the spark floating.
- **thinking** — eyes glance up-right, one eyebrow raised, a small "hmm" mouth, three thought dots pulsing.
- **working** — eyes slightly narrowed, a small determined smile, a gentle sway, the spark spinning.
- **waiting** — both eyebrows up, an open happy mouth, a small waving hand at one side, a hop, and the existing Ask-count badge.

Expressions are structural (conditional SVG keyed on state, so they still show under `prefers-reduced-motion`); the breathing, blinking, swaying, hopping, spinning and waving are CSS animations on top, all turned off under reduced motion. He is our own character, not a bank's logo.

## Foundations

**Color.** Semantic tokens only (`@aiden/ui-tokens`: `museLightTokens`, `museDarkTokens`). White surfaces, hairline borders, ink primary. The app stays monochrome: the Muse's identity color (gold `#F2B233` by default, Aiden's ring) is the only brand color and appears only on the Muse face. Status colors are semantic: `warning` = waiting on you, `success` = done or live, `destructive` = failed. Never hardcode a hex in a component.

**Type.**
- Geist (body, UI): 14–15px body, 13px secondary, 12px meta.
- Instrument Serif (`font-display`): screen titles (40px), empty-state leads (24px), the Muse's greeting. Never for body text or buttons. Italic sparingly for one emphasized word.
- Geist Mono (`font-mono`): eyebrows and labels only — 10.5–11px, uppercase, `tracking-[0.08em]`.

**Space and shape.** Content in a centered 720px column (`MuseColumn`), 32px side padding on desktop, 20px on phones. Cards: 16px radius, 1px border, 16–20px padding, no shadow at rest. Elevation (`shadow-float`) only for things that float: the composer, popovers, sheets, hovered interactive cards. Gaps between cards 12px; between sections 40px.

**Motion.** 150ms color/border transitions; nothing bounces except the Muse face. Respect `prefers-reduced-motion`.

## Building blocks

Import from `apps/web/src/pages/muse/ui`: `MuseScreen`, `MuseColumn`, `ScreenHeader`, `Section`, `Eyebrow`, `Surface` (`default | attention | quiet`, `interactive`), `StatusPill` (`neutral | live | attention | done`), `Chip`, `DetailRows`, `Progress`, `EmptyState`. Use them before writing new chrome. Buttons, inputs, tabs, sheets, dialogs come from `@aiden/ui-web`. Icons: `lucide-react`, 16px, `strokeWidth={1.75}`.

## Card patterns (from the Aiden concept)

- **Waiting on you (Ask).** `Surface tone="attention"`. Header row: small icon + a plain-language title in the Muse's voice ("One yes before I send this", "Which evenings work?"). For approvals, show what will happen with `DetailRows` (To, Subject, Attached, Body…) parsed from the Ask's `detail` when it has `Key: value` lines, otherwise the detail as quiet text. Actions: the primary choice as a solid ink button ("Send it"), the rest as outline/ghost ("Let me edit first", "Not now"). Source (Goal title or "Conversation") as a mono eyebrow.
- **Finished while you were away (Goal report Post).** `Surface` with a 2px `warning` left edge, mono eyebrow "Finished while you were away · Tue" (relative day), the report in the Muse's voice, and a quiet link to the Goal.
- **Found for you (Followed-topic Post).** `Surface`, eyebrow with the topic and source host, title, two-line summary, "Read" link opening the source.
- **Proposal.** `Surface tone="attention"`: reason in one sentence, the proposed plan as a numbered list with added items marked and removed items struck through, "Accept plan" (solid) and "Keep current" (ghost).
- **Ideas.** Under a "Things I could start now" eyebrow: `Chip`s, grouped by area only when there are more than six.
- **Status.** A `StatusPill` near the Muse's name: "Nova is on 2 things · last check 4m ago" (`live` while anything runs, `attention` when Asks are open).

## Screens

- **Rail.** 64px, `bg-sidebar`, the Muse face (40px, with its state and Ask badge) at the top, then Conversation, Goals, Feed, Library as icon + 10.5px label, active item on `bg-sidebar-accent` with ink icon. Settings at the bottom.
- **Conversation.** Header with the Muse's name and the status pill. Messages in the 720px column; the person's messages in soft `chat-user` bubbles on the right, the Muse's replies without a bubble. The composer floats (`shadow-float`, 24px radius) with placeholder "Message Nova…".
- **Goals.** `ScreenHeader` "Goals" with a one-line subtitle ("2 active · 1 waiting on you"). Each Goal is an interactive `Surface`: title, next Task, `Progress` (done/total), due date, and a `StatusPill` for its state (working / waiting on you / paused). Detail: title in serif, the plan as a vertical timeline (status icon per Task, notes in muted text), the Proposal card on top when open, Check-ins and the Goal log below.
- **Feed.** `ScreenHeader` "Feed". Open Asks first (attention cards), then "Today" / "Earlier" sections of Posts, then Ideas, then Followed topics as removable chips.
- **Library.** `ScreenHeader` "Library" with a search field and facet `Chip`s (All, Pages, Documents, Decks, Images, …, with counts). A responsive grid (2–3 columns) of preview cards: a 16:10 preview area (thumbnail or a large type icon on `bg-muted`), a mono type eyebrow, title, "Updated 2h ago · from Goal X", and quiet actions on hover.
- **Waiting on you.** A right sheet with the same Ask cards as the Feed, newest first.
- **Onboarding.** One centered 440px column, serif question as the title ("What should I call you?"), one input, one ink button; the Muse face large on the color step.

## Copy

The Muse speaks in the first person and plainly ("I have not booked anything.", "One yes before I send this"). Labels are short. No explainer paragraphs; empty states are one line.
