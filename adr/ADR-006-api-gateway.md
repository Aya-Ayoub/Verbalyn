# ADR-006: Use an API Gateway

## Status
Accepted

## Context
All client requests need a single entry point that handles routing, authentication enforcement, and rate limiting — without duplicating this logic in every service.

## Decision
Use Kong as the API Gateway in front of all microservices.

## Reasons
Centralizing routing and auth in the gateway means individual services do not need to implement them separately. It also makes it easier to add cross-cutting concerns like logging and rate limiting.

## Consequences

**Benefits:**
- Centralized routing
- Authentication enforcement in one place
- Rate limiting and logging

**Tradeoffs:**
- The gateway is an additional component and must be kept highly available