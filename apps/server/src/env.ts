import { z } from "zod";

const environmentSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  DOMAIN: z.string().min(1),
  ADMIN_IDS: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  CHECKIN_SECRET: z.string().min(1),
  DATABASE_PATH: z.string().min(1).default("./data/sku.db"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof environmentSchema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${fields}. Check .env.example.`);
  }

  return result.data;
};
