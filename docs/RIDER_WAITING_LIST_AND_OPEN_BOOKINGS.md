# Rider Waiting List & Open Bookings: Flutter Integration Guide

**For:** Flutter developers (driver app, and the customer app if it has a tracking screen)
**Backend status:** Live on `https://couriergo.online/api` (commit `2ceea5f`)
**Reference implementation:** the web driver panel in this repo (`frontend/src/modules/delivery`) already uses everything below. Use it as a working example.

The backend adds two flows. Neither one changes the existing flow: offer popup → accept → task screen → OTP → delivered all work exactly as before.

| Flow | In one line |
|---|---|
| **1. Waiting list** | A rider already on a delivery can accept more requests. Extra jobs wait in a list until the rider taps **Start**. |
| **2. Open bookings** | A list of **every** booking in the rider's area that still has no rider. Any rider can accept any of them; first come, first served. |

---

## 0. Basics (same as the existing rider APIs)

- Base URL: `https://couriergo.online/api`
- Auth: the rider's existing login token, sent exactly as the app already does for `/parcel/rider/*` calls.
- Every response uses the same envelope:

```json
// success, object payload
{ "success": true,  "error": false, "message": "...", "result": { ... } }

// success, list payload
{ "success": true,  "error": false, "message": "...", "results": [ ... ] }

// failure: always show `message` to the rider; `result.code` is set when there is one
{ "success": false, "error": true,  "message": "Your waiting list is full (3). Start or finish a job first.", "result": { "code": "RIDER_QUEUE_FULL" } }
```

- Socket: the app already connects with the rider token and is auto-joined to `delivery:<riderId>`. Verified riders are also joined to `delivery:online`. Nothing new is needed to connect.

---

## 1. New field on every parcel: `isQueued`

Every parcel object the backend returns now has these fields:

| Field | Type | Meaning |
|---|---|---|
| `isQueued` | bool | `true` = accepted by the rider but **waiting** (rider is busy with another delivery). `false` = live job, or not accepted yet. |
| `queuedAt` | date / null | When it entered the waiting list. Use it to sort the waiting list oldest first. |
| `riderStartedAt` | date / null | When the rider tapped Start. |

A queued parcel has `status: "ACCEPTED"` and `isQueued: true`. **Always check `isQueued`, never only `status`.**

### How to classify the rider's jobs

