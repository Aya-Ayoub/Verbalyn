# ADR-003: Use RabbitMQ as the Message Broker

## Status
Accepted

## Context
Services need to communicate asynchronously so that a slow or failing service does not block others.

## Decision
Use RabbitMQ for asynchronous communication between services.

## Rationale
RabbitMQ enables event-driven communication. For example, the Chat Service publishes an event and the Notification Service picks it up independently, without waiting.

## Consequences

**Benefits:**
- Decoupled services
- Reliable message delivery
- Supports event-driven architecture

**Tradeoffs:**
- Additional infrastructure component to operate