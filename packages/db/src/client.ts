import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import * as schema from "./schema";

export const createDb = (path: string) => {
  const client = new Database(path);
  client.exec("PRAGMA foreign_keys = ON");
  return drizzle({ client, schema });
};

export type Db = ReturnType<typeof createDb>;
export type User = InferSelectModel<typeof schema.users>;
export type NewUser = InferInsertModel<typeof schema.users>;
export type Event = InferSelectModel<typeof schema.events>;
export type NewEvent = InferInsertModel<typeof schema.events>;
export type EventOrganizer = InferSelectModel<typeof schema.eventOrganizers>;
export type NewEventOrganizer = InferInsertModel<typeof schema.eventOrganizers>;
export type Registration = InferSelectModel<typeof schema.registrations>;
export type NewRegistration = InferInsertModel<typeof schema.registrations>;
export type WaitlistOffer = InferSelectModel<typeof schema.waitlistOffers>;
export type NewWaitlistOffer = InferInsertModel<typeof schema.waitlistOffers>;

export { schema };
