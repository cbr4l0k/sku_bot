import { blockquote, bold, code, format, join, link } from "gramio";
import type { LanguageMap } from "@gramio/i18n";
import type { EventUpdatedFields } from "../event-card";

export const en = {
  welcome: "Welcome to the running club! Let's get you ready for the next run.",
  contactPrompt: "Share your phone number so we can keep your registration and send important updates.",
  contactButton: "📱 Share my contact",
  contactSaved: "All set — your contact is saved.",
  contactRejected: "Please share your own contact using the button below.",
  hero: () => format`${bold("🏃 Running Club")}

${blockquote("Runs, training sessions, and good company — all in one place.")}`,
  openApp: "🏃 Open the app",
  openEvent: "Open event",
  eventCity: (city: string) => `🏙 ${city}`,
  eventDate: (date: string) => `📅 ${date}`,
  eventLocation: (location: string, locationUrl: string | null) => format`📍 ${locationUrl ? link(location, locationUrl) : location}`,
  spotsLeft: (count: number) => `Spots left: ${count}`,
  eventUnavailable: "This event is no longer available.",
  unknownPayload: "We couldn't recognise that link, but you're in the right place.",
  error: "Something went wrong. Please try again.",
  offer: (title: string, date: string) => format`${bold("A spot has opened up!")}

${bold(title)}
${date}

You have 20 minutes to accept it.`,
  offerBroadcast: (title: string, date: string) => format`${bold("A spot has opened up!")}

${bold(title)}
${date}

The event starts soon, so everyone in the queue has been notified. The first to accept gets the spot.`,
  offerAccept: "Accept",
  offerAccepted: (title: string, date: string) => format`${bold("You're confirmed!")}

${bold(title)}
${date}`,
  offerSpotTaken: "This spot has already been taken. Please check the app for other events.",
  bannedNotice: "Your access to event registration is restricted. Please contact the club organizers.",
  offerSuperseded: "This spot is no longer available.",
  eventCanceled: (title: string) => format`${bold("Event canceled")}

${title} has been canceled. We hope to see you at another run soon.`,
  eventUpdated: (title: string, changes: EventUpdatedFields) => format`${bold("Event updated")}

${bold(title)}

${join([
    changes.title === undefined ? null : format`• New title: ${changes.title}`,
    changes.description === undefined ? null : format`• Description updated`,
    changes.startsAt === undefined ? null : format`• New date: ${changes.startsAt}`,
    changes.location === undefined ? null : format`• New location: ${changes.location}`,
    changes.capacity === undefined ? null : format`• New capacity: ${changes.capacity === null ? "unlimited" : changes.capacity}`,
  ].filter((change): change is ReturnType<typeof format> => change !== null), (change) => change, "\n")}`,
  joinButton: "✅ Sign up",
  joinQueueButton: "⏳ Join the queue",
  noSpotsLeft: "No spots left.",
  cardRegistered: "You are signed up.",
  cardWaitlisted: "You are in the queue.",
  cardCheckedIn: "You are checked in.",
  joinedNotice: "Done — you are signed up!",
  queuedNotice: "You are in the queue. We will message you the moment a spot frees up.",
  alreadyJoinedNotice: "You are already signed up for this event.",
  notEligibleNotice: "This event is only for members of certain Telegram groups.",
  chatInvite: (title: string) => format`${bold("Welcome to the event chat")}

${title}

${blockquote("The link is single-use and yours alone. Turn up and check in and the chat is yours to keep. If you never make it, we will quietly remove you after the event.")}`,
  chatInviteButton: "💬 Join the chat",
  commandStart: "Main menu",
  commandChatId: "Show this group's ID",
  chatId: (chatId: number) => format`This chat's ID is ${code(String(chatId))}

The chat is already in the catalog — pick its city under Admin → Chats and events there can use it.`,
  chatIdOnlyInGroups: "Run this command inside the group whose ID you need.",
} satisfies LanguageMap;
