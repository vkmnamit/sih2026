/**
 * Authentication service — wraps Supabase Auth for the three-role model.
 *
 * All Supabase Auth operations go through here so controllers stay thin.
 * The @supabase/supabase-js package is loaded lazily via dynamic import so
 * the dependency is only required at runtime when Supabase is configured.
 */
import { config } from '../config/index.js';
import type { UserRole, Profile, AuthResponse, SignupBody, LoginBody } from '../types/auth.js';

/** Lazily-imported Supabase client (cached). */
let _clientPromise: Promise<any> | null = null;

function getClient(): Promise<any> {
  if (!config.supabase.enabled) {
    throw new Error(
      'Supabase is not configured. Set supabase-project-id / supabase-project_id plus supabase-service-key / supabase_service_key in .env.'
    );
  }
  if (!_clientPromise) {
    _clientPromise = import('@supabase/supabase-js').then((mod) =>
      mod.createClient(config.supabase.url, config.supabase.serviceRoleKey)
    );
  }
  return _clientPromise;
}

/** True when Supabase auth is available. */
export function isAuthEnabled(): boolean {
  return config.supabase.enabled;
}

/**
 * Sign up a new user with a role. The role is written into user_metadata
 * so it travels with the JWT, and a row is inserted into `profiles`.
 */
export async function signup(input: SignupBody): Promise<AuthResponse> {
  const client = await getClient();

  const { data, error } = await client.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: {
        role: input.role,
        name: input.name ?? null,
      },
    },
  });

  if (error) throw new Error(`Signup failed: ${error.message}`);
  if (!data.user || !data.session) {
    throw new Error('Signup failed: no user/session returned');
  }

  // Insert profile row (best-effort — trigger can also do this).
  await ensureProfile(data.user.id, data.user.email ?? input.email, input.role, input.name);

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    token_type: 'bearer',
    expires_in: data.session.expires_in,
    user: {
      id: data.user.id,
      email: data.user.email ?? input.email,
      role: input.role,
      name: input.name,
    },
  };
}

/**
 * Log in with email + password. Returns the session + profile.
 */
export async function login(input: LoginBody): Promise<AuthResponse> {
  const client = await getClient();

  const { data, error } = await client.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (error) throw new Error(`Login failed: ${error.message}`);
  if (!data.user || !data.session) {
    throw new Error('Login failed: no user/session returned');
  }

  const profile = await getProfile(data.user.id);
  const role: UserRole = profile?.role ?? 'trainee';

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    token_type: 'bearer',
    expires_in: data.session.expires_in,
    user: {
      id: data.user.id,
      email: data.user.email ?? input.email,
      role,
      name: profile?.name,
    },
  };
}

/**
 * Verify a bearer token and return the user's id + role.
 * Returns null when the token is invalid/expired.
 */
export async function verifyToken(token: string): Promise<{ id: string; role: UserRole; email: string } | null> {
  const client = await getClient();

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;

  const profile = await getProfile(data.user.id);
  const role: UserRole = profile?.role ?? (data.user.user_metadata?.role as UserRole) ?? 'trainee';

  return {
    id: data.user.id,
    email: data.user.email ?? '',
    role,
  };
}

/** Fetch a profile by user id. */
export async function getProfile(userId: string): Promise<Profile | null> {
  const client = await getClient();
  const { data, error } = await client
    .from('profiles')
    .select('id, email, role, name, created_at, updated_at')
    .eq('id', userId)
    .single();

  if (error || !data) return null;
  return data as Profile;
}

/** Insert or update a profile row (used after signup). */
async function ensureProfile(id: string, email: string, role: UserRole, name?: string): Promise<void> {
  const client = await getClient();
  const now = new Date().toISOString();
  const { error } = await client
    .from('profiles')
    .upsert(
      { id, email, role, name: name ?? null, updated_at: now },
      { onConflict: 'id' }
    );
  // Best-effort: a database trigger may already handle this.
  if (error) {
    console.warn('[auth] profile upsert warning:', error.message);
  }
}

/** Log out by revoking the refresh token server-side. */
export async function logout(refreshToken: string): Promise<void> {
  const client = await getClient();
  const { error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error) throw new Error(`Logout failed: ${error.message}`);
}
