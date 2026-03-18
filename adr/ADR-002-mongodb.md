# ADR-002: Use MongoDB as the Primary Database

## Status
Accepted

## Context
Chat messages need flexible storage and fast read/write operations. A rigid relational schema is not a good fit.

## Decision
Use MongoDB as the primary database.

## Reasons
MongoDB uses document-based storage which fits chat messages well. It also supports horizontal scaling out of the box.

## Consequences

**Benefits:**
- Flexible schema
- Horizontal scaling
- High performance for chat systems

**Tradeoffs:**
- Less strict schema enforcement