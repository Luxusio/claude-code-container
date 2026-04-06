# Security Review Overlay
summary: Domain-specific security checks activated when auth/security signals are detected.
type: review-overlay

## Required checks

| Area | What to verify |
|------|---------------|
| Access control | Broken access control, ownership checks, IDOR vulnerabilities |
| Authentication | Token handling, session management, credential storage |
| Input validation | Schema validation, type coercion, boundary checks |
| Injection | SQL, XSS, command, template injection vectors |
| Headers | CORS policy, CSRF protection, security headers |
| Secrets | PII exposure, sensitive data in logs, secret leakage |
| External APIs | Trust boundaries, timeout handling, SSRF prevention |
| Rate limiting | Abuse resistance, throttling, retry policies |
| Dependencies | Known vulnerability awareness in direct dependencies |

## Trigger signals

- Prompt keywords: auth, login, session, token, permission, role, cors, csrf, secret, cookie, middleware, sql, injection, header, password, encrypt, certificate
- Touched paths: auth/, api/, middleware/, db/, security/, session/, login/
- Destructive auth/config/security change detected
