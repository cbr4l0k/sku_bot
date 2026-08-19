import { z } from "zod";

/** A comma-separated list of Telegram user ids, e.g. "5622866164,112814433". */
const adminIds = z.string().transform((raw, ctx): readonly number[] => {
  const segments = raw.split(",").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (!/^[1-9][0-9]*$/.test(segment)) ctx.addIssue({ code: "custom", message: `"${segment}" is not a Telegram user id` });
  }
  if (segments.length === 0) ctx.addIssue({ code: "custom", message: "must list at least one Telegram user id" });
  return segments.map(Number);
});

/**
 * DEPRECATED. The chat catalog lives in the `chats` table now — the bot files a
 * chat when it is added to one, and a general admin says which branch it belongs
 * to. Anything still listed here is lifted into the table at boot and filed under
 * the default branch; once that has happened the variable can be deleted.
 *
 * A comma-separated list of Telegram chat ids, e.g. "-1001234567890,-100987654321".
 */
const chatIds = z.string().default("").transform((raw, ctx): readonly number[] => {
  const segments = raw.split(",").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (!/^-?[1-9][0-9]*$/.test(segment)) ctx.addIssue({ code: "custom", message: `"${segment}" is not a Telegram chat id` });
  }
  return [...new Set(segments.map(Number))];
});

const environmentSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DOMAIN: z.string().min(1),
  ADMIN_IDS: adminIds,
  EVENT_GROUPS: chatIds,
  WEBHOOK_SECRET: z.string().min(1),
  CHECKIN_SECRET: z.string().min(1),
  DATABASE_PATH: z.string().min(1).default("./data/sku.db"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof environmentSchema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment: ${fields}. Check .env.example.`);
  }

  return result.data;
};
