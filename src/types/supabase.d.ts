/**
 * Ambient type declarations for @supabase/supabase-js.
 *
 * The package is an OPTIONAL runtime dependency — it is loaded lazily via a
 * dynamic `import()` ONLY when supabase_* env vars are present (see
 * config.supabase.enabled). These declarations let TypeScript compile whether
 * or not `@supabase/supabase-js` is installed. Install it with:
 *
 *   npm install @supabase/supabase-js
 *
 * Run `npm run build` after installing so the real types replace this stub.
 */
declare module '@supabase/supabase-js' {
  export interface PostgrestError {
    message: string;
    code?: string;
    details?: string;
    hint?: string;
  }

  export interface PostgrestResult<T = unknown> {
    data: T | null;
    error: PostgrestError | null;
  }

  /**
   * Chainable builder — sync methods return the builder for chaining,
   * terminal methods return a Promise of a PostgrestResult.
   */
  export interface PostgrestBuilder {
    eq(column: string, value: unknown): PostgrestBuilder;
    match(criteria: Record<string, unknown>): PostgrestBuilder;
    order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): PostgrestBuilder;
    select(columns?: string, opts?: { count?: 'exact'; head?: boolean }): Promise<PostgrestResult<unknown>>;
    upsert(rows: unknown[], opts?: { onConflict?: string; defaultToNull?: boolean }): Promise<PostgrestResult<unknown>>;
    insert(rows: unknown[], opts?: { defaultToNull?: boolean }): Promise<PostgrestResult<unknown>>;
    delete(): { eq(column: string, value: unknown): Promise<PostgrestResult<{ success: boolean }>> };
    single(): Promise<PostgrestResult<unknown>>;
  }

  export interface SupabaseClient {
    from(table: string): PostgrestBuilder;
    rpc(functionName: string, args?: Record<string, unknown>): Promise<PostgrestResult<unknown>>;
    auth: SupabaseAuthClient;
  }

  /** Minimal Auth surface used by the auth service. */
  export interface SupabaseAuthClient {
    signUp(args: { email: string; password: string; options?: { data?: Record<string, unknown> } }): Promise<AuthResult>;
    signInWithPassword(args: { email: string; password: string }): Promise<AuthResult>;
    getUser(jwt: string): Promise<{ data: { user: AuthUser | null }; error: AuthError | null }>;
    refreshSession(args: { refresh_token: string }): Promise<AuthResult>;
    signOut(): Promise<{ error: AuthError | null }>;
  }

  export interface AuthUser {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  }

  export interface AuthSession {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  }

  export interface AuthResult {
    data: { user: AuthUser | null; session: AuthSession | null };
    error: AuthError | null;
  }

  export interface AuthError {
    message: string;
    status?: number;
  }

  export interface SupabaseClientOptions {
    accessToken?: () => string | undefined;
    fetch?: unknown;
    [key: string]: unknown;
  }

  export function createClient(
    supabaseUrl: string,
    supabaseKey: string,
    options?: SupabaseClientOptions
  ): SupabaseClient;
}
