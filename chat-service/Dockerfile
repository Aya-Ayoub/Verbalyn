# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o chat-service .

# ── Stage 2: Run ──────────────────────────────────────────────────────────────
FROM alpine:3.19
WORKDIR /app
RUN apk add --no-cache ca-certificates wget

COPY --from=builder /app/chat-service .

EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1

USER nobody
CMD ["./chat-service"]