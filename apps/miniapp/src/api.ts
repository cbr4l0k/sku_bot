import { treaty } from "@elysiajs/eden";

import type { App } from "../../server/src/api";
import { initData } from "./telegram";

const base = import.meta.env.VITE_API_BASE ?? window.location.origin;

export const client = treaty<App>(base, {
  headers: () => ({ "x-init-data": initData() }),
});

/* ------------------------------------------------------------------ plumbing */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

type Blocked = "banned" | "unauthorized";
type BlockedListener = (reason: Blocked) => void;

let blockedListener: BlockedListener | null = null;

export const onBlocked = (listener: BlockedListener): (() => void) => {
  blockedListener = listener;
  return () => {
    blockedListener = null;
  };
};

const codeOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "error" in value) {
    const inner = (value as { error: unknown }).error;
    if (typeof inner === "string") return inner;
  }
  return "request_failed";
};

type TreatyResult = { data: unknown; error: unknown; status: number };

/** Success payload of a treaty endpoint, with the server's inline error shapes removed. */
export type Ok<F extends (...args: never[]) => Promise<TreatyResult>> = Exclude<
  NonNullable<Awaited<ReturnType<F>>["data"]>,
  { error: string }
>;

export const call = async <R extends TreatyResult>(promise: Promise<R>): Promise<Exclude<NonNullable<R["data"]>, { error: string }>> => {
  const result = await promise;
  if (result.error !== null && result.error !== undefined) {
    const value = (result.error as { value?: unknown }).value;
    const code = codeOf(value);
    if (result.status === 401) blockedListener?.("unauthorized");
    if (result.status === 403 && code === "banned") blockedListener?.("banned");
    throw new ApiError(result.status, code);
  }
  const data = result.data;
  if (data === null || data === undefined) throw new ApiError(result.status, "empty_response");
  if (typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
    throw new ApiError(result.status, (data as { error: string }).error);
  }
  return data as Exclude<NonNullable<R["data"]>, { error: string }>;
};

/* --------------------------------------------------------------------- routes */

const api = client.api;
const eventById = api.events({ id: 0 });
const organizerEvent = api.organizer.events({ id: 0 });
const adminEvent = api.admin.events({ id: 0 });

/** The init-data header is part of every route's contract, so it is passed per request. */
const auth = () => ({ headers: { "x-init-data": initData() } });

export type Me = Ok<typeof api.me.get>;
export type EventCard = Ok<typeof api.events.get>[number];
export type EventDetail = Ok<typeof eventById.get>;
export type EventSummary = Ok<typeof api.organizer.events.get>[number];
export type Attendance = Ok<typeof organizerEvent.attendance.get>;
export type AttendanceRow = Attendance["registrations"][number];
export type EventStats = Ok<typeof adminEvent.stats.get>;
export type GlobalStats = Ok<typeof api.admin.stats.get>;
export type AdminUser = Ok<typeof api.admin.users.get>[number];
export type EventLink = Ok<typeof adminEvent.link.get>;
export type Locale = Me["locale"];
export type EventStatus = EventSummary["status"];
export type RegistrationStatus = NonNullable<EventCard["myRegistrationStatus"]>;

export type EventDraft = {
  title: string;
  description: string;
  startsAt: string;
  location: string;
  locationUrl: string | null;
  capacity: number | null;
};

/** Group restrictions ride along with the event, but only admins may set them. */
export type AdminEventDraft = EventDraft & { groups?: string[] };

export const sku = {
  me: () => call(api.me.get(auth())),
  setMe: (body: { locale?: Locale; firstName?: string; lastName?: string }) => call(api.me.patch(body, auth())),

  events: () => call(api.events.get(auth())),
  event: (id: number) => call(api.events({ id }).get(auth())),
  join: (id: number) => call(api.events({ id }).join.post(undefined, auth())),
  cancel: (id: number) => call(api.events({ id }).cancel.post(undefined, auth())),
  acceptOffer: (id: number) => call(api.offers({ id }).accept.post(undefined, auth())),
  checkin: (code: string) => call(api.checkin.post({ code }, auth())),

  organizerEvents: () => call(api.organizer.events.get(auth())),
  updateEvent: (id: number, body: Partial<EventDraft>) => call(api.organizer.events({ id }).patch(body, auth())),
  attendance: (id: number) => call(api.organizer.events({ id }).attendance.get(auth())),
  checkinToken: (id: number) => call(api.organizer.events({ id })["checkin-token"].get(auth())),
  toggleAttendance: (id: number, userId: number) =>
    call(api.organizer.events({ id }).attendance({ userId }).post(undefined, auth())),

  createEvent: (body: AdminEventDraft & { status?: EventStatus }) => call(api.admin.events.post(body, auth())),
  adminUpdateEvent: (id: number, body: Partial<AdminEventDraft> & { status?: EventStatus }) =>
    call(api.admin.events({ id }).patch(body, auth())),
  groupCatalog: () => call(api.admin.groups.get(auth())),
  setUserGroups: (id: number, groups: string[]) => call(api.admin.users({ id }).groups.put({ groups }, auth())),
  deleteEvent: (id: number) => call(api.admin.events({ id }).delete(undefined, auth())),
  setOrganizers: (id: number, userIds: number[]) => call(api.admin.events({ id }).organizers.put({ userIds }, auth())),
  eventStats: (id: number) => call(api.admin.events({ id }).stats.get(auth())),
  eventLink: (id: number) => call(api.admin.events({ id }).link.get(auth())),
  users: (query?: string) => call(api.admin.users.get({ ...auth(), query: query ? { query } : {} })),
  ban: (id: number) => call(api.admin.users({ id }).ban.post(undefined, auth())),
  unban: (id: number) => call(api.admin.users({ id }).unban.post(undefined, auth())),
  promote: (id: number) => call(api.admin.users({ id }).promote.post(undefined, auth())),
  demote: (id: number) => call(api.admin.users({ id }).demote.post(undefined, auth())),
  globalStats: () => call(api.admin.stats.get(auth())),
};
