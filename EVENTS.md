# EVENTS.md

One section per milestone. Fill each one in order as you go.

The prediction in milestone 2 should be written before you run the replay. That is the
part a TA will ask about.

Keep it short and specific. Point at operations, call sites, and what a caller
gets back.

---

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

One row per operation. Read the code, not the file
names. "As wired today" is what the code does now. "Your call" is what you
would do if this were your service. List up to eight operations, and remove
the rows you don't use.

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Booking write (validate, conflict check, price, save) | Synchronous in the request path: `BookingService.book`, `bookingService.ts:65-95` (`store.save` at :95). A failure propagates to the caller. | Sync | The user asked to book, so they need to know it's saved before getting a response. |
| 2 | Search indexing of a new booking | Synchronous in the request path, not on the bus: `bookingService.ts:94` calls `SearchIndexClient.indexBooking`. Runs before `store.save`, uncaught. `cancel` never calls the index. | Bus | `book` uses nothing the index returns, so a search outage shouldn't block bookings. |
| 3 | Audit record | Synchronous in the request path: `bookingService.ts:96` (book), `:137` and `:170` (cancel), calling `AuditTrail.record`. Uncaught. | Sync | Every booking must have an audit line, so it should succeed or fail together with the save. |
| 4 | Confirmation and cancellation email | Bus: published at `bookingService.ts:114` / `:154`, subscribed at `app.ts:76` / `:81`, handled in `EmailConfirmationHandler.handle`. Runs synchronously inside `publish`. Throws become dead letters. | Bus | The user doesn't need the email to know they're booked; a mail outage shouldn't fail the booking. |
| 5 | Receipt | Bus: `booking.confirmed`, subscribed at `app.ts:77`, handled in `ReceiptGenerator.handle` (`receiptGenerator.ts:39`). Runs inside `publish`. Throws become dead letters. | Bus | The receipt can arrive a moment later; a failure shouldn't fail the booking. |
| 6 | Reminders | Bus: subscribed at `app.ts:78` / `:82`, handled in `ReminderScheduler.handle` (`reminderScheduler.ts:48`), which schedules or drops. Sending is `dispatchDue` (`:97`), which no request calls. | Bus | Reminders are for a future time; nothing needs to happen before the response. |
| 7 | Dashboard stats | Bus: subscribed at `app.ts:79` / `:83`, handled in `StatsUpdater.handle` (`statsUpdater.ts:36`), which recounts the whole store. Runs inside `publish`. Throws become dead letters. | Bus | No user waits on the dashboard; the recount shouldn't slow or fail bookings. |
| 8 | Refund ledger and payment provider | Bus: `refund.requested` published at `bookingService.ts:169`, subscribed at `app.ts:85`, handled in `RefundLedger.handle`. It writes the ledger entry (`refundLedger.ts:35`), then calls `gateway.refund` (`:43`). Throws become dead letters, and `cancel` still returns normally. | Sync | The user should only be told "refunded" once the provider confirms; money is too serious to report before it moves. |

### Two calls in detail

Pick two rows and give each a paragraph rather than a line. One of them has to
be the operation `TICKET.md` implicates.

**First operation and your call.** Describe what the caller of
the operation needs and by when, and what a caller sees when the work it
depends on is not available.

Row 2, search indexing → bus. To finish a booking, the caller needs to know
the booking is saved, and they need that before the response. Nothing in
`book` uses what the search index returns; the index only feeds the
room-finder page. The conflict check reads the booking store, not the index.
Today, though, `book` calls `indexBooking` synchronously at
`bookingService.ts:94`, before the save. So when the search cluster is down,
the caller gets a `SearchIndexUnavailableError` and nothing is saved. That's
how RES-5108 blocked every booking for 35 minutes. If indexing were a
subscriber on `booking.confirmed`, a search outage would only make the
room-finder page stale. Bookings would still succeed, and failed index writes
would land on the dead-letter list for someone to retry once the cluster is
back. The cost is that a new booking may not show up in search right away.

**Second operation and your call.**

Row 8, refund → sync. When someone cancels, the refund amount is already
calculated synchronously in `cancel`. Today, though, the money itself moves
on the bus: the ledger entry is written first and the provider is called
afterward (`refundLedger.ts:35`, then `:43`). If the provider fails, the bus
swallows the error and the caller is still told the cancellation succeeded,
while the ledger shows a refund the organizer never received. I'd make the
provider call part of `cancel`, so the caller is only told "refunded" once
the provider confirms, and the ledger is written only after that. The cost is
the same kind of coupling that caused RES-5108: if the provider is slow,
cancellations are slow (as they already are today, since the bus delivers
synchronously inside `cancel`), and if it's down, the caller gets an error and
has to try again later. I accept that for refunds because telling someone
they've been paid when they haven't is worse than asking them to retry.

### The incident

**The call behind `TICKET.md`.** Name the file, the method,
and the line of the call the incident report is about, and describe what the
caller of that method gets back when that call throws.

`src/service/bookingService.ts`, method `BookingService.book`, line 94
(`this.searchIndex.indexBooking(booking, room, now)`). When it throws, `book`
catches nothing: `SearchIndexUnavailableError` propagates to the caller, and
nothing is saved, audited or published.

---

## Milestone 2: what a second delivery does

### Your prediction (before you run anything)

**What you expect `redeliver` on a refund message to do.** Name what you expect
to change in the ledger, at the payment provider, and in the bus log. Write it
down, then run the demo.

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

**Your prediction against the run.** Where they agree and where they do not.

### Your fix

**The diff.** Paste it.

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** One or two lines.

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

**What stays the same across its three states.** Name the numbers you
compared.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

### Your recovery

**What, if anything, the failed delivery left undone.**

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.
