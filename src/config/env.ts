/**
 * Environment configuration — centralised, validated access to env vars.
 *
 * Bun reads .env files automatically. See `.env.example` for required keys.
 */

function env(name: string): string;
function env(name: string, fallback: string): string;
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  rocketride: {
    apiUrl: env("ROCKETRIDE_API_URL", "http://localhost:5565"),
    apiKey: env("ROCKETRIDE_API_KEY", ""),
  },

  spectrum: {
    projectId: env("SPECTRUM_PROJECT_ID"),
    projectSecret: env("SPECTRUM_PROJECT_SECRET"),
  },

  xtrace: {
    apiKey: env("XTRACE_API_KEY"),
    orgId: env("XTRACE_ORG_ID"),
  },

  butterbase: {
    apiUrl: env("BUTTERBASE_API_URL", "https://api.butterbase.ai"),
    appId: env("BUTTERBASE_APP_ID"),
    anonKey: env("BUTTERBASE_ANON_KEY", ""),
    authEmail: env("BUTTERBASE_AUTH_EMAIL", ""),
    authPassword: env("BUTTERBASE_AUTH_PASSWORD", ""),
  },
} as const;

export type Config = typeof config;
