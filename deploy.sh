#!/bin/bash
set -e

echo "=== Verbalyn Deployment ==="

# Check .env exists
if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example to .env and fill in your values."
  exit 1
fi

echo "Pulling latest images..."
docker compose pull prometheus grafana node-exporter

echo "Building application services..."
docker compose build --parallel auth-service user-service chat-service notification-service dashboard-service frontend

echo "Starting all services..."
docker compose up -d

echo "Waiting for services to be healthy..."
sleep 15

echo "=== Service Status ==="
docker compose ps

echo ""
echo "=== Health Checks ==="
for port in 3001 3002 3003 3004 3005; do
  status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/health)
  echo "Port $port: $status"
done

echo ""
echo "=== Verbalyn is running ==="
echo "App:        http://localhost:5173"
echo "Grafana:    http://localhost:3010"
echo "Prometheus: http://localhost:9090"
echo "RabbitMQ:   http://localhost:15672"