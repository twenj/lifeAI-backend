import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().positive().default(8787),
  OPENROUTER_API_URL: z.string().url(),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_MODEL: z.string().min(1),
  OPENROUTER_SITE_URL: z.string().url(),
  OPENROUTER_APP_NAME: z.string().min(1),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BODY_LIMIT_MB: z.coerce.number().positive().max(50).default(20),
})

export const config = envSchema.parse(process.env)
