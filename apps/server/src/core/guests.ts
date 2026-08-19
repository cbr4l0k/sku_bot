import type { Db } from "@sku/db";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * How long an ended event's trials wait before being settled. Marking attendance by
 * hand stays open after the event is over — correcting a roster is part of the job —
 * and removing someone is not undoable from here: they would need a whole new invite.
 * So the sweep hangs back and lets the organizer finish. Reopening the event inside
 * the window calls the whole thing off, since it clears `ended_at`.
 */
export const SETTLEMENT_GRACE_MS = 60 * 60 * 1000;

/** Someone holding a spot who has no trial on record in that event's home chat yet. */
export type InviteCandidate = { eventId: number; chatId: number; userId: number };

/**
 * Who might still need letting in: everyone with a confirmed spot at a live event
 * that has a home chat, minus those already on trial there. Waitlisted people are
 * left out — they have no spot yet — and banned ones never get an invite even if
 * the ban landed after they signed up.
 *
 * A candidate is not yet a guest: the caller must confirm with Telegram that they
 * really are outside the chat before inviting them (see bot/guests.ts). Anyone
 * already in it is simply skipped, which is what keeps long-standing members out
 * of `chat_guests` — and so beyond the reach of the removal sweep.
 */
export const inviteCandidates = (db: Db): InviteCandidate[] => db.$client
  .query<InviteCandidate, []>(`
    SELECT e.id AS eventId, e.home_chat_id AS chatId, r.user_id AS userId
    FROM events e
    JOIN registrations r ON r.event_id = e.id
    JOIN users u ON u.id = r.user_id
    WHERE e.home_chat_id IS NOT NULL
      AND e.status = 'published'
      AND e.ended_at IS NULL
      AND r.status IN ('registered', 'checked_in')
      AND u.is_banned = 0
      AND NOT EXISTS (
        SELECT 1 FROM chat_guests g
        WHERE g.chat_id = e.home_chat_id AND g.user_id = r.user_id AND g.status = 'invited'
      )
    ORDER BY r.created_at, r.id
  `)
  .all();

/**
 * Starts a trial, or restarts one for a guest removed after an earlier no-show.
 * There is one row per person per chat, so a returning guest overwrites their own
 * settled record rather than accumulating history.
 */
export const startTrial = (db: Db, candidate: InviteCandidate, inviteLink: string, now: Date): void => {
  db.$client
    .query(`
      INSERT INTO chat_guests (chat_id, user_id, event_id, invite_link, status, created_at, settled_at)
      VALUES (?, ?, ?, ?, 'invited', ?, NULL)
      ON CONFLICT (chat_id, user_id) DO UPDATE
        SET event_id = excluded.event_id, invite_link = excluded.invite_link,
            status = 'invited', created_at = excluded.created_at, settled_at = NULL
    `)
    .run(candidate.chatId, candidate.userId, candidate.eventId, inviteLink, seconds(now));
};

/** What ending an event decided about one guest whose trial hung on it. */
export type TrialVerdict = {
  chatId: number;
  userId: number;
  inviteLink: string;
  /** The event the trial moves to, when the guest still has another run to show up for. */
  carriedTo: number | null;
  keep: boolean;
};

/**
 * Settles every trial resting on an event that is over. Three outcomes:
 *
 * - They checked in, so the trial is over and they keep their place for good.
 * - They never showed, but hold a spot at another live run into the same chat, so
 *   the trial is carried over to it rather than settled. Without this, booking a
 *   second run would quietly buy a permanent seat.
 * - Otherwise they are removed, and the caller kicks them from the chat.
 */
export const settleTrials = (db: Db, eventId: number, now: Date): TrialVerdict[] => db.$client.transaction((): TrialVerdict[] => {
  type Row = { chatId: number; userId: number; inviteLink: string; checkedIn: number; carriedTo: number | null };
  const rows = db.$client
    .query<Row, [number]>(`
      SELECT g.chat_id AS chatId, g.user_id AS userId, g.invite_link AS inviteLink,
        EXISTS (
          SELECT 1 FROM registrations r
          WHERE r.event_id = g.event_id AND r.user_id = g.user_id AND r.status = 'checked_in'
        ) AS checkedIn,
        (
          SELECT other.id FROM events other
          JOIN registrations r ON r.event_id = other.id AND r.user_id = g.user_id
          WHERE other.id <> g.event_id
            AND other.home_chat_id = g.chat_id
            AND other.status = 'published'
            AND other.ended_at IS NULL
            AND r.status IN ('registered', 'checked_in')
          ORDER BY other.starts_at
          LIMIT 1
        ) AS carriedTo
      FROM chat_guests g
      WHERE g.event_id = ? AND g.status = 'invited'
    `)
    .all(eventId);

  const verdicts: TrialVerdict[] = [];
  for (const row of rows) {
    const keep = row.checkedIn === 1;
    const carriedTo = keep ? null : row.carriedTo;
    if (carriedTo !== null) {
      db.$client.query("UPDATE chat_guests SET event_id = ? WHERE chat_id = ? AND user_id = ?")
        .run(carriedTo, row.chatId, row.userId);
    } else {
      db.$client.query("UPDATE chat_guests SET status = ?, settled_at = ? WHERE chat_id = ? AND user_id = ?")
        .run(keep ? "kept" : "removed", seconds(now), row.chatId, row.userId);
    }
    verdicts.push({ chatId: row.chatId, userId: row.userId, inviteLink: row.inviteLink, carriedTo, keep });
  }
  return verdicts;
})();

/**
 * Events whose trials are ready to settle: an event is over once it has been ended or
 * has left `published` at all, so closing or unpublishing one settles its trials too
 * rather than stranding its guests in the chat forever. Only an ending waits out
 * SETTLEMENT_GRACE_MS — the others are deliberate acts on an event nobody is running.
 */
export const eventsAwaitingSettlement = (db: Db, now: Date): number[] => db.$client
  .query<{ eventId: number }, [number]>(`
    SELECT DISTINCT g.event_id AS eventId
    FROM chat_guests g
    JOIN events e ON e.id = g.event_id
    WHERE g.status = 'invited'
      AND (e.ended_at IS NOT NULL OR e.status <> 'published')
      AND (e.ended_at IS NULL OR e.ended_at <= ?)
  `)
  .all(seconds(new Date(now.getTime() - SETTLEMENT_GRACE_MS)))
  .map((row) => row.eventId);
