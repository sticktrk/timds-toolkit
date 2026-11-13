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
};

export function providerDelivery(env: ContactEnv, origin: string) {
  try {
    const site = new URL(env.EMDASH_SITE_URL ?? "");
    return !import.meta.env.DEV && env.TIMDS_SITE_STAGING !== "1"
      && site.protocol === "https:" && site.origin === origin && !site.username && !site.password;
  } catch {
    return false;
  }
}

export function migrateContact(env: ContactEnv) {
  return env.DB.batch(migration.split(";").filter((sql) => sql.trim()).map((sql) => env.DB.prepare(sql)));
}

export const contactDelivery = (env: ContactEnv, origin: string) =>
  providerDelivery(env, origin) ? contact.delivery : "test";
