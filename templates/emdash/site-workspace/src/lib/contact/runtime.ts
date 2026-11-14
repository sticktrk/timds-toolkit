import { contact } from "./config";
import migration from "../../../migrations/0001_timds_contact.sql?raw";

export type ContactEnv = {
  DB: D1Database;
  EMDASH_SITE_URL?: string;
  EMDASH_MIGRATIONS_MODE?: string;
  TIMDS_SITE_STAGING?: string;
  RESEND_API_KEY?: string;
  META_CAPI_ACCESS_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
  TIMDS_CONTACT_WEBHOOK_URL?: string;
  TIMDS_CONTACT_WEBHOOK_HEADER?: string;
  TIMDS_CONTACT_WEBHOOK_SECRET?: string;
};

export function publicContactOrigin(env: ContactEnv) {
  try {
    const site = new URL(env.EMDASH_SITE_URL ?? "");
    return site.protocol === "https:" && !site.username && !site.password ? site.origin : null;
  } catch {
    return null;
  }
}

export function providerDelivery(env: ContactEnv, origin: string) {
  return !import.meta.env.DEV && env.TIMDS_SITE_STAGING !== "1" && publicContactOrigin(env) === origin;
}

export function migrateContact(env: ContactEnv) {
  return env.DB.batch(migration.split(";").filter((sql) => sql.trim()).map((sql) => env.DB.prepare(sql)));
}

export const contactDelivery = (env: ContactEnv, origin: string) =>
  providerDelivery(env, origin) ? contact.delivery : "test";
