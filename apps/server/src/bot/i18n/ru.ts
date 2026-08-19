import { blockquote, bold, code, format, join, link } from "gramio";
import type { ShouldFollowLanguage } from "@gramio/i18n";
import type { en } from "./en";
import type { EventUpdatedFields } from "../event-card";

export const ru = {
  welcome: "Добро пожаловать в клуб бега! Подготовим всё для ближайшего старта.",
  contactPrompt: "Поделитесь номером телефона, чтобы мы сохранили вашу регистрацию и присылали важные обновления.",
  contactButton: "📱 Поделиться контактом",
  contactSaved: "Готово — контакт сохранён.",
  contactRejected: "Пожалуйста, поделитесь своим контактом кнопкой ниже.",
  hero: () => format`${bold("🏃 Клуб бега")}

${blockquote("Пробежки, тренировки и хорошая компания — всё в одном месте.")}`,
  openApp: "🏃 Открыть приложение",
  openEvent: "Открыть событие",
  eventCity: (city: string) => `🏙 ${city}`,
  eventDate: (date: string) => `📅 ${date}`,
  eventLocation: (location: string, locationUrl: string | null) => format`📍 ${locationUrl ? link(location, locationUrl) : location}`,
  spotsLeft: (count: number) => `Осталось мест: ${count}`,
  eventUnavailable: "Это событие больше недоступно.",
  unknownPayload: "Не удалось распознать ссылку, но вы в нужном месте.",
  error: "Что-то пошло не так. Попробуйте ещё раз.",
  offer: (title: string, date: string) => format`${bold("Место освободилось!")}

${bold(title)}
${date}

У вас есть 20 минут, чтобы принять приглашение.`,
  offerAccept: "Принять",
  offerAccepted: (title: string, date: string) => format`${bold("✅ Вы в списке участников!")}

${bold(title)}
${date}`,
  offerSpotTaken: "Это место уже занято. Посмотрите другие события в приложении.",
  bannedNotice: "Ваш доступ к записи на события ограничен. Свяжитесь с организаторами клуба.",
  offerSuperseded: "Это место уже недоступно.",
  eventCanceled: (title: string) => format`${bold("Событие отменено")}

${title}

Надеемся увидеться на другой пробежке!`,
  eventUpdated: (title: string, changes: EventUpdatedFields) => format`${bold("Событие обновлено")}

${bold(title)}

${join([
    changes.title === undefined ? null : format`• Новое название: ${changes.title}`,
    changes.description === undefined ? null : format`• Обновили описание`,
    changes.startsAt === undefined ? null : format`• Новая дата: ${changes.startsAt}`,
    changes.location === undefined ? null : format`• Новое место: ${changes.location}`,
    changes.capacity === undefined ? null : format`• Лимит участников: ${changes.capacity === null ? "без ограничений" : changes.capacity}`,
  ].filter((change): change is ReturnType<typeof format> => change !== null), (change) => change, "\n")}`,
  joinButton: "✅ Записаться",
  joinQueueButton: "⏳ Встать в очередь",
  noSpotsLeft: "Мест больше нет.",
  cardRegistered: "Ты записан.",
  cardWaitlisted: (position: number) => `Ты в очереди №${position}.`,
  cardCheckedIn: "Ты отмечен.",
  joinedNotice: "Готово — ты записан!",
  queuedNotice: (position: number) => `Ты в очереди №${position}. Напишем, как только освободится место.`,
  alreadyJoinedNotice: "Ты уже записан на это событие.",
  notEligibleNotice: "Событие только для участников определённых Telegram-групп.",
  chatInvite: (title: string) => format`${bold("Добро пожаловать в чат события")}

${title}

${blockquote("Ссылка одноразовая и только для тебя. Придёшь на тренировку и отметишься — останешься в чате. Если не придёшь, мы тихо уберём тебя после события.")}`,
  chatInviteButton: "💬 Войти в чат",
  commandStart: "Главное меню",
  commandChatId: "Показать ID этой группы",
  chatId: (chatId: number) => format`ID этого чата — ${code(String(chatId))}

Чат уже в каталоге — выберите его филиал в «Админ → Чаты», и события этого города смогут его использовать.`,
  chatIdOnlyInGroups: "Отправьте эту команду в самой группе, ID которой нужен.",
} satisfies ShouldFollowLanguage<typeof en>;
