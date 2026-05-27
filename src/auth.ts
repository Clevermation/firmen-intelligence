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

export const auth = betterAuth({
  // PostgreSQL-Verbindung über pg Pool
  database: new Pool({
    connectionString: DATABASE_URL,
  }),

  // Base-URL für Callbacks und Redirects
  baseURL: `http://localhost:${PORT}`,

  // Basis-Pfad für Auth-Routen (Standard: /api/auth)
  basePath: "/api/auth",

  // Vertrauenswürdige Origins (CORS)
  trustedOrigins: [
    "http://localhost:3100",
    "http://localhost:3000",
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
