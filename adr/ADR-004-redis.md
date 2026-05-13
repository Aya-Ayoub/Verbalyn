# ADR-004: Use Redis for Caching

## Status
Accepted

## Context
Frequently accessed data such as sessions and recent messages should be served quickly without hitting the database every time.

## Decision
Use Redis as an in-memory cache.

## Reasons
Redis provides sub-millisecond key-value lookups, making it ideal for session storage and caching hot data.

## Consequences

**Benefits:**
- Faster response times
- Reduced database load

**Tradeoffs:**
- Cache consistency must be managed carefully