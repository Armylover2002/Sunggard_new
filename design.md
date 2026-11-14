# CourierGo — Design System

The single reference for how this product looks, reads, and moves. Every module
follows it. If a screen disagrees with this document, the screen is wrong.

---

## 1. What this product is

CourierGo books courier parcels. A customer enters a pickup and a drop, picks a
carrier, pays, and tracks the consignment. That is the whole product.

It used to be a quick-commerce app, and the codebase still carries scars from
that: disabled grocery routes, a car-wash module behind comments, and — until
this pass — a login screen advertising *Grocery, Store, Food, Health* with a
photo carousel of vegetables. Anything that reads as retail is a leftover, not a
direction. Remove it when you find it.

---

## 2. Design inspiration: the consignment note

**Every surface is a courier docket.**

This is not a metaphor chosen for decoration — it is the artifact the product
actually produces. A parcel booking *is* a waybill. So the interface is built
from the vocabulary of printed shipping stationery:

| Real-world element | Where it appears in the UI |
| --- | --- |
| Mono field captions | Every label, in uppercase with wide tracking |
| Tear-off perforation | Between a card's header stub and its body |
| Barcode | Inks in progressively as a form is completed |
| Rubber stamp | Lands once, rotated, on a terminal state |
| Route line | Progress, drawn as a parcel travelling a dashed path |
| Leader dots | Receipt line items, label ···· value |
| Carton glyph | The app's icon, weight indicator, and route rider |

The rule that keeps this honest: **structural devices must encode something
true.** The barcode is only complete when the booking is. The parcel on the
route rail sits where you actually are. A stamp appears only when a state is
final. If an element cannot be tied to real data, cut it.

### Where it lives

| File | Role |
| --- | --- |
| [`frontend/src/shared/design/tokens.js`](frontend/src/shared/design/tokens.js) | Type stacks, ink values, timing, springs. Source of truth. |
| [`frontend/src/shared/components/auth/consignmentKit.jsx`](frontend/src/shared/components/auth/consignmentKit.jsx) | Sign-in vocabulary. Shared by all modules. |
| [`frontend/src/modules/customer/components/parcel/waybillKit.jsx`](frontend/src/modules/customer/components/parcel/waybillKit.jsx) | Booking-flow vocabulary. |
| [`frontend/src/index.css`](frontend/src/index.css) | Colour tokens and theme presets. |
| [`frontend/src/styles/design-system.css`](frontend/src/styles/design-system.css) | Legacy `.ds-*` utility classes. |

---

## 3. Colour

Brand colour is **themeable**; paper and ink are **not**. A consignment note is
printed stock — it must read as paper under every preset.

### Themeable (CSS custom properties, `index.css`)

Only ever reference these through `var(--…)`. Never hardcode the green.

```
--primary          #0C831F   carrier green — progress, filled state, actions
--brand-50…950               computed from --primary via color-mix
--background       #F8FAFC
--surface / --card #FFFFFF
--foreground       #0F172A
--muted-foreground #64748B
--border           #E2E8F0
--destructive      #EF4444
--ring             var(--primary)
```

Three presets ship in `index.css` (Green quick-commerce — active, Corporate
blue, Purple luxury). Swapping `--primary` re-themes the entire app including
every surface described here.

### Fixed stationery values (`tokens.js`)

| Token | Value | Job |
| --- | --- | --- |
| `INK` | `#0F172A` | The carrier's copy, headings |
| `PAPER` | `#FFFFFF` | The note itself |
| `COUNTER` | `#F1F5F9` | The surface the note lies on |
| `RULE` | `rgba(15,23,42,0.18)` | Dashed rules, tear lines |
| `RULE_LIGHT` | `rgba(255,255,255,0.22)` | The same rule on ink |
| `ALERT` | `#B45309` | Amber — refused, over-limit |

**Amber, not red, for user-correctable states.** A wrong OTP and an
over-weight parcel are the same class of problem: fixable, not broken.
`--destructive` red is reserved for genuine failure and destruction.

### Elevation

Paper contact shadows only — a hairline plus a soft cast. Never a coloured glow.

```js
LIFT      = '0 1px 2px rgba(15,23,42,0.04), 0 12px 32px -18px rgba(15,23,42,0.28)'
LIFT_HIGH = '0 2px 4px rgba(15,23,42,0.06), 0 32px 64px -28px rgba(15,23,42,0.40)'
```

