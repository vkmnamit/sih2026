/**
 * Authentication & role types for the Eklavya platform.
 *
 * Three roles are supported:
 *   - admin    : full platform management
 *   - trainer  : creates/manages content, views trainee progress
 *   - trainee  : consumes content, takes assessments
 *
 * The role is stored in the user's `user_metadata` record in Supabase Auth,
 * and mirrored into the `profiles` table for fast lookups.
 */

export type UserRole = 'admin' | 'trainer' | 'trainee';

export const USER_ROLES: readonly UserRole[] = ['admin', 'trainer', 'trainee'] as const;

/** Shape of the `profiles` table row. */
export interface Profile {
  id: string;            // uuid, matches auth.users.id
  email: string;
  role: UserRole;
  name?: string;
  created_at: string;
  updated_at: string;
}

/** Decoded JWT payload (subset we care about). */
export interface AuthTokenPayload {
  sub: string;           // user id
  email?: string;
  role?: string;         // app_role
  user_metadata?: Record<string, unknown>;
  exp: number;
  iat: number;
}

/** Response shape for login/signup endpoints. */
export interface AuthResponse {
  access_token: string;
  refresh_token?: string;
  token_type: 'bearer';
  expires_in?: number;
  user: {
    id: string;
    email: string;
    role: UserRole;
    name?: string;
  };
}

/** Request body for signup. */
export interface SignupBody {
  email: string;
  password: string;
  role: UserRole;
  name?: string;
}

/** Request body for login. */
export interface LoginBody {
  email: string;
  password: string;
}
