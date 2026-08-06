import { blockquote, bold, format, join } from "gramio";
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
  eventDate: (date: string) => `📅 ${date}`,
  eventLocation: (location: string) => `📍 ${location}`,
  spotsLeft: (count: number) => `Spots left: ${count}`,
  eventUnavailable: "This event is no longer available.",
  unknownPayload: "We couldn't recognise that link, but you're in the right place.",
  error: "Something went wrong. Please try again.",
  offer: (title: string, date: string) => format`${bold("A spot has opened up!")}

${bold(title)}
${date}

You have 20 minutes to accept it.`,
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
  commandStart: "Main menu",
} satisfies LanguageMap;