---

## 4. Typography

Two faces, split by what the text *is*.

| Role | Stack | Used for |
| --- | --- | --- |
| Prose | **Outfit** (`PROSE`) | Headings, body, buttons, anything a person wrote |
| Data | **System mono** (`MONO`) | Numbers, captions, codes, statuses, anything printed |

The split is the point. Shipping data is monospaced everywhere it exists
physically — tracking numbers, weights, waybill captions — so numerals and field
captions go mono while sentences stay on Outfit. Outfit is already loaded in
[`index.html`](frontend/index.html); mono is the system stack, so it costs
nothing.

**Never add a third typeface.** Distinctiveness here comes from the mono/prose
split and the caption treatment, not from font variety.

### Scale

| Use | Size / weight | Tracking |
| --- | --- | --- |
| Page heading | 22px / 800 | `-0.02em` |
| Section heading | 15px / 800 | `-0.01em` |
| Body | 13–15px / 400–500 | normal |
| **Field caption** | 10px / 500 mono **uppercase** | `0.18em` |
| Button label | 12px / 700 mono uppercase | `0.22em` |
| Data / numerals | 13–26px mono `tabular-nums` | `0.1em` |
| Hint | 11px / 500, `--muted-foreground` | normal |

The 10px uppercase mono caption at `0.18em` is the system's most recognisable
signature. Use it for every field label. Do not substitute a sentence-case
label.

---

## 5. Motion

Two engines, split by job. This split is deliberate — do not mix them within one
behaviour.

| Engine | Import | Drives |
| --- | --- | --- |
| **motion.dev** | `motion/react` | Declarative state: panes, presence, layout, shared-element pills |
| **anime.js v4** | `animejs` | Imperative, event-fired moments: a digit landing, a box taking ink, a stamp hitting paper |

The rule of thumb: if the animation is caused by *state changing*, it is
motion.dev. If it is caused by *something happening* — a keystroke, a rejection,
an impact — it is an anime.js timeline.

### Timing (`tokens.js`)

```js
DUR   = { tap: 120, quick: 220, base: 380, pane: 520, stamp: 700 }   // anime.js, ms
EASE  = { out: 'outExpo', inOut: 'inOutQuad', back: 'outBack', elastic: 'outElastic' }

SPRING = {                                                           // motion.dev
  pane:  { stiffness: 320, damping: 34, mass: 0.8 },   // steps sliding
  pill:  { stiffness: 480, damping: 34, mass: 0.7 },   // travelling selection
  stamp: { stiffness: 420, damping: 17, mass: 0.9 },   // rubber stamps
  note:  { stiffness: 260, damping: 30, mass: 0.9 },   // cards arriving
}
```

Springs, not durations, for anything that moves in space. Durations only for
ink, colour, and opacity.

### Direction carries meaning

Panes slide along the direction of travel, so going back visibly reverses.
`NotePane` takes `direction={1}` forward and `direction={-1}` back.

### Reduced motion is not optional

Every component reads `useReducedMotion()` from `motion/react` and:

- collapses motion.dev springs to `STILL` (`{ duration: 0 }`),
- skips anime.js timelines entirely and writes the end state with `utils.set()`.

State must still be legible with all motion off. A component that only
communicates through animation is broken.

---

## 6. Component vocabulary

From [`consignmentKit.jsx`](frontend/src/shared/components/auth/consignmentKit.jsx):

| Component | What it is |
| --- | --- |
| `DepotGround` | The counter. Dot grid at 5.5% ink, two dashed routes. Nothing else. |
| `ConsignmentNote` | The docket. `28px` radius, arrives with a slight rotation. |
| `NoteStub` | Dark carrier's copy: mark, "Consignment note", copy number. |
| `ConsignmentNumber` | **Signature element.** `SG · 91 · ##########`, built live from the number being typed. Each digit rolls into its slot (anime.js). |
| `RouteLeader` | Progress as a parcel travelling a dashed route. |
| `TearEdge` | The perforation, with punches showing the counter through the paper. |
| `NoteSwitch` | Segmented control; selection travels via motion.dev `layoutId`. |
| `NoteField` / `noteInput` | Caption + input chrome. Filled inputs take a 5% brand wash. |
| `DeliveryCode` | OTP entry. One real input under four presentational boxes, so paste, `one-time-code` autofill and the caret stay native and the value can never develop gaps. Ink-press per digit, amber shake on refusal. |
| `InkBarcode` | Bars ink in with the completion ratio, staggered like a thermal printer. |
| `NoteAction` | Primary button. Label replaced by a travelling dash while working. |
| `AcceptedStamp` | Lands once at `-7°` with an ink ring spreading from impact. |
| `NotePane` | Step transitions. |
| `NoteFooter` | Legal links in the note's voice. |

