import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import * as cognito from './cognito'
import { UNAUTHORIZED_EVENT } from '../api/http'

// Team sign-in. With VITE_COGNITO_CLIENT_ID set it uses the Cognito user pool from infra/foundation
// (lib/cognito.ts); otherwise it is a local mock (any email + 8-character password).

export interface User {
  email: string
  name: string
}

export type SignInOutcome = 'signedIn' | 'newPasswordRequired'

interface AuthContextValue {
  user: User | null
  mode: 'cognito' | 'mock'
  signIn(email: string, password: string): Promise<SignInOutcome>
  // First sign-in with a temporary password: set the permanent one.
  completeNewPassword(newPassword: string): Promise<void>
  signOut(): void
}

const STORAGE_KEY = 'app-platform.user'
const AuthContext = createContext<AuthContextValue | null>(null)

const displayName = (email: string) =>
  email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function userFromTokens(tokens: cognito.Tokens | null): User | null {
  if (!tokens) return null
  const { email, name } = cognito.claims(tokens.idToken)
  return email ? { email, name: name ?? displayName(email) } : null
}

function readStoredUser(): User | null {
  if (cognito.cognitoConfigured) return userFromTokens(cognito.loadTokens())
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(readStoredUser)
  const [challenge, setChallenge] = useState<{ email: string; session: string } | null>(null)
  const mode = cognito.cognitoConfigured ? 'cognito' : 'mock'

  async function signIn(email: string, password: string): Promise<SignInOutcome> {
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
    if (mode === 'cognito') {
      const result = await cognito.signIn(email, password)
      if (result.kind === 'newPasswordRequired') {
        setChallenge({ email, session: result.session })
        return 'newPasswordRequired'
      }
      cognito.storeTokens(result.tokens)
      setUser(userFromTokens(result.tokens))
      return 'signedIn'
    }

    await new Promise((r) => setTimeout(r, 500))
    if (password.length < 8) throw new Error('Incorrect email or password')
    const next = { email, name: displayName(email) }
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Storage can be unavailable (private mode); stay signed in for this page load only.
    }
    setUser(next)
    return 'signedIn'
  }

  async function completeNewPassword(newPassword: string) {
    if (!challenge) throw new Error('Sign in with your temporary password first')
    const tokens = await cognito.completeNewPassword(challenge.email, challenge.session, newPassword)
    cognito.storeTokens(tokens)
    setChallenge(null)
    setUser(userFromTokens(tokens))
  }

  function signOut() {
    cognito.storeTokens(null)
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
    setChallenge(null)
    setUser(null)
  }

  // The API answered 401 (token expired and could not be refreshed): back to the sign-in page.
  useEffect(() => {
    const onUnauthorized = () => signOut()
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  return (
    <AuthContext.Provider value={{ user, mode, signIn, completeNewPassword, signOut }}>{children}</AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
