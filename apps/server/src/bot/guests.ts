import { InlineKeyboard, TelegramError } from "gramio";
import { and, chatMembers, eq, users, type Db } from "@sku/db";

import { MEMBERSHIP_TTL_MS } from "../core/membership";
import {
  eventsAwaitingSettlement,
  inviteCandidates,
  settleTrials,
  startTrial,
  type InviteCandidate,
} from "../core/guests";
import { eventSummary } from "./event-card";
import { i18n } from "./i18n";
import { telegramMembership } from "./membership";
import { bot } from "./index";

/** Long enough that someone who books weeks ahead still has a working link on the day. */
const LINK_GRACE_MS = 12 * 60 * 60 * 1000;
const MIN_LINK_LIFE_MS = 60 * 60 * 1000;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const warn = (action: string, error: unknown) =>
  console.warn(`Telegram ${action} failed: ${error instanceof Error ? error.message : String(error)}`);

const localeFor = (db: Db, userId: number) =>
  db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).get()?.locale ?? "ru";

/**
 * Whether Telegram will confirm, right now, that someone is outside the chat.
 *
 * The `chat_members` cache is not good enough on its own: a failed lookup is
 * recorded there as "not a member" so an unreachable chat closes an event rather
 * than opening it, and treating that as gospel here would put a long-standing
 * member on trial and eventually remove them. So the answer is asked for again and
 * acted on only when Telegram gives a plain one.
 *
 * A *fresh* cached "member" is trusted, which is what stops this from re-asking about
 * the same regulars on every pass — an open event has no `event_chats` rows, so nothing
 * else ever fills that cache for them. It has to go stale though, on the same clock as
 * everything else: someone who leaves the chat must become invitable again, and
 * trusting a "member" answer forever would lock them out of every future run.
 */
const confirmedOutsider = async (db: Db, chatId: number, userId: number, now: Date): Promise<boolean> => {
  const cached = db.select({ isMember: chatMembers.isMember, checkedAt: chatMembers.checkedAt }).from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId))).get();
  if (cached?.isMember && now.getTime() - cached.checkedAt.getTime() < MEMBERSHIP_TTL_MS) return false;

  const answer = await telegramMembership(chatId, userId);
  if (answer === null || !("isMember" in answer)) return false;

  const isMember = answer.isMember;
  db.insert(chatMembers)
    .values({ chatId, userId, isMember, checkedAt: now })
    .onConflictDoUpdate({ target: [chatMembers.chatId, chatMembers.userId], set: { isMember, checkedAt: now } })
    .run();
  return !isMember;
};

/**
 * The Bot API has no way to put someone into a group — only invite links do that.
 * So each guest gets their own single-use link and taps it themselves.
 */
const issueInvite = async (db: Db, candidate: InviteCandidate, now: Date): Promise<void> => {
  const locale = localeFor(db, candidate.userId);
  const event = eventSummary(candidate.eventId, locale);
  if (!event) return;

  const expiry = Math.max(event.startsAt.getTime() + LINK_GRACE_MS, now.getTime() + MIN_LINK_LIFE_MS);
  const link = await bot.api.createChatInviteLink({
    chat_id: candidate.chatId,
    name: `sku evt ${candidate.eventId} u${candidate.userId}`.slice(0, 32),
    expire_date: seconds(new Date(expiry)),
    member_limit: 1,
    suppress: true,
  });
  if (link instanceof TelegramError) {
    warn(`invite link for chat ${candidate.chatId}`, link);
    return;
  }

  const sent = await bot.api.sendMessage({
    chat_id: candidate.userId,
    text: i18n.t(locale, "chatInvite", event.title),
    reply_markup: new InlineKeyboard().url(i18n.t(locale, "chatInviteButton"), link.invite_link),
    suppress: true,
  });
  if (sent instanceof TelegramError) {
    // Nobody can use a link they were never handed, and an unclaimed one should not
    // outlive the attempt. The candidate stays a candidate and is retried next sweep.
    warn(`invite message to ${candidate.userId}`, sent);
    const revoked = await bot.api.revokeChatInviteLink({ chat_id: candidate.chatId, invite_link: link.invite_link, suppress: true });
    if (revoked instanceof TelegramError) warn("invite link revocation", revoked);
    return;
  }

  startTrial(db, candidate, link.invite_link, now);
};

/** Kicks without banning: a ban is what removes them, the immediate unban lets them return later. */
const removeFromChat = async (chatId: number, userId: number): Promise<void> => {
  const banned = await bot.api.banChatMember({ chat_id: chatId, user_id: userId, suppress: true });
  if (banned instanceof TelegramError) {
    warn(`removal of ${userId} from chat ${chatId}`, banned);
    return;
  }
  const unbanned = await bot.api.unbanChatMember({ chat_id: chatId, user_id: userId, only_if_banned: true, suppress: true });
  if (unbanned instanceof TelegramError) warn(`unban of ${userId} in chat ${chatId}`, unbanned);
};

/**
 * The verdicts are recorded before the kicks are carried out, so a crash halfway
 * through leaves a no-show in the chat rather than risking someone being kicked
 * twice on the next pass. A permission the bot is missing shows up the same way:
 * logged per call, with the guest keeping access rather than the sweep looping.
 */
const settleEvent = async (db: Db, eventId: number, now: Date): Promise<void> => {
  for (const verdict of settleTrials(db, eventId, now)) {
    if (verdict.carriedTo !== null || verdict.keep) continue;

    const revoked = await bot.api.revokeChatInviteLink({ chat_id: verdict.chatId, invite_link: verdict.inviteLink, suppress: true });
    if (revoked instanceof TelegramError) warn("invite link revocation", revoked);

    // Only ever remove someone Telegram still places in the chat, and only ever a
    // guest: a member who predates the trial has no row here and is never seen.
    const answer = await telegramMembership(verdict.chatId, verdict.userId);
    if (answer !== null && "isMember" in answer && answer.isMember) {
      await removeFromChat(verdict.chatId, verdict.userId);
    }
  }
};

/**
 * One reconciliation pass: settle the trials of every event that is over, then
 * invite whoever is still missing from a live event's home chat. Both halves are
 * idempotent and driven by state rather than by the moment something happened, so
 * a run that was down, a spot handed out by the waitlist, and a home chat set on an
 * event that already has people signed up all converge on the same result.
 */
export const syncChatGuests = async (db: Db, now: Date = new Date()): Promise<void> => {
  for (const eventId of eventsAwaitingSettlement(db, now)) await settleEvent(db, eventId, now);

  for (const candidate of inviteCandidates(db)) {
    // Someone who has blocked the bot fails at the DM every time and stays a candidate.
    // That is the intended cost of not giving up on a merely transient failure.
    if (await confirmedOutsider(db, candidate.chatId, candidate.userId, now)) await issueInvite(db, candidate, now);
  }
};
