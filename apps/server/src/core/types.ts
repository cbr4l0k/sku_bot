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

export type NotificationEffect = OfferEffect | SupersededEffect;
