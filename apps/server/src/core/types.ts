export type OfferEffect = {
  kind: "offer_created";
  offerId: number;
  userId: number;
  eventId: number;
  expiresAt: Date;
};

export type SupersededEffect = {
  kind: "offer_superseded";
  offerId: number;
  userId: number;
  eventId: number;
  messageId: number | null;
};

export type NotificationEffect = OfferEffect | SupersededEffect;
