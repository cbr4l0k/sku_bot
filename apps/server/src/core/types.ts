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

export type ReminderEffect = {
  kind: "run_reminder";
  userId: number;
  eventId: number;
};

/** A series raised a draft; `canPublish` decides whether this recipient gets the buttons. */
export type DraftReviewEffect = {
  kind: "draft_review";
  userId: number;
  eventId: number;
  canPublish: boolean;
};

/** Sent to an admin about someone else's refund: `runnerId` is whose money it is. */
export type RefundAlertEffect = {
  kind: "refund_failed_alert";
  userId: number;
  eventId: number;
  orderId: string;
  runnerId: number;
  /** As the provider gave it for this failure; a later retry must not rewrite the alert. */
  reason: string | null;
};

export type NotificationEffect = OfferEffect | SupersededEffect | TicketEffect | ReminderEffect | DraftReviewEffect | RefundAlertEffect;
