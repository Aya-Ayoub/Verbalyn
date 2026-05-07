import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Config ───────────────────────────────────────────────────────────────────
const AUTH_BASE = 'http://localhost:3001';
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3002';
const WS_BASE = import.meta.env.VITE_WS_BASE || 'ws://localhost:3003';
// ─── Helpers ──────────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem('token');
const setToken = (t) => localStorage.setItem('token', t);
const clearToken = () => localStorage.removeItem('token');

const authFetch = (path, opts = {}) =>
  fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(opts.headers || {}),
    },
  });

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:         #0a0a0f;
    --surface:    #111118;
    --surface2:   #18181f;
    --border:     #2a2a38;
    --accent:     #7c6af7;
    --accent2:    #f76aab;
    --accent3:    #6af7c8;
    --text:       #e8e8f0;
    --text2:      #8888aa;
    --danger:     #f76a6a;
    --radius:     12px;
    --font:       'Syne', sans-serif;
    --mono:       'Space Mono', monospace;
    --sidebar-w: 260px;
    --header-h:  56px;
  }

  html, body, #root { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }

  /* ── Login ── */
  .login-screen {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(ellipse 80% 60% at 50% 0%, #1a1040 0%, var(--bg) 70%);
    position: relative;
    overflow: hidden;
  }
  .login-screen::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image: repeating-linear-gradient(
      0deg, transparent, transparent 39px, var(--border) 40px
    ), repeating-linear-gradient(
      90deg, transparent, transparent 39px, var(--border) 40px
    );
    opacity: 0.25;
  }
  .login-card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 24px;
    padding: 52px 48px;
    text-align: center;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 0 80px #7c6af720;
    animation: fadeUp .5s ease both;
  }
  .login-logo {
    font-size: 2.4rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 8px;
  }
  .login-tagline {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text2);
    margin-bottom: 40px;
  }
  .btn-google {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    width: 100%;
    padding: 14px 24px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    font-family: var(--font);
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all .2s;
  }
  .btn-google:hover {
    border-color: var(--accent);
    background: #7c6af710;
    transform: translateY(-1px);
    box-shadow: 0 4px 20px #7c6af720;
  }
  .google-icon { width: 20px; height: 20px; }

  /* ── App shell ── */
  .app-shell {
    display: grid;
    grid-template-columns: var(--sidebar-w) 1fr;
    grid-template-rows: var(--header-h) 1fr;
    height: 100vh;
    animation: fadeIn .3s ease;
  }

  /* ── Header ── */
  .header {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    z-index: 10;
  }
  .header-logo {
    font-size: 1.3rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .header-actions { display: flex; align-items: center; gap: 12px; }
  .avatar {
    width: 32px; height: 32px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    object-fit: cover;
    background: var(--surface2);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 0.8rem; color: var(--accent);
    overflow: hidden;
  }
  .btn-icon {
    background: none; border: none; color: var(--text2);
    cursor: pointer; padding: 6px; border-radius: 6px;
    transition: color .15s, background .15s;
    font-size: 1rem;
  }
  .btn-icon:hover { color: var(--text); background: var(--surface2); }

  /* ── Sidebar ── */
  .sidebar {
    border-right: 1px solid var(--border);
    background: var(--surface);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .sidebar-nav { padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; border-radius: 8px;
    font-size: 0.875rem; font-weight: 600;
    color: var(--text2); cursor: pointer;
    border: none; background: none; width: 100%; text-align: left;
    transition: all .15s;
  }
  .nav-item:hover { color: var(--text); background: var(--surface2); }
  .nav-item.active { color: var(--accent); background: #7c6af715; }
  .nav-icon { width: 18px; font-size: 1rem; text-align: center; }

  .sidebar-section-label {
    font-size: 0.65rem; font-weight: 700; letter-spacing: 0.1em;
    color: var(--text2); text-transform: uppercase;
    padding: 16px 20px 6px;
  }
  .room-list { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
  .room-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: 8px;
    font-size: 0.85rem; cursor: pointer;
    transition: all .15s; color: var(--text2);
    border: none; background: none; width: 100%;
  }
  .room-item:hover { color: var(--text); background: var(--surface2); }
  .room-item.active { color: var(--text); background: var(--surface2); }
  .room-hash { color: var(--text2); font-family: var(--mono); font-size: 0.9rem; }
  .room-name { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .unread-badge {
    background: var(--accent); color: #fff;
    font-size: 0.65rem; font-weight: 700;
    border-radius: 10px; padding: 1px 6px;
    min-width: 18px; text-align: center;
  }

  /* ── Main content ── */
  .main { display: flex; flex-direction: column; overflow: hidden; }

  /* ── Chat ── */
  .chat-header {
    padding: 0 20px; height: 52px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px;
    background: var(--surface);
  }
  .chat-header-name { font-weight: 700; font-size: 1rem; }
  .chat-header-desc { font-size: 0.8rem; color: var(--text2); margin-left: auto; font-family: var(--mono); }
  .online-dot { width: 8px; height: 8px; background: var(--accent3); border-radius: 50%; flex-shrink: 0; }

  .messages-area {
    flex: 1; overflow-y: auto; padding: 16px 20px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .messages-area::-webkit-scrollbar { width: 4px; }
  .messages-area::-webkit-scrollbar-track { background: transparent; }
  .messages-area::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  .msg-group { display: flex; flex-direction: column; gap: 2px; }
  .msg-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 2px 8px; border-radius: 8px;
    transition: background .1s;
  }
  .msg-row:hover { background: var(--surface2); }
  .msg-row.own { flex-direction: row-reverse; }
  .msg-avatar {
    width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
    background: var(--surface2); border: 1.5px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.75rem; font-weight: 700; color: var(--accent);
  }
  .msg-body { max-width: 70%; display: flex; flex-direction: column; gap: 2px; }
  .msg-meta {
    display: flex; align-items: baseline; gap: 8px;
    font-size: 0.72rem; color: var(--text2);
  }
  .msg-sender { font-weight: 700; color: var(--text); }
  .msg-row.own .msg-meta { flex-direction: row-reverse; }
  .msg-bubble {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 12px 12px 12px 4px;
    padding: 8px 12px; font-size: 0.9rem; line-height: 1.5;
    word-break: break-word;
  }
  .msg-row.own .msg-bubble {
    background: #7c6af720; border-color: var(--accent);
    border-radius: 12px 12px 4px 12px;
  }
  .typing-indicator {
    font-size: 0.78rem; color: var(--text2); font-style: italic;
    padding: 4px 8px; font-family: var(--mono);
  }
  .day-divider {
    display: flex; align-items: center; gap: 12px;
    margin: 12px 0; color: var(--text2); font-size: 0.72rem;
    font-family: var(--mono);
  }
  .day-divider::before, .day-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }

  .chat-input-bar {
    padding: 12px 20px;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .chat-input-wrap {
    display: flex; align-items: flex-end; gap: 8px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 12px; padding: 8px 12px;
    transition: border-color .2s;
  }
  .chat-input-wrap:focus-within { border-color: var(--accent); }
  .chat-input {
    flex: 1; background: none; border: none; outline: none;
    color: var(--text); font-family: var(--font); font-size: 0.9rem;
    resize: none; max-height: 120px; line-height: 1.5;
  }
  .chat-input::placeholder { color: var(--text2); }
  .send-btn {
    background: var(--accent); border: none; border-radius: 8px;
    color: #fff; font-family: var(--mono); font-size: 0.8rem;
    font-weight: 700; padding: 6px 14px; cursor: pointer;
    transition: opacity .15s, transform .1s;
    align-self: flex-end;
  }
  .send-btn:hover { opacity: 0.85; transform: scale(0.98); }
  .send-btn:disabled { opacity: 0.4; cursor: default; }

  .ws-status {
    font-family: var(--mono); font-size: 0.7rem;
    padding: 2px 8px; border-radius: 4px; margin-bottom: 6px;
    display: inline-block;
  }
  .ws-status.connected { color: var(--accent3); }
  .ws-status.disconnected { color: var(--danger); }

  /* ── Dashboard ── */
  .dashboard { padding: 28px; overflow-y: auto; }
  .dashboard h2 { font-size: 1.4rem; font-weight: 800; margin-bottom: 6px; }
  .dashboard p { color: var(--text2); font-size: 0.85rem; font-family: var(--mono); margin-bottom: 24px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin-bottom: 28px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px;
    transition: border-color .2s, transform .2s;
  }
  .stat-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .stat-label { font-size: 0.72rem; font-family: var(--mono); color: var(--text2); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.08em; }
  .stat-value { font-size: 2rem; font-weight: 800; line-height: 1; }
  .stat-value.accent { color: var(--accent); }
  .stat-value.accent2 { color: var(--accent2); }
  .stat-value.accent3 { color: var(--accent3); }

  /* ── Profile ── */
  .profile-page { padding: 28px; overflow-y: auto; max-width: 560px; }
  .profile-page h2 { font-size: 1.4rem; font-weight: 800; margin-bottom: 24px; }
  .form-group { margin-bottom: 18px; }
  .form-label { font-size: 0.78rem; font-family: var(--mono); color: var(--text2); display: block; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
  .form-input {
    width: 100%; background: var(--surface2); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text); font-family: var(--font);
    font-size: 0.9rem; padding: 10px 14px; outline: none;
    transition: border-color .2s;
  }
  .form-input:focus { border-color: var(--accent); }
  textarea.form-input { resize: vertical; min-height: 80px; }
  .btn-primary {
    background: var(--accent); border: none; border-radius: 8px;
    color: #fff; font-family: var(--font); font-size: 0.9rem; font-weight: 700;
    padding: 10px 24px; cursor: pointer; transition: opacity .15s;
  }
  .btn-primary:hover { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.5; cursor: default; }
  .success-msg { color: var(--accent3); font-size: 0.8rem; font-family: var(--mono); margin-top: 8px; }
  .error-msg { color: var(--danger); font-size: 0.8rem; font-family: var(--mono); margin-top: 8px; }

  /* ── Animations ── */
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }

  .msg-row { animation: slideIn .15s ease both; }
  .empty-state { text-align: center; color: var(--text2); font-family: var(--mono); font-size: 0.85rem; margin: auto; padding: 40px; }
  .empty-state .big { font-size: 2.5rem; margin-bottom: 12px; }
`;

// ─── Google Icon SVG ──────────────────────────────────────────────────────────
const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" className="google-icon">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

// ─── ROOMS (mock — replace with API call in production) ──────────────────────
const DEFAULT_ROOMS = [
  { id: 'general', name: 'general', desc: 'General chat' },
  { id: 'random', name: 'random', desc: 'Off-topic' },
  { id: 'dev', name: 'dev', desc: 'Engineering' },
  { id: 'design', name: 'design', desc: 'Design & UX' },
];

// ─── Components ───────────────────────────────────────────────────────────────

function LoginScreen() {
  const handleLogin = () => {
    window.location.href = `${AUTH_BASE}/auth/google`;
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">Verbalyn</div>
        <p className="login-tagline">// real-time chat, built to scale</p>
        <button className="btn-google" onClick={handleLogin}>
          <GoogleIcon />
          Continue with Google
        </button>
      </div>
    </div>
  );
}

function ChatView({ room, user }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [typing, setTyping] = useState('');
  const wsRef = useRef(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // WebSocket connection
  useEffect(() => {
    if (!room || !getToken()) return;
    const ws = new WebSocket(`${WS_BASE}/chat?room=${room.id}&token=${getToken()}`);
    wsRef.current = ws;

    ws.onopen = () => setWsStatus('connected');
    ws.onclose = () => setWsStatus('disconnected');
    ws.onerror = () => setWsStatus('disconnected');

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'message') {
          setMessages((prev) => [...prev, data.payload]);
        } else if (data.type === 'history') {
          setMessages(data.payload);
        } else if (data.type === 'typing') {
          setTyping(data.payload.name);
          setTimeout(() => setTyping(''), 2000);
        }
      } catch { /* ignore malformed */ }
    };

    return () => ws.close();
  }, [room?.id]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(() => {
    if (!input.trim() || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'message', content: input.trim() }));
    setInput('');
    inputRef.current?.focus();
  }, [input]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'typing' }));
    }
  };

  if (!room) {
    return (
      <div className="main" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="empty-state"><div className="big">💬</div>Select a room to start chatting</div>
      </div>
    );
  }

  return (
    <div className="main">
      <div className="chat-header">
        <div className="online-dot" />
        <span className="chat-header-name">#{room.name}</span>
        <span className="chat-header-desc">{room.desc}</span>
      </div>
      <div className="messages-area">
        {messages.length === 0 && (
          <div className="empty-state"><div className="big">🔥</div>No messages yet — say something!</div>
        )}
        <div className="day-divider">Today</div>
        {messages.map((msg, i) => {
          const isOwn = msg.userId === user?._id || msg.email === user?.email;
          const initials = (msg.name || msg.email || '?')[0].toUpperCase();
          return (
            <div key={msg._id || i} className={`msg-row ${isOwn ? 'own' : ''}`}>
              <div className="msg-avatar">{initials}</div>
              <div className="msg-body">
                <div className="msg-meta">
                  <span className="msg-sender">{isOwn ? 'You' : msg.name}</span>
                  <span>{timeAgo(msg.createdAt || new Date())}</span>
                </div>
                <div className="msg-bubble">{msg.content}</div>
              </div>
            </div>
          );
        })}
        {typing && <div className="typing-indicator">{typing} is typing…</div>}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-bar">
        <span className={`ws-status ${wsStatus}`}>
          {wsStatus === 'connected' ? '● connected' : '○ reconnecting…'}
        </span>
        <div className="chat-input-wrap">
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={1}
            placeholder={`Message #${room.name}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={!input.trim() || wsStatus !== 'connected'}
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}

function DashboardView() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    authFetch('/dashboard/stats')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => data && setStats(data))
      .catch(() => {});
  }, []);

  const s = stats || { totalMessages: 0, activeUsers: 0, totalRooms: 4, uptime: '99.9%' };

  return (
    <div className="dashboard">
      <h2>Dashboard</h2>
      <p>// system overview · real-time metrics</p>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Messages</div>
          <div className="stat-value accent">{s.totalMessages?.toLocaleString?.() ?? s.totalMessages}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active Users</div>
          <div className="stat-value accent2">{s.activeUsers}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Rooms</div>
          <div className="stat-value accent3">{s.totalRooms}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Uptime</div>
          <div className="stat-value">{s.uptime}</div>
        </div>
      </div>
      <p style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
        Full metrics available in Grafana → <code style={{ color: 'var(--accent)' }}>localhost:3010</code>
      </p>
    </div>
  );
}

