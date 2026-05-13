Write-Host "=== Verbalyn Deployment ===" -ForegroundColor Cyan

# Check .env exists
if (-not (Test-Path ".env")) {
    Write-Host "ERROR: .env file not found. Copy .env.example to .env and fill in your values." -ForegroundColor Red
    exit 1
}

Write-Host "Building application services..." -ForegroundColor Yellow
docker compose build --parallel auth-service user-service chat-service notification-service dashboard-service frontend

Write-Host "Starting all services..." -ForegroundColor Yellow
docker compose up -d

Write-Host "Waiting for services to be healthy..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

Write-Host "`n=== Service Status ===" -ForegroundColor Cyan
docker compose ps

Write-Host "`n=== Health Checks ===" -ForegroundColor Cyan
@(3001, 3002, 3003, 3004, 3005) | ForEach-Object {
    try {
        $res = Invoke-WebRequest -Uri "http://localhost:$_/health" -UseBasicParsing -TimeoutSec 3
        Write-Host "Port $_`: OK ($($res.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "Port $_`: FAILED" -ForegroundColor Red
    }
}

Write-Host "`n=== Verbalyn is running ===" -ForegroundColor Green
Write-Host "App:        http://localhost:5173"
Write-Host "Grafana:    http://localhost:3010"
Write-Host "Prometheus: http://localhost:9090"
Write-Host "RabbitMQ:   http://localhost:15672"
