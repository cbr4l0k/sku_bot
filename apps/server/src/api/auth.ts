import { getBotTokenSecretKey, validateAndParseInitData } from "@gramio/init-data";
import { Effect } from "effect";
import { Elysia, t } from "elysia";

import { eq, users } from "@sku/db";
import { loadActor } from "../core/cities";
import { loadEnv } from "../env";
import { runtime } from "../runtime";
import { Database } from "../services";
import { localeFromLanguageCode } from "../bot/i18n";

const env = loadEnv();
const secretKey = getBotTokenSecretKey(env.BOT_TOKEN);

export const auth = new Elysia({ name: "auth" })
  .guard({
    headers: t.Object({ "x-init-data": t.String() }),
    response: { 401: t.Object({ error: t.String() }) },
  })
  // Elysia resolves synchronously here, so the sign-in runs to completion on the spot.
  .resolve(({ headers, status }) => runtime.runSync(Effect.gen(function* () {
    const result = validateAndParseInitData(headers["x-init-data"], secretKey);
    if (!result || !result.user) return status(401, { error: "unauthorized" });
    // A valid HMAC alone is replayable forever — bound the credential lifetime.
    const ageSeconds = Math.floor(Date.now() / 1000) - result.auth_date;
    if (ageSeconds > 60 * 60 * 24) return status(401, { error: "unauthorized" });

    const telegramUser = result.user;
    const db = yield* Database;
    const isConfiguredAdmin = env.ADMIN_IDS.includes(telegramUser.id);
    db.insert(users)
      .values({
        id: telegramUser.id,
        firstName: telegramUser.first_name,
        lastName: telegramUser.last_name,
        username: telegramUser.username,
        locale: localeFromLanguageCode(telegramUser.language_code),
        isAdmin: isConfiguredAdmin,
      })
      .onConflictDoNothing()
      .run();

    const user = db.select().from(users).where(eq(users.id, telegramUser.id)).get();
    if (!user) return status(401, { error: "unauthorized" });

    const isAdmin = user.isAdmin || isConfiguredAdmin;
    // Resolved once here so handlers can answer "may they?" without another query.
    return { user, isAdmin, actor: yield* loadActor(user.id, isAdmin) };
  })))
  .as("scoped");
