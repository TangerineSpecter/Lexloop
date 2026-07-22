export type UserRole = 'USER' | 'ADMIN';

export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
  displayName: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
