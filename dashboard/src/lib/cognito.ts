// Minimal Cognito user-pool client (no Amplify): password sign-in, first-sign-in password change, and
// token refresh, using the public cognito-idp JSON API over HTTPS. Tokens live in sessionStorage, so they
// are gone when the tab closes.

const env = import.meta.env
const REGION: string = env.VITE_AWS_REGION || 'us-east-1'
const CLIENT_ID: string = env.VITE_COGNITO_CLIENT_ID || ''
const STORAGE_KEY = 'rebound.tokens'

export const cognitoConfigured = CLIENT_ID !== ''

export interface Tokens {
  idToken: string
  accessToken: string
  refreshToken?: string
  expiresAt: number // epoch ms
}

export type SignInResult =
  | { kind: 'signedIn'; tokens: Tokens }
  | { kind: 'newPasswordRequired'; session: string }

interface AuthResult {
  IdToken: string
  AccessToken: string
  RefreshToken?: string
  ExpiresIn: number
}

const FRIENDLY: Record<string, string> = {
  NotAuthorizedException: 'Incorrect email or password',
  UserNotFoundException: 'Incorrect email or password',
  PasswordResetRequiredException: 'Your password must be reset; ask a team admin',
  UserNotConfirmedException: 'Your account is not confirmed yet',
  TooManyRequestsException: 'Too many attempts; wait a minute and try again',
  LimitExceededException: 'Too many attempts; wait a minute and try again',
}

async function call<T>(target: string, body: unknown): Promise<T> {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const type = String(data.__type ?? '').split('#').pop() ?? ''
    // InvalidPasswordException messages explain the password policy; show them as-is.
    throw new Error(FRIENDLY[type] ?? data.message ?? 'Sign-in failed')
  }
  return data as T
}

function toTokens(r: AuthResult, previousRefresh?: string): Tokens {
  return {
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken ?? previousRefresh,
    expiresAt: Date.now() + r.ExpiresIn * 1000,
  }
}

export function storeTokens(tokens: Tokens | null) {
  try {
    if (tokens) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable (private mode): tokens live for this page load only
  }
  memoryTokens = tokens
}

let memoryTokens: Tokens | null = null
export function loadTokens(): Tokens | null {
  if (memoryTokens) return memoryTokens
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    memoryTokens = raw ? (JSON.parse(raw) as Tokens) : null
  } catch {
    memoryTokens = null
  }
  return memoryTokens
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const r = await call<{ AuthenticationResult?: AuthResult; ChallengeName?: string; Session?: string }>(
    'InitiateAuth',
    { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: CLIENT_ID, AuthParameters: { USERNAME: email, PASSWORD: password } },
  )
  if (r.ChallengeName === 'NEW_PASSWORD_REQUIRED' && r.Session) return { kind: 'newPasswordRequired', session: r.Session }
  if (!r.AuthenticationResult) throw new Error(`Unsupported sign-in step: ${r.ChallengeName ?? 'unknown'}`)
  return { kind: 'signedIn', tokens: toTokens(r.AuthenticationResult) }
}

export async function completeNewPassword(email: string, session: string, newPassword: string): Promise<Tokens> {
  const r = await call<{ AuthenticationResult?: AuthResult }>('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    ClientId: CLIENT_ID,
    Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  })
  if (!r.AuthenticationResult) throw new Error('Could not set the new password')
  return toTokens(r.AuthenticationResult)
}

async function refresh(tokens: Tokens): Promise<Tokens | null> {
  if (!tokens.refreshToken) return null
  try {
    const r = await call<{ AuthenticationResult?: AuthResult }>('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: tokens.refreshToken },
    })
    return r.AuthenticationResult ? toTokens(r.AuthenticationResult, tokens.refreshToken) : null
  } catch {
    return null
  }
}

// A valid ID token for API calls, refreshed shortly before it expires; null when signed out.
let refreshing: Promise<Tokens | null> | null = null
export async function getIdToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.idToken
  refreshing ??= refresh(tokens).finally(() => {
    refreshing = null
  })
  const next = await refreshing
  storeTokens(next)
  return next?.idToken ?? null
}

export function claims(idToken: string): { email: string; name?: string } {
  try {
    const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    const json = JSON.parse(new TextDecoder().decode(bytes))
    return { email: json.email ?? json['cognito:username'] ?? '', name: json.name }
  } catch {
    return { email: '' }
  }
}
