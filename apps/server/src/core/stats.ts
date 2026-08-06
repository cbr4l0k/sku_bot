import type { Db } from "@sku/db";
type Registration = { event_id: number; user_id: number; status: string };
export const eventStats = (db: Db, eventId: number) => {
  const registrations = db.$client.query<Registration, [number]>("SELECT event_id, user_id, status FROM registrations WHERE event_id = ?").all(eventId);
  const registered = registrations.filter((row) => row.status === "registered" || row.status === "checked_in").length;
  const checkedIn = registrations.filter((row) => row.status === "checked_in").length;
  const offers = db.$client.query<{ status: string }, [number]>("SELECT status FROM waitlist_offers WHERE event_id = ?").all(eventId);
  return { registered, waitlisted: registrations.filter((row) => row.status === "waitlisted").length, checkedIn, attendanceRate: registered ? checkedIn / registered : 0, offersMade: offers.length, offersAccepted: offers.filter((row) => row.status === "accepted").length };
};
export const globalStats = (db: Db) => {
  const events = db.$client.query<{ id: number; capacity: number | null }, []>("SELECT id, capacity FROM events").all();
  const registrations = db.$client.query<Registration, []>("SELECT event_id, user_id, status FROM registrations").all();
  const confirmed = registrations.filter((row) => row.status === "registered" || row.status === "checked_in");
  const checkedIn = registrations.filter((row) => row.status === "checked_in");
  const capacityEvents = events.filter((row) => row.capacity !== null && row.capacity > 0);
  const counts = new Map<number, number>();
  for (const row of registrations) if (row.status !== "canceled") counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  const names = new Map(db.$client.query<{ id: number; first_name: string }, []>("SELECT id, first_name FROM users").all().map((row) => [row.id, row.first_name]));
  return { totalEvents: events.length, uniqueParticipants: counts.size, avgFillRate: capacityEvents.length ? capacityEvents.reduce((sum, event) => sum + confirmed.filter((row) => row.event_id === event.id).length / (event.capacity ?? 1), 0) / capacityEvents.length : 0, attendanceRate: confirmed.length ? checkedIn.length / confirmed.length : 0, topParticipants: [...counts.entries()].map(([userId, count]) => ({ userId, firstName: names.get(userId) ?? "", count })).sort((a, b) => b.count - a.count || a.userId - b.userId).slice(0, 10) };
};
