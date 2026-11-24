import { CognitoJwtVerifier } from 'aws-jwt-verify'

// Team sign-in: every /api call must carry a Cognito token from the dashboard
// ("Authorization: Bearer <id or access token>"). Signature, expiry, issuer and client are checked
// against the user pool's public keys. With no user pool configured (local dev) auth is off.
export function createAuth({ userPoolId, clientId }, verifier) {
  if (!userPoolId) return null
  const v =
    verifier ??
    CognitoJwtVerifier.create({ userPoolId, clientId: clientId || null, tokenUse: null })
  return async (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')
    if (!m) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'sign in required' })
    try {
      const claims = await v.verify(m[1])
      req.user = { sub: claims.sub, email: claims.email ?? claims.username ?? claims['cognito:username'] }
      next()
    } catch {
      res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ error: 'invalid or expired token' })
    }
  }
}
