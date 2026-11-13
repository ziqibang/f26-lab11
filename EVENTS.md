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

Ledger: After the cancellation there is 1 entry for the booking. After one redeliver I expect 2 entries, and after two, 3 entries, because the handler adds a new ledger entry every time without checking.

Payment provider: After the cancellation the organizer has been refunded 1 time. After one redeliver 2 settlements, after two 3, so the organizer receives a total of 3× the refund amount.

Bus log: The number of messages in the log will not change after redelivery, because redeliver doesn't add a new line to the bus log. The refund message's delivery count will go from 1 to 2 to 3.

Dead letters: I expect 0 dead letters, because nothing makes the handler throw. The duplicate refunds go through successfully, so the organizer is paid three times and nothing flags it.

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Your prediction against the run.** Where they agree and where they do not.

My prediction matched on every point. Each redelivery of msg-3 added another ledger entry and another $85.00 settlement, so after two redeliveries the organizer had been refunded $255.00 for an $85.00 cancellation. The bus log still shows one line for msg-3, with deliveries=3, and there were 0 dead letters, because nothing threw. The duplicate refunds succeeded silently and nothing flagged them.

### Your fix

**The diff.** Paste it.

```diff
diff --git a/src/handlers/refundLedger.ts b/src/handlers/refundLedger.ts
index 600ffca..b0d8746 100644
--- a/src/handlers/refundLedger.ts
+++ b/src/handlers/refundLedger.ts
@@ -25,6 +25,12 @@ export class RefundLedger implements Subscriber<RefundRequested> {
 
   private readonly entries: LedgerEntry[] = [];
   private readonly gateway: PaymentGateway;
+  /**
+   * Progress per refund message id: present once the ledger entry is written,
+   * `true` once the provider has settled. Lets a redelivery skip finished work
+   * and finish a refund whose provider call threw.
+   */
+  private readonly settledByMessage = new Map<string, boolean>();
 
   constructor(gateway: PaymentGateway) {
     this.gateway = gateway;
@@ -32,15 +38,23 @@ export class RefundLedger implements Subscriber<RefundRequested> {
 
   handle(message: Message<RefundRequested>): void {
     const event = message.payload;
-    this.entries.push({
-      entryId: `led-${this.entries.length + 1}`,
-      bookingId: event.bookingId,
-      organizer: event.organizer,
-      amountCents: event.amountCents,
-      reason: event.reason,
-      recordedAtMinute: message.publishedAtMinute,
-    });
+    const settled = this.settledByMessage.get(message.id);
+    if (settled === true) {
+      return;
+    }
+    if (settled === undefined) {
+      this.entries.push({
+        entryId: `led-${this.entries.length + 1}`,
+        bookingId: event.bookingId,
+        organizer: event.organizer,
+        amountCents: event.amountCents,
+        reason: event.reason,
+        recordedAtMinute: message.publishedAtMinute,
+      });
+      this.settledByMessage.set(message.id, false);
+    }
     this.gateway.refund(event.bookingId, event.amountCents);
+    this.settledByMessage.set(message.id, true);
   }
 
   /** Every ledger entry, oldest first. */
```

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** One or two lines.

Key: the message id. The handler tracks each refund message as "ledger written" or "settled": a redelivery of a settled message does nothing, and a redelivery after a failure partway through skips the ledger write and only retries the gateway call.

Doesn't protect: a new message for the same refund (new id, pays again); a provider that actually paid but still threw, such as a timeout (a retry pays twice); and a restart, since the map lives only in memory.

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**What stays the same across its three states.** Name the numbers you
compared.

All three states are identical: 1 ledger entry (led-1), 1 gateway call, 1 settlement (stl-1), $85.00 returned in total, and 0 dead letters, compared with 3 entries, 3 settlements and $255.00 before the fix. The only thing that changes is the bus log: msg-3 still shows deliveries=3. So the message really was delivered three times, and the handler turned the second and third deliveries into no-ops.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

```
armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1

the refund message is in the log and in the dead-letter list. Milestone 3 asks what you do with it.
```

### Your recovery

**What, if anything, the failed delivery left undone.**

The ledger entry led-1 ($85.00 for bk-1001) was written, but the gateway call threw, so no money moved: 0 settlements and $0.00 returned. The ledger now claims a refund the organizer never got, and since the bus doesn't retry, msg-3 sits on the dead-letter list with deliveries=1.

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

State after redelivering msg-3:

```
=== after redelivering the refund message ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}
```

Bus log line for msg-3:

```
  msg-3 refund.requested deliveries=2
```

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.

Triage would have put the work on a person on call, who checks the provider for a settlement on bk-1001 before retrying; the organizer waits until then, but it’s safe even without an idempotent handler because a human confirms the money didn’t move.
