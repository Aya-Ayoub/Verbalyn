/*
k6 run -e TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2OWZjOTM0ZDM4NTY1NWU2YWZkNDI2Y2YiLCJlbWFpbCI6Im1zZWxoYXdhcnk2QGdtYWlsLmNvbSIsIm5hbWUiOiJBeWEgTW9zdGFmYSIsImlhdCI6MTc3ODUxMTU3MiwiZXhwIjoxNzc5MTE2MzcyfQ.GXB4WtkUXtXtstG6YrM_SX7G3p2HLRdZN99d5EczigQ tests/k6/load-test.js
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

//metrics
const wsMessages = new Counter('ws_messages_received');
const wsErrors = new Counter('ws_errors');
const httpErrors = new Rate('http_error_rate');
const msgLatency = new Trend('message_send_latency');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3002';
const CHAT_URL = __ENV.CHAT_URL || 'http://localhost:3003';
const DASH_URL = __ENV.DASH_URL || 'http://localhost:3005';
const WS_URL   = __ENV.WS_URL   || 'ws://localhost:3003';
const TOKEN    = __ENV.TOKEN    || '';

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}

export const options = {
  stages: [
    { duration: '30s', target: 10 },   
    { duration: '1m',  target: 50 },   
    { duration: '30s', target: 100 },  
    { duration: '30s', target: 0 },    
  ],
  thresholds: {
    http_req_duration:    ['p(95)<500'],  //95% of requests under 500ms
    http_req_failed:      ['rate<0.05'],  // and< 5% failures
    http_error_rate:      ['rate<0.05'],
    ws_errors:            ['count<10'],
  },
};



export default function () {
  const scenario = Math.random();

  if (scenario < 0.4) {
    testUserProfile();
  } else if (scenario < 0.7) {
    testChatREST();
  } else if (scenario < 0.85) {
    testDashboard();
  } else {
    testWebSocket();
  }

  sleep(1);
}

function testUserProfile() {
  const res = http.get(`${BASE_URL}/users/profile`, { headers: authHeaders });
  const ok = check(res, {
    'profile status 200 or 401': (r) => [200, 401].includes(r.status),
    'profile response time < 300ms': (r) => r.timings.duration < 300,
  });
  httpErrors.add(!ok);
}

function testChatREST() {
  const getRes = http.get(`${CHAT_URL}/chat/messages?room=general`, { headers: authHeaders });
  check(getRes, {
    'get messages 200 or 401': (r) => [200, 401].includes(r.status),
  });
  httpErrors.add(getRes.status >= 500);

  if (!TOKEN) return;


  const start = Date.now();
  const postRes = http.post(
    `${CHAT_URL}/chat/messages`,
    JSON.stringify({ room: 'general', content: `k6 test message ${Date.now()}` }),
    { headers: authHeaders }
  );
  msgLatency.add(Date.now() - start);

  check(postRes, {
    'send message 201 or 401': (r) => [201, 401].includes(r.status),
    'send < 500ms': (r) => r.timings.duration < 500,
  });
  httpErrors.add(postRes.status >= 500);
}

function testDashboard() {
  const res = http.get(`${DASH_URL}/dashboard/stats`, { headers: authHeaders });
  check(res, {
    'dashboard 200 or 401': (r) => [200, 401].includes(r.status),
    'dashboard < 500ms': (r) => r.timings.duration < 500,
  });
  httpErrors.add(res.status >= 500);
}

function testWebSocket() {
  if (!TOKEN) return;

  const url = `${WS_URL}/chat/ws?room=general&token=${TOKEN}`;
  const response = ws.connect(url, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'message', content: `ws k6 ${Date.now()}` }));
    });

    socket.on('message', (data) => {
      wsMessages.add(1);
      try {
        const msg = JSON.parse(data);
        check(msg, { 'ws message has type': (m) => !!m.type });
      } catch {
        wsErrors.add(1);
      }
    });

    socket.on('error', () => wsErrors.add(1));

    socket.setTimeout(() => socket.close(), 4000);
  });

  check(response, { 'ws connected': (r) => r && r.status === 101 });
}

//health check
export function setup() {
  const services = [
    { name: 'auth',  url: 'http://auth-service:3001/health' },
    { name: 'user',  url: `${BASE_URL}/health` },
    { name: 'chat',  url: `${CHAT_URL}/health` },
    { name: 'dash',  url: `${DASH_URL}/health` },
  ];

  services.forEach(({ name, url }) => {
    const res = http.get(url);
    console.log(`[setup] ${name}: ${res.status}`);
  });
}