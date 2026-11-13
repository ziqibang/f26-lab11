import type { RefundRequested } from '../bus/events';
import type { Message, Subscriber } from '../bus/inMemoryBus';
import type { PaymentGateway } from '../integrations/paymentGateway';

/** One line in the refund ledger. */
export interface LedgerEntry {
  entryId: string;
  bookingId: string;
  organizer: string;
  amountCents: number;
  reason: string;
  recordedAtMinute: number;
}

/**
 * Books refunds and sends the money back.
 *
 * For a refund message the handler writes a ledger entry, then calls the
 * payment provider for the same amount. The ledger is append only: entries are
 * numbered in the order they were written, and nothing edits or removes one
 * after the fact.
 */
export class RefundLedger implements Subscriber<RefundRequested> {
  readonly name = 'RefundLedger';

  private readonly entries: LedgerEntry[] = [];
  private readonly gateway: PaymentGateway;
  /**
   * Progress per refund message id: present once the ledger entry is written,
   * `true` once the provider has settled. Lets a redelivery skip finished work
   * and finish a refund whose provider call threw.
   */
  private readonly settledByMessage = new Map<string, boolean>();

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway;
  }

  handle(message: Message<RefundRequested>): void {
    const event = message.payload;
    const settled = this.settledByMessage.get(message.id);
    if (settled === true) {
      return;
    }
    if (settled === undefined) {
      this.entries.push({
        entryId: `led-${this.entries.length + 1}`,
        bookingId: event.bookingId,
        organizer: event.organizer,
        amountCents: event.amountCents,
        reason: event.reason,
        recordedAtMinute: message.publishedAtMinute,
      });
      this.settledByMessage.set(message.id, false);
    }
    this.gateway.refund(event.bookingId, event.amountCents);
    this.settledByMessage.set(message.id, true);
  }

  /** Every ledger entry, oldest first. */
  all(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Entries for one booking, oldest first. */
  forBooking(bookingId: string): LedgerEntry[] {
    return this.all().filter((entry) => entry.bookingId === bookingId);
  }

  /** What the ledger says has been refunded, in cents. */
  totalRefundedCents(): number {
    return this.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  }

  size(): number {
    return this.entries.length;
  }
}
