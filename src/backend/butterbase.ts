/**
 * Butterbase — Backend-as-a-Service Integration
 *
 * Covers the three mandatory integration points:
 *   ─ Database   (client.from().insert/select/update/delete)
 *   ─ Auth       (client.auth.signIn / signUp)
 *   ─ AI Gateway (client.ai.chat / chatStream / embed)
 *
 * Docs: https://github.com/butterbase-ai/butterbase
 * SDK: @butterbase/sdk on npm
 */
import { createClient } from "@butterbase/sdk";
import type {
  ButterbaseClient,
  SignInParams,
  SignUpParams,
  ChatMessage,
  ChatOptions,
  ChatCompletion,
} from "@butterbase/sdk";
import { config } from "../config/env.ts";

/** A search session persisted in Butterbase DB. */
export interface SearchSession {
  id?: string;
  user_id: string;
  query_text: string;
  image_refs?: string;
  category?: string;
  reply_text?: string;
  source_count?: number;
  created_at?: string;
}

/** A cached page result in Butterbase DB. */
export interface CachedPage {
  url: string;
  title?: string;
  snippet?: string;
  category?: string;
  content?: string;
  cached_at?: string;
}

export class BackendService {
  private client!: ButterbaseClient;
  private _authenticated = false;

  /**
   * Initialise the Butterbase client.
   * Call `authenticate()` separately to sign in.
   */
  constructor() {
    this.client = createClient({
      appId: config.butterbase.appId,
      apiUrl: config.butterbase.apiUrl,
      anonKey: config.butterbase.anonKey || undefined,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  AUTH
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Sign in with email + password.
   * Call once at startup. The client stores the session internally.
   */
  async signIn(params: SignInParams): Promise<void> {
    const { error } = await this.client.auth.signIn(params);
    if (error) throw error;
    this._authenticated = true;
    console.log(`[Butterbase] Authenticated as ${params.email}`);
  }

  /**
   * Sign up a new user (email verification required by default).
   */
  async signUp(params: SignUpParams): Promise<void> {
    const { error } = await this.client.auth.signUp(params);
    if (error) throw error;
    console.log(`[Butterbase] Signed up ${params.email} — verify email before sign-in`);
  }

  /**
   * Sign out the current session.
   */
  async signOut(): Promise<void> {
    await this.client.auth.signOut();
    this._authenticated = false;
  }

  /** Whether the client has an active auth session. */
  get isAuthenticated(): boolean {
    return this._authenticated;
  }

  /** Access the raw auth client for advanced use. */
  get auth() {
    return this.client.auth;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  DATABASE (typed queries via QueryBuilder)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Insert a search session record.
   * Returns the inserted record with its generated id.
   */
  async insertSession(session: SearchSession): Promise<SearchSession | null> {
    const { data, error } = await this.client
      .from<SearchSession>("search_sessions")
      .insert(session)
      .execute();

    if (error) {
      console.error("[Butterbase] insertSession error:", error);
      return null;
    }
    return (Array.isArray(data) ? data[0] : data) ?? null;
  }

  /**
   * Get search sessions for a user, most recent first.
   */
  async getSessions(userId: string, limit = 10): Promise<SearchSession[]> {
    const { data, error } = await this.client
      .from<SearchSession>("search_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit)
      .execute();

    if (error) {
      console.error("[Butterbase] getSessions error:", error);
      return [];
    }
    return data ?? [];
  }

  /**
   * Cache a scraped page to avoid re-scraping.
   */
  async cachePage(page: CachedPage): Promise<void> {
    const { error } = await this.client
      .from<CachedPage>("page_cache")
      .insert(page)
      .execute();

    if (error) {
      console.error("[Butterbase] cachePage error:", error);
    }
  }

  /**
   * Look up a cached page by URL.
   */
  async getCachedPage(url: string): Promise<CachedPage | null> {
    const { data, error } = await this.client
      .from<CachedPage>("page_cache")
      .select("*")
      .eq("url", url)
      .maybeSingle()
      .execute();

    if (error) {
      console.error("[Butterbase] getCachedPage error:", error);
      return null;
    }
    return data ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  AI MODEL GATEWAY
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Classify a piece of text into a category using the AI gateway.
   *
   * Categories: food, travel, tech, shopping, news, other
   */
  async classifyText(text: string): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a classifier. Categorize the user's query into exactly " +
          "one of: food, travel, tech, shopping, news, other. " +
          "Respond with only the category word, nothing else.",
      },
      { role: "user", content: text },
    ];

    const { data, error } = await this.client.ai.chat(messages, {
      model: "gpt-4o-mini",
      temperature: 0,
      maxTokens: 10,
    });

    if (error || !data) {
      console.error("[Butterbase] classifyText error:", error);
      return "other";
    }

    const label = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "other";
    return ["food", "travel", "tech", "shopping", "news"].includes(label) ? label : "other";
  }

  /**
   * Summarize text using the AI gateway.
   */
  async summarize(text: string, maxSentences = 3): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `Summarize the following text in at most ${maxSentences} sentences. Be concise.`,
      },
      { role: "user", content: text.slice(0, 8000) },
    ];

    const { data, error } = await this.client.ai.chat(messages, {
      model: "gpt-4o-mini",
      temperature: 0.3,
      maxTokens: 300,
    });

    if (error || !data) {
      console.error("[Butterbase] summarize error:", error);
      return text.slice(0, 500);
    }

    return data.choices?.[0]?.message?.content ?? text.slice(0, 500);
  }

  /**
   * Low-level access for arbitrary AI gateway calls.
   */
  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<ChatCompletion | null> {
    const { data, error } = await this.client.ai.chat(messages, options);
    if (error) {
      console.error("[Butterbase] ai.chat error:", error);
      return null;
    }
    return data;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  UTILITY
  // ═══════════════════════════════════════════════════════════════════

  /** Access the underlying client directly. */
  getClient(): ButterbaseClient {
    return this.client;
  }

  /** Check connectivity by fetching the user profile. */
  async health(): Promise<boolean> {
    try {
      const { error } = await this.client.auth.getUser();
      return !error;
    } catch {
      return false;
    }
  }
}
