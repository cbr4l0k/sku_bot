import { webhookHandler } from "gramio";
import { DEFAULT_CITY } from "@sku/cities";
import { chats, migrate } from "@sku/db";
import { app } from "./api";
import { bot } from "./bot";
import { refreshChatStates } from "./bot/membership";
import { syncConfiguredAdmins } from "./core/admins";
import { seedChatsFromEnv } from "./core/chats";
import { db } from "./db";
import { loadEnv } from "./env";
import { startSweeper } from "./sweeper";

const env = loadEnv();
const isProduction = env.NODE_ENV === "production";

migrate(db);
syncConfiguredAdmins(db, env.ADMIN_IDS);

// The chat catalog moved out of the environment and into the database. Anything
// still listed is lifted in under the branch that has been running everything so
// far, so no deploy has to be sequenced against the change; delete the variable
// once the rows exist.
const seeded = seedChatsFromEnv(db, env.EVENT_GROUPS, DEFAULT_CITY, new Date());
if (seeded > 0) {
  console.warn(`[chat] filed ${seeded} chat(s) from EVENT_GROUPS under "${DEFAULT_CITY}". EVENT_GROUPS is deprecated — manage chats in the admin screen and drop the variable.`);
}

if (isProduction) {
  app.post("/webhook", webhookHandler(bot, "elysia", env.WEBHOOK_SECRET));
}

const server = app.listen(3000);
const stopSweeper = startSweeper(db);

if (isProduction) {
  await bot.start({
    webhook: {
      url: `https://${env.DOMAIN}/webhook`,
      secret_token: env.WEBHOOK_SECRET,
    },
  });
} else {
  await bot.start();
}

// Warm the chat titles so the admin UI names them instead of showing raw ids, and
// surface an unreachable chat in the log at boot rather than at first use.
void refreshChatStates(db.select({ id: chats.id }).from(chats).all().map((chat) => chat.id)).catch(console.error);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down.`);
  stopSweeper();
  await server.stop();
  await bot.stop();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
