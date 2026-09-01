export type OfferEffect = {
  kind: "offer_created";
  offerId: number;
  userId: number;
  eventId: number;
  expiresAt: Date;
  /** Inside the final 90 minutes, every waitlister races for the open spot. */
  broadcast?: true;
};

export type SupersededEffect = {
  kind: "offer_superseded";
  offerId: number;
  userId: number;
  eventId: number;
  messageId: number | null;
};

export type TicketEffect = {
  kind:
    | "ticket_paid"
    | "ticket_refunded"
    | "ticket_refund_failed"
    | "purchase_paid"
    | "purchase_refunded"
    | "purchase_refund_failed";
  userId: number;
  eventId: number;
};

export type NotificationEffect = OfferEffect | SupersededEffect | TicketEffect;