### Radii

`28px` note · `16px` fields, boxes, buttons · `12px` pills · `8px` stamps ·
full for punches and route nodes.

---

## 7. Writing

Words are design material. They exist to make the interface easier to use.

- **Active voice, named for what happens.** "Send code", not "Submit".
- **One name per action, all the way through.** The button that says *Verify
  code* produces a toast that says *Signed in* — never a third synonym.
- **Specific beats clever.** "Riders call this number for pickup and drop"
  earns its place; "Let's get you moving!" does not.
- **Errors state what happened and how to fix it**, in the interface's voice.
  They never apologise and are never vague:
  > That code didn't match. Check the 4 digits and try again.
- **Captions label. Hints explain. Nothing does double duty.**
- Sentence case for prose. UPPERCASE only for mono captions and button labels.

---

## 8. Quality floor

Non-negotiable on every screen:

- Responsive to 320px; the note is `max-w-[400px]` and never overflows.
- Visible keyboard focus everywhere:
  `focus-visible:ring-2 focus-visible:ring-[color:var(--primary)]`.
- `prefers-reduced-motion` respected (§5).
- Inputs carry real `autoComplete` (`tel-national`, `one-time-code`, `name`)
  and `inputMode`.
- Every icon-only control has an `aria-label`; decorative SVG is `aria-hidden`.
- Colour is never the only signal — pair it with a caption or an icon.

---

## 9. Module adoption

The kit is shared (`@shared/components/auth/…`) so every module can file the same
note. Current state, honestly:

| Surface | File | Status |
| --- | --- | --- |
| Customer sign-in / sign-up | `modules/customer/pages/CustomerAuth.jsx` | ✅ Rebuilt on the kit |
| Parcel booking | `modules/customer/components/parcel/waybillKit.jsx` | ✅ Native to the language |
| Seller auth | `modules/seller/pages/Auth.jsx` | ⬜ Not converted |
| Delivery-partner auth | `modules/delivery/pages/DeliveryAuth.jsx` | ⬜ Not converted |
| Admin auth | `modules/admin/pages/AdminAuth.jsx` | ⬜ Not converted |

### Converting a surface

1. Wrap in `DepotGround` + `ConsignmentNote`.
2. Header → `NoteStub`, then `TearEdge`.
3. Every label → `NoteField` (mono caption); every input → `noteInput()`.
4. Mode toggles → `NoteSwitch`. Steps → `NotePane` inside `AnimatePresence`.
5. OTP → `DeliveryCode`. Submit → `NoteAction`.
6. Delete the module's Lottie hero — illustration is not part of this language.
7. Replace hardcoded colours with `var(--primary)` and the `tokens.js` values.

Multi-step surfaces (seller, delivery) also carry document upload and map
picking. Those keep their logic; only their chrome changes.

---

## 10. Known debt

- **Two animation engines ship.** `motion@13` nests its own `framer-motion@13`
  while 107 files still import `framer-motion@12` directly. The `vendor-motion`
  chunk is ~264 KB raw (~87 KB gzip), roughly double a single copy. Fix: migrate
  those 107 imports to `motion/react` and drop `framer-motion` from
  `package.json`. It is close to a find-and-replace, but it crosses a major
  version, so it deserves its own pass.
- **`eslint-plugin-react` is not installed**, so `react/jsx-uses-vars` never
  runs and every JSX-only import is falsely reported as unused. Repo-wide, not
  specific to these files.
- **`styles/design-system.css`** (`.ds-*`) predates this system and encodes a
  different, denser scale. Treat `tokens.js` as authoritative; retire `.ds-*` as
  screens are touched.
- Seller and delivery auth still open with Lottie illustrations, which belong to
  the old retail direction.
