import { Schema } from "effect";

/**
 * The ways an action can say no. Each family keeps the exact codes the API and
 * the bot already answer with, so the boundaries map them as before.
 */

export class JoinRejected extends Schema.TaggedError<JoinRejected>()("JoinRejected", {
  code: Schema.Literals(["banned", "not_published", "already_joined", "event_over", "not_eligible", "event_full"]),
}) {}

export class OfferRejected extends Schema.TaggedError<OfferRejected>()("OfferRejected", {
  code: Schema.Literal("spot_taken"),
}) {}

export class CheckinRejected extends Schema.TaggedError<CheckinRejected>()("CheckinRejected", {
  code: Schema.Literals(["not_registered", "already_checked_in", "event_over"]),
}) {}

export class HandoverRejected extends Schema.TaggedError<HandoverRejected>()("HandoverRejected", {
  code: Schema.Literal("item_not_found"),
}) {}

export class CheckoutRejected extends Schema.TaggedError<CheckoutRejected>()("CheckoutRejected", {
  code: Schema.Literals([
    "event_not_found",
    "event_over",
    "not_eligible",
    "already_joined",
    "ticket_not_found",
    "ticket_sales_closed",
    "ticket_sold_out",
    "invalid_basket",
    "product_not_found",
    "product_variant_required",
    "product_variant_not_found",
    "product_sold_out",
    "product_limit_exceeded",
    "active_order_exists",
    "event_full",
    "contact_required",
  ]),
}) {}

export type CheckoutError = CheckoutRejected["code"];

export class OrderRejected extends Schema.TaggedError<OrderRejected>()("OrderRejected", {
  code: Schema.Literals(["order_not_found", "order_not_cancelable", "order_not_refundable"]),
}) {}

export class SeriesRejected extends Schema.TaggedError<SeriesRejected>()("SeriesRejected", {
  code: Schema.Literals([
    "series_not_found",
    "series_inactive",
    "next_starts_at_missing",
    "next_starts_at_past",
    "cadence_missing",
    "event_not_found",
    "city_mismatch",
  ]),
}) {}

export class RolesRejected extends Schema.TaggedError<RolesRejected>()("RolesRejected", {
  code: Schema.Literals(["forbidden", "duplicate_city"]),
}) {}
