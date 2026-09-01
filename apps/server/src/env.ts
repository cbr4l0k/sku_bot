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

const optionalSecret = z.string().trim().min(1).optional().or(z.literal("").transform(() => undefined));

const environmentSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DOMAIN: z.string().min(1),
  ADMIN_IDS: adminIds,
  EVENT_GROUPS: chatIds,
  WEBHOOK_SECRET: z.string().min(1),
  CHECKIN_SECRET: z.string().min(1),
  YOOKASSA_SHOP_ID: optionalSecret,
  YOOKASSA_SECRET_KEY: optionalSecret,
  YOOKASSA_WEBHOOK_SECRET: optionalSecret,
  YOOKASSA_VAT_CODE: z.coerce.number().int().min(1).max(10).optional().or(z.literal("").transform(() => undefined)),
  DATABASE_PATH: z.string().min(1).default("./data/sku.db"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
}).superRefine((env, ctx) => {
  if (Boolean(env.YOOKASSA_SHOP_ID) !== Boolean(env.YOOKASSA_SECRET_KEY)) {
    ctx.addIssue({
      code: "custom",
      path: [env.YOOKASSA_SHOP_ID ? "YOOKASSA_SECRET_KEY" : "YOOKASSA_SHOP_ID"],
      message: "must be configured together with the other YooKassa credential",
    });
  }
  if (env.YOOKASSA_SHOP_ID && !env.YOOKASSA_WEBHOOK_SECRET) {
    ctx.addIssue({ code: "custom", path: ["YOOKASSA_WEBHOOK_SECRET"], message: "is required when YooKassa is configured" });
  }
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
