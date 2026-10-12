import { blockquote, bold, code, format, join, link } from "gramio";
import type { ShouldFollowLanguage } from "@gramio/i18n";
import type { en } from "./en";
import type { EventUpdatedFields } from "../event-card";
import { clubEmoji } from "../club-emoji";

export const ru = {
  welcome: "Добро пожаловать в клуб бега! Подготовим всё для ближайшего старта.",
  contactPrompt: "Поделитесь номером телефона, чтобы мы сохранили вашу регистрацию и присылали важные обновления.",
  contactButton: "📱 Поделиться контактом",
  contactSaved: "Готово — контакт сохранён.",
  contactRejected: "Пожалуйста, поделитесь своим контактом кнопкой ниже.",
  hero: () => format`${clubEmoji()} ${bold("Skuratov Running Club")}

${blockquote("Записывайтесь на пробежки и тренировки, выбирайте билеты и следите за своими регистрациями.")}`,
  openApp: "Открыть приложение",
  openEvent: "Открыть событие",
  chooseTicket: "Выбрать билет",
  ticketOption: (name: string, price: string) => `🎟 ${name} · ${price}`,
  shopMerch: "🛍 Мерч и дополнения",
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
  offerBroadcast: (title: string, date: string) => format`${bold("Место освободилось!")}

${bold(title)}
${date}

Событие скоро начнётся, поэтому мы написали всем в очереди. Место получит тот, кто примет приглашение первым.`,
  offerAccept: "Принять",
  offerDecline: "Отказаться",
  offerDeclineConfirm: "Да, отдать место и выйти из очереди",
  offerDeclineKeep: "Оставить приглашение",
  offerDeclined: "Готово — место перейдёт следующему в очереди, а вы вышли из очереди.",
  offerAccepted: (title: string, date: string) => format`${bold("✅ Вы в списке участников!")}

${bold(title)}
${date}`,
  offerSpotTaken: "Это место уже занято. Посмотрите другие события в приложении.",
  bannedNotice: "Ваш доступ к записи на события ограничен. Свяжитесь с организаторами клуба.",
  offerSuperseded: "Это место уже недоступно.",
  eventCanceled: (title: string) => format`${bold("Событие отменено")}

${title}

Надеемся увидеться на другой пробежке!`,
  ticketPaid: (title: string) => format`${bold("Оплата подтверждена")}

Билет на ${bold(title)} готов. Вы в списке участников.`,
  ticketRefunded: (title: string) => format`${bold("Возврат подтверждён")}

Билет на ${bold(title)} отменён, ЮKassa подтвердила возврат.`,
  ticketRefundFailed: (title: string) => format`${bold("Возврат требует внимания")}

ЮKassa не смогла вернуть оплату за ${bold(title)}. Место пока сохранено — свяжитесь с клубом.`,
  purchasePaid: (title: string) => format`${bold("Оплата подтверждена")}

Покупка для события ${bold(title)} подтверждена. Она не меняет запись на событие.`,
  purchaseRefunded: (title: string) => format`${bold("Возврат подтверждён")}

ЮKassa подтвердила возврат за покупку для события ${bold(title)}.`,
  purchaseRefundFailed: (title: string) => format`${bold("Возврат требует внимания")}

ЮKassa не смогла вернуть оплату за покупку для события ${bold(title)}. Свяжитесь с клубом.`,
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
  cardWaitlisted: "Ты в очереди.",
  cardCheckedIn: "Ты отмечен.",
  leaveButton: "Не смогу прийти",
  leaveQueueButton: "Выйти из очереди",
  leaveConfirm: "Да, освободить место",
  leaveQueueConfirm: "Да, выйти из очереди",
  leaveKeep: "Нет, остаюсь",
  leftNotice: "Ты больше не в списке. Место перейдёт следующему в очереди.",
  leftQueueNotice: "Ты вышел из очереди.",
  runReminder: (title: string, date: string, location: string, locationUrl: string | null) => format`${bold("Скоро увидимся!")}

${bold(title)}
📅 ${date}
📍 ${locationUrl ? link(location, locationUrl) : location}

Не получается прийти? Освободи место — его сможет занять кто-то из очереди.`,
  joinedNotice: "Готово — ты записан!",
  queuedNotice: "Ты в очереди. Напишем, как только освободится место.",
  alreadyJoinedNotice: "Ты уже записан на это событие.",
  notEligibleNotice: "Событие только для участников определённых Telegram-групп.",
  paymentRequiredNotice: "Для этого события нужен билет. Откройте событие и выберите тариф.",
  chatInvite: (title: string) => format`${bold("Добро пожаловать в чат события")}

${title}

${blockquote("Ссылка одноразовая и только для тебя. Придёшь на тренировку и отметишься — останешься в чате. Если не придёшь, мы тихо уберём тебя после события.")}`,
  chatInviteButton: "💬 Войти в чат",
  commandStart: "Главное меню",
  commandChatId: "Показать ID этой группы",
  chatId: (chatId: number) => format`ID этого чата — ${code(String(chatId))}

Чат уже в каталоге — выберите его филиал в «Админ → Чаты», и события этого города смогут его использовать.`,
  draftReview: (title: string, date: string) => format`${bold("Новый забег ждёт проверки")}

${bold(title)}
📅 ${date}

Серия создала этот черновик. Записаться на него нельзя, пока он не опубликован.`,
  draftPublish: "✅ Опубликовать",
  draftSkip: "Пропустить забег",
  draftSkipConfirm: "Да, удалить черновик",
  draftSkipKeep: "Оставить",
  draftOpen: "Открыть черновик",
  draftPublished: (title: string, date: string) => format`${bold("Опубликовано")}

${bold(title)}
📅 ${date}

Теперь на забег можно записаться.`,
  draftSkipped: (title: string) => format`${bold("Пропущено")}

Черновик ${bold(title)} удалён. Серия продолжится со следующей даты.`,
  draftHandled: "Этот черновик уже опубликован или удалён.",
  draftNotAllowed: "Опубликовать или пропустить забег могут только админы филиала. Открыть черновик можно.",
  draftHasOrders: "По этому черновику уже есть оплаты, поэтому из чата его не удалить. Откройте его в приложении.",
  refundFailedAlert: (title: string, runner: string, amount: string, reason: string | null) => format`${bold("Возврат не прошёл")}

${bold(title)}
${runner} · ${amount}${reason ? `\nЮKassa: ${reason}` : ""}

Место участника пока сохранено. Повторите возврат в покупках события.`,
  chatIdOnlyInGroups: "Отправьте эту команду в самой группе, ID которой нужен.",
} satisfies ShouldFollowLanguage<typeof en>;
