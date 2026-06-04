/** Plaintext-credential auth gate.
 *
 * - Username and password live in env vars (AUTH_USERNAME / AUTH_PASSWORD).
 * - On success we set an httpOnly cookie that holds nothing more than a 1.
 *   That cookie is what middleware checks. The actual secret never leaves
 *   the server.
 * - Intentionally lightweight — purely meant to keep random Vercel
 *   visitors from burning the API keys.
 */
export const AUTH_COOKIE = "producer_auth";
export const AUTH_COOKIE_VALUE = "1";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function getServerCreds() {
  const username = process.env.AUTH_USERNAME ?? "";
  const password = process.env.AUTH_PASSWORD ?? "";
  return { username, password };
}

export function credsMatch(input: { username: string; password: string }): boolean {
  const { username, password } = getServerCreds();
  if (!username || !password) return false;
  return input.username === username && input.password === password;
}
