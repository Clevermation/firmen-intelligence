/**
 * Better Auth Konfiguration
 * Email + Passwort Authentifizierung mit PostgreSQL-Backend.
 * Sessions werden in der DB verwaltet (nicht In-Memory).
 */
import { betterAuth } from "better-auth";
import { Pool } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://firmendb:firmendb_dev_2026@localhost:5435/firmendb";

const PORT = parseInt(process.env.PORT ?? "3100");

const pool = new Pool({ connectionString: DATABASE_URL });

// Better Auth Tabellen beim Start erstellen (idempotent)
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, "emailVerified" BOOLEAN DEFAULT FALSE, image TEXT, "createdAt" TIMESTAMPTZ DEFAULT now(), "updatedAt" TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS "session" (id TEXT PRIMARY KEY, "expiresAt" TIMESTAMPTZ, token TEXT UNIQUE, "createdAt" TIMESTAMPTZ DEFAULT now(), "updatedAt" TIMESTAMPTZ DEFAULT now(), "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT REFERENCES "user"(id));
    CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, "accountId" TEXT, "providerId" TEXT, "userId" TEXT REFERENCES "user"(id), "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" TIMESTAMPTZ, "refreshTokenExpiresAt" TIMESTAMPTZ, password TEXT, "createdAt" TIMESTAMPTZ DEFAULT now(), "updatedAt" TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS "verification" (id TEXT PRIMARY KEY, identifier TEXT, value TEXT, "expiresAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ DEFAULT now(), "updatedAt" TIMESTAMPTZ DEFAULT now());
  `);
  console.log("Auth: DB-Tabellen OK");
} catch (e) {
  console.warn("Auth: DB-Tabellen-Erstellung fehlgeschlagen:", (e as Error).message);
}

export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BASE_URL ?? `http://localhost:${PORT}`,

  // Basis-Pfad für Auth-Routen (Standard: /api/auth)
  basePath: "/api/auth",

  // Vertrauenswürdige Origins (CORS)
  trustedOrigins: [
    "http://localhost:3100",
    "http://localhost:3000",
    "https://intelligence.clevermationgroup.com",
  ],

  // Email + Passwort aktivieren
  emailAndPassword: {
    enabled: true,
    // Mindest-Passwortlänge
    minPasswordLength: 8,
    // Nach Registrierung automatisch einloggen
    autoSignIn: true,
  },

  // Session-Konfiguration
  session: {
    // Session-Dauer: 7 Tage
    expiresIn: 60 * 60 * 24 * 7,
    // Automatisch verlängern wenn weniger als 1 Tag übrig
    updateAge: 60 * 60 * 24,
    // Cookie-Name
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 Minuten Cookie-Cache
    },
  },
});

/**
 * Erstellt den Standard-Admin-Benutzer falls noch nicht vorhanden.
 * Wird beim Server-Start aufgerufen.
 */
export async function seedDefaultUser() {
  const defaultEmail =
    process.env.ADMIN_EMAIL ?? "developer@clevermation.com";
  const defaultPw =
    process.env.ADMIN_PASSWORD ?? "4!HyUHytvjtqM2YLeqRp";

  try {
    // Prüfen ob Benutzer bereits existiert
    const existing = await auth.api.signInEmail({
      body: { email: defaultEmail, password: defaultPw },
    }).catch(() => null);

    if (existing?.user) {
      console.log(`Auth: Benutzer ${defaultEmail} existiert bereits`);
      return;
    }
  } catch {
    // Benutzer existiert nicht → anlegen
  }

  try {
    await auth.api.signUpEmail({
      body: {
        email: defaultEmail,
        password: defaultPw,
        name: "Developer",
      },
    });
    console.log(`Auth: Benutzer ${defaultEmail} angelegt`);
  } catch (e) {
    // Fehler beim Anlegen (z.B. bereits vorhanden — USER_ALREADY_EXISTS)
    const msg = (e as Error).message ?? String(e);
    if (msg.includes("already") || msg.includes("exist")) {
      console.log(`Auth: Benutzer ${defaultEmail} existiert bereits`);
    } else {
      console.warn(`Auth: Fehler beim Anlegen des Standard-Benutzers: ${msg}`);
    }
  }
}

export type AuthType = typeof auth;
