import { createContext, useContext, useState, type ReactNode } from 'react'

// Sign-in is mocked until the Cognito user pool exists (infra/). The swap is contained here:
// replace signIn/signOut with Amplify Auth calls using VITE_COGNITO_USER_POOL_ID and
// VITE_COGNITO_CLIENT_ID, and keep the same context shape for the rest of the app.

export interface User {
  email: string
  name: string
}

interface AuthContextValue {
  user: User | null
  signIn(email: string, password: string): Promise<void>
  signOut(): void
}

const STORAGE_KEY = 'app-platform.user'
const AuthContext = createContext<AuthContextValue | null>(null)

function readStoredUser(): User | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(readStoredUser)

  async function signIn(email: string, password: string) {
    await new Promise((r) => setTimeout(r, 500))
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
    if (password.length < 8) throw new Error('Incorrect email or password')
    const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    const next = { email, name }
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Storage can be unavailable (private mode); stay signed in for this page load only.
    }
    setUser(next)
  }

  function signOut() {
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
    setUser(null)
  }

  return <AuthContext.Provider value={{ user, signIn, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
