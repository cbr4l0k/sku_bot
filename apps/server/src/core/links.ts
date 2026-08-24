export const eventStartappPayload = (eventId: number): string => `evt_${eventId}`;

export const parseStartPayload = (payload: string): { type: "event"; eventId: number } | null => {
  const match = /^evt_([1-9]\d*)$/.exec(payload);
  if (!match) return null;
  const eventId = Number(match[1]);
  return Number.isSafeInteger(eventId) ? { type: "event", eventId } : null;
};

export const miniAppEventLink = (botUsername: string, appName: string, eventId: number): string =>
  `https://t.me/${botUsername}/${appName}?startapp=${eventStartappPayload(eventId)}`;

// export const botEventLink = (botUsername: string, eventId: number): string =>
//   `https://t.me/${botUsername}?start=${eventStartappPayload(eventId)}`;

export const botEventLink = (botUsername: string, eventId: number): string =>
  `tg://resolve?domain=${encodeURIComponent(botUsername)}&start=${encodeURIComponent(eventStartappPayload(eventId))}`;