function ProfileView({ user, onUpdate }) {
  const [name, setName] = useState(user?.name || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const save = async () => {
    setSaving(true); setMsg(''); setErr('');
    try {
      const res = await authFetch('/users/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name, bio }),
      });
      if (res.ok) {
        const updated = await res.json();
        onUpdate(updated);
        setMsg('Profile updated!');
      } else {
        setErr('Failed to save. Try again.');
      }
    } catch {
      setErr('Network error.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-page">
      <h2>Your Profile</h2>
      <div className="form-group">
        <label className="form-label">Display Name</label>
        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">Email</label>
        <input className="form-input" value={user?.email || ''} disabled style={{ opacity: 0.5 }} />
      </div>
      <div className="form-group">
        <label className="form-label">Bio</label>
        <textarea className="form-input" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} />
      </div>
      <button className="btn-primary" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save Changes'}
      </button>
      {msg && <div className="success-msg">✓ {msg}</div>}
      {err && <div className="error-msg">✗ {err}</div>}
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('chat'); // chat | dashboard | profile
  const [activeRoom, setActiveRoom] = useState(DEFAULT_ROOMS[0]);

  // Handle token from OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (t) {
      setToken(t);
      window.history.replaceState({}, '', '/');
    }

    const token = getToken();
    if (!token) { setLoading(false); return; }

    authFetch('/users/profile')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setUser(data); else clearToken(); })
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    await authFetch('/auth/logout', { method: 'POST' }).catch(() => {});
    clearToken();
    setUser(null);
  };

  if (loading) {
    return (
      <>
        <style>{css}</style>
        <div className="login-screen">
          <div style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>
            loading…
          </div>
        </div>
      </>
    );
  }

  if (!user) {
    return (
      <>
        <style>{css}</style>
        <LoginScreen />
      </>
    );
  }

  const initials = (user.name || user.email || '?')[0].toUpperCase();

  return (
    <>
      <style>{css}</style>
      <div className="app-shell">
        {/* Header */}
        <header className="header">
          <span className="header-logo">Verbalyn</span>
          <div className="header-actions">
            <div className="avatar">{user.avatar
              ? <img src={user.avatar} alt={user.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : initials}
            </div>
            <button className="btn-icon" title="Logout" onClick={logout}>⏻</button>
          </div>
        </header>

        {/* Sidebar */}
        <aside className="sidebar">
          <nav className="sidebar-nav">
            <button className={`nav-item ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>
              <span className="nav-icon">💬</span> Chat
            </button>
            <button className={`nav-item ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>
              <span className="nav-icon">📊</span> Dashboard
            </button>
            <button className={`nav-item ${view === 'profile' ? 'active' : ''}`} onClick={() => setView('profile')}>
              <span className="nav-icon">👤</span> Profile
            </button>
          </nav>

          {view === 'chat' && (
            <>
              <div className="sidebar-section-label">Rooms</div>
              <div className="room-list">
                {DEFAULT_ROOMS.map((room) => (
                  <button
                    key={room.id}
                    className={`room-item ${activeRoom?.id === room.id ? 'active' : ''}`}
                    onClick={() => setActiveRoom(room)}
                  >
                    <span className="room-hash">#</span>
                    <span className="room-name">{room.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>

        {/* Main */}
        {view === 'chat' && <ChatView room={activeRoom} user={user} />}
        {view === 'dashboard' && <DashboardView />}
        {view === 'profile' && <ProfileView user={user} onUpdate={setUser} />}
      </div>
    </>
  );
}