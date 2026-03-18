# ADR-005: Use Google OAuth2 for Authentication

## Status
Accepted

## Context
The system must authenticate users securely without storing passwords.

## Decision
Use Google OAuth2 for user login. After login, the system issues a JWT token for subsequent requests.

## Reasons
Google OAuth2 is a widely trusted standard that eliminates the need to store or manage passwords.

## Consequences

**Benefits:**
- Improved security
- No password storage
- Easy user login experience

**Tradeoffs:**
- Dependency on an external authentication provider