Call the existing `GET /parcel/rider/assigned`. It returns `results` (all of the rider's non-delivered parcels). Then:

```dart
final open = results.where((p) => !['DELIVERED', 'CANCELLED'].contains(p.status));
final activeJob   = open.firstWhereOrNull((p) => p.isQueued != true);   // max 1
final waitingJobs = open.where((p) => p.isQueued == true).toList()
  ..sort((a, b) => (a.queuedAt ?? a.acceptedAt).compareTo(b.queuedAt ?? b.acceptedAt));
```

> Before this change the app probably took "the first non-delivered parcel" as the active job. **That now breaks**: a queued job could be picked as the active one. Filter on `isQueued`.

---

## 2. Flow 1: Waiting list (multiple accepted jobs)

### 2.1 Behaviour

1. Rider is working job **A**, which is live.
2. A new offer arrives (the same `parcel:broadcast` socket event and FCM push as today). **The app must show the offer popup even while the rider is on a job, including on the task screen.**
3. Rider accepts with the same API as today. The backend sees the rider is busy, so job **B** is saved with `isQueued: true`.
4. **The app must not open the task screen for B.** Show a toast like *"Accepted — added to your waiting list"* and show B in a **Waiting** section on Home.
5. The customer of B sees *"Captain accepted — currently busy"* and **no live tracking**. The backend hides the rider's location from B's customer.
6. Rider finishes A (delivered), then taps **Start** on B → `POST /parcel/rider/start/:id`.
7. B becomes live (`isQueued: false`). Open the task screen for B. From here everything is the normal flow (reached pickup → OTP → delivered), and B's customer's live tracking starts now.

Rules the backend enforces (just show its `message` on error):

- **Start** is refused while another job is live (`409`, code `ACTIVE_JOB_IN_PROGRESS`).
- Status updates (`PUT /parcel/rider/status`) on a queued job are refused (`409`, *"Start this courier from your waiting list first."*).
- The waiting list holds at most **3** jobs (server setting `RIDER_MAX_QUEUED_JOBS`). When it is full, the server stops sending offers to that rider, and an accept returns `409`, code `RIDER_QUEUE_FULL`.
- A free rider nearby is always offered a booking **before** a busy rider. Busy riders only get offers when no free rider is available.
- If the rider already has a waiting job (even with no live job), a new accept is also queued. Jobs are always started in order.

### 2.2 Accepting an offer (existing API, response changed)

`POST /parcel/rider/accept/:parcelId` (header `Idempotency-Key` optional, same as today)

Response `result` is the parcel. **New:** check `result.isQueued`.

```dart
final parcel = res.result;
if (parcel['isQueued'] == true) {
  showToast('Accepted — added to your waiting list. Start it after your current delivery.');
  refreshHome();                       // do NOT navigate to the task screen
} else {
  openTaskScreen(parcel['_id']);       // unchanged behaviour
}
```

The `parcel:assigned` socket event (sent to the rider after an accept) also carries the parcel. If `payload.isQueued == true`, do not navigate; just refresh Home.

### 2.3 Start a waiting job (new API)

`POST /parcel/rider/start/:parcelId`, no body.

| Result | What to do |
|---|---|
| `200`, message `"Courier started"` | Open the task screen for this parcel. |
| `200`, message `"Courier already started"` | It was already live. Open the task screen. |
| `409`, code `ACTIVE_JOB_IN_PROGRESS` | Show `message` ("Finish your current delivery before starting the next one."). |
| `404` | Not this rider's parcel (or it no longer exists). Refresh the list. |
| `409` other | E.g. cancelled meanwhile. Show `message` and refresh. |

Response `result` is the parcel (with `riderEarningBreakdown`), and `isQueued` is now `false`.

> Payout note: the rider's earning distance is re-measured from **where the rider is when they tap Start**, not from where they were when they accepted. Make sure the app has sent a fresh location (`POST /delivery/location`) before Start. The app already sends a heartbeat while online.

### 2.4 UI to build (driver app)

**Home screen**
- **Active job card**: unchanged, but built from `activeJob` (non-queued only).
- **New "Waiting (N)" section**, shown when `waitingJobs` is not empty. One row per job:
  - `PCL-XXXXXX` (last 6 chars of `_id`, uppercased), pickup address, `Collect COD ₹X` if `paymentMethod == "COD"`.
  - **Start** button. Disabled while `activeJob != null`, with the hint "Finish your current delivery, then start the next one."
- Refresh this data when: the screen opens, every ~30 s while online, on the `parcel:assigned` socket event, and after a delivery completes.

**Offer popup**
- Stop blocking the popup when the rider is busy or on the task screen. Only block it while another offer popup is already showing.
- After accept, branch on `isQueued` (see 2.2).

**Task screen**
- If the rider opens a parcel that is `isQueued == true` (e.g. from a notification), show a **Start** button instead of the status buttons.

**Location**
- When sending `POST /delivery/location` with an `orderId`, send only the **live** job's id. Sending a queued job's id is harmless: the server ignores it for tracking. But don't do it.

---

## 3. Flow 2: Open bookings list

### 3.1 Behaviour

- A new screen (web uses a bottom-nav tab **"Bookings"** plus a card on Home) lists every booking near the rider that has no rider yet.
- The list is filtered by the server: rider's radius, rider's zone, not cancelled, not already taken, and not one this rider rejected earlier. It is sorted nearest first.
- The rider may accept **any** booking, not only the one currently offered to them.
- The first rider to accept wins. The booking disappears from every other rider's list immediately (socket event below).
- If the rider is on a job, an accepted booking goes to their **waiting list** (same as Flow 1).
- This works **alongside** the one-at-a-time offer popup. It does not replace it.

### 3.2 Get the list

`GET /parcel/rider/open-bookings`

```json
{
  "success": true,
  "message": "Open bookings fetched",
  "result": {
    "bookings": [ /* parcel objects, see below */ ],
    "canAccept": true,
    "willQueue": false,
    "blockedReason": null
  }
}
```

| Field | Meaning / UI |
|---|---|
| `bookings` | List to render, already sorted nearest first. |
| `canAccept` | `false` → disable every Accept button. |
| `willQueue` | `true` → rider is on a job. Show a banner: "You are on a delivery. A booking you accept goes to your waiting list." Label the button **"Accept to waiting list"**. |
| `blockedReason` | Non-null → show it as a warning banner (e.g. offline, location off, cash limit reached, waiting list full, pending approval). |

Each item in `bookings` is a normal parcel object (no `otp`) plus:

| Extra field | Meaning |
|---|---|
| `distanceToPickupKm` | Rider → pickup distance, km (2 decimals). |
| `estimatedEarning` | ₹ the rider would earn if they accepted from where they are now. |
| `riderPerKmRate` | ₹/km used for that estimate. |
| `offeredToMe` | `true` if this booking is currently in this rider's offer popup. Show an "Offered to you" badge. |
| `courierCompanyId.name` | Populated. Show "Drop at {name}" when present, otherwise `dropAddress.fullAddress`. |

Useful existing parcel fields for the card: `_id`, `pickupAddress.fullAddress`, `dropAddress.fullAddress`, `deliverySpeed` (`"express"` / `"normal"`), `paymentMethod`, `codSettlement.collectAmount` / `payableFare` / `fare` (COD amount to show), `status` (`SEARCHING`, or `REQUESTED` if it had fallen back to admin).

### 3.3 Accept from the list

`POST /parcel/rider/open-bookings/:parcelId/accept` (header `Idempotency-Key`: send a UUID per tap)

| Result | What to do |
|---|---|
| `200`, `result.isQueued == false` | Open the task screen for this parcel. |
| `200`, `result.isQueued == true` | Toast "Accepted — added to your waiting list", refresh the list and Home. |
| `409`, *"Another rider already accepted this booking."* / *"This booking is no longer open."* | Toast `message`, refresh the list. |
| `409`, code `RIDER_QUEUE_FULL` | Toast `message`. |
| `403` | Cash limit / outside zone / outside radius / not approved: toast `message`. |

### 3.4 Keeping the list live

Socket event **`parcel:open:changed`**, sent to all verified riders:

```json
{ "parcelId": "665f...", "action": "added" | "removed" | "changed", "at": "2026-10-14T09:22:41.000Z" }
```

Treat it as a hint only: **re-fetch** `GET /parcel/rider/open-bookings` (debounce ~400 ms). Don't edit the list locally, because the server applies each rider's own radius, zone and eligibility.

Also re-fetch:
- when the screen opens or the app resumes,
- every ~20 s while the screen is visible (safety net for a missed socket event),
- after the rider goes online/offline.

---

## 4. Customer app (if you have a Flutter customer tracking screen)

For a queued parcel (`isQueued == true` and status `ACCEPTED`):

- **Title:** "Captain accepted — currently busy"
- **Subtitle:** "Your captain is finishing another delivery and will start yours next. Live tracking begins once they set off."
- **Top bar:** "Captain busy · Will start after current delivery"
- **Status chip** (history/detail): "Accepted · Rider Busy"
- **Hide** the rider marker, route and "captain is X km away".
- Rider name and phone **are** still returned. Showing them is fine.

The backend already enforces this:
- `GET /parcel/track/:id` returns `deliveryPartnerId` **without** `location` while queued.
- No `location:update` socket events are sent for a queued parcel.

When the rider taps Start, the customer receives `parcel:status:update` with `isQueued: false`. Re-fetch `GET /parcel/track/:id` and switch to the normal live-tracking UI. The customer also gets a push: "Rider is on the way to pick up your courier."

Push text on a queued accept (`bodyKey: status_accepted_queued`): "Rider accepted your courier. They are finishing another delivery and will start yours next." Translated into en/hi/gu/mr; other languages fall back to English.

---

## 5. Quick API reference

| Method | Path | New? | Purpose |
|---|---|---|---|
| GET | `/parcel/rider/assigned` | existing | All of the rider's jobs. Split by `isQueued`. |
| POST | `/parcel/rider/accept/:parcelId` | existing (response has `isQueued`) | Accept the offer from the popup. |
| POST | `/parcel/rider/reject/:parcelId` | existing | Skip the offer (unchanged). |
| PUT | `/parcel/rider/status` | existing | Status steps. Refused for queued jobs. |
| **GET** | **`/parcel/rider/open-bookings`** | **new** | Open bookings list. |
| **POST** | **`/parcel/rider/open-bookings/:parcelId/accept`** | **new** | Accept from the list. |
| **POST** | **`/parcel/rider/start/:parcelId`** | **new** | Start a waiting job. |
| GET | `/parcel/track/:id` | existing | Customer tracking. No rider location while queued. |

| Socket event | To | Payload | Use |
|---|---|---|---|
| `parcel:broadcast` | rider | unchanged | Offer popup. Now also arrives while the rider is busy. |
| `parcel:assigned` | rider | parcel (has `isQueued`) | Navigate only if `isQueued != true`. |
| `parcel:broadcast:withdrawn` | rider | unchanged | Close the popup. |
| **`parcel:open:changed`** | all verified riders | `{parcelId, action, at}` | Re-fetch open bookings. |
| `parcel:status:update` | customer | now includes `isQueued` | Switch between busy and tracking UI. |

| Error code (`result.code`) | Where | Meaning |
|---|---|---|
| `RIDER_QUEUE_FULL` | accept (both) | Waiting list full. |
| `ACTIVE_JOB_IN_PROGRESS` | start | Finish the live job first. |
| `CASH_LIMIT_REACHED` | accept (both) | Existing COD cash limit. |

---

## 6. Test checklist for the app

1. Rider free → accept offer → task screen opens (unchanged).
2. Rider on job A → new offer popup appears (also on the task screen) → accept → **no** navigation, toast, B shows under **Waiting**.
3. Customer of B sees "currently busy", with no rider marker or route.
4. Tap Start on B while A is live → error message shown, nothing changes.
5. Deliver A → tap Start on B → task screen for B opens. Customer of B now sees live tracking.
6. Fill the waiting list (3 jobs) → no more offers arrive. An accept from open bookings shows the "waiting list is full" message.
7. Two riders on the Bookings screen → rider 1 accepts a booking → it disappears from rider 2's list within a second or two.
8. Rider 2 taps Accept on a booking rider 1 just took → "Another rider already accepted this booking."
9. Rider offline or location off → Bookings screen shows the `blockedReason` banner and buttons are disabled.
10. Rider on job → Bookings screen shows the "goes to your waiting list" banner, and the button says "Accept to waiting list".
