import { webhookHandler } from "gramio";
import { migrate } from "@sku/db";
import { app } from "./api";
import { bot } from "./bot";
import { refreshChatStates } from "./bot/membership";
import { syncConfiguredAdmins } from "./core/admins";
import { db } from "./db";
import { loadEnv } from "./env";
import { startSweeper } from "./sweeper";

const env = loadEnv();
const isProduction = env.NODE_ENV === "production";

migrate(db);
syncConfiguredAdmins(db, env.ADMIN_IDS);

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

// Warm the restricted-chat titles so the admin UI names them instead of showing raw ids,
// and surface a misconfigured EVENT_GROUPS in the log at boot rather than at first use.
void refreshChatStates(env.EVENT_GROUPS).catch(console.error);

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
