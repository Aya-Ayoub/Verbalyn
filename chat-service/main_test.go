package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/mux"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

func makeToken(userID, email, name string) string {
	claims := JWTClaims{
		UserID: userID,
		Email:  email,
		Name:   name,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	token, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(jwtSecret))
	return token
}

func setupTestRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/health", healthHandler).Methods(http.MethodGet)
	r.HandleFunc("/chat/messages", authMiddleware(listMessagesHandler)).Methods(http.MethodGet)
	r.HandleFunc("/chat/messages", authMiddleware(sendMessageHandler)).Methods(http.MethodPost)
	r.HandleFunc("/chat/messages/{id}", authMiddleware(editMessageHandler)).Methods(http.MethodPut)
	r.HandleFunc("/chat/messages/{id}", authMiddleware(deleteMessageHandler)).Methods(http.MethodDelete)
	r.HandleFunc("/chat/stats", authMiddleware(statsHandler)).Methods(http.MethodGet)
	return r
}

//Health

func TestHealthEndpoint(t *testing.T) {
	r := setupTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Errorf("expected status ok, got %q", body["status"])
	}
	if body["service"] != "chat-service" {
		t.Errorf("expected service chat-service, got %q", body["service"])
	}
}

//Auth middleware

func TestAuthMiddleware_NoToken(t *testing.T) {
	r := setupTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/chat/messages", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestAuthMiddleware_BadToken(t *testing.T) {
	r := setupTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/chat/messages", nil)
	req.Header.Set("Authorization", "Bearer bad.token.here")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

//Token parsing

func TestParseToken_Valid(t *testing.T) {
	tok := makeToken("user123", "test@example.com", "Tester")
	claims, err := parseToken(tok)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if claims.UserID != "user123" {
		t.Errorf("expected userID user123, got %q", claims.UserID)
	}
	if claims.Email != "test@example.com" {
		t.Errorf("expected email test@example.com, got %q", claims.Email)
	}
}

func TestParseToken_Expired(t *testing.T) {
	claims := JWTClaims{
		UserID: "u1",
		Email:  "a@a.com",
		Name:   "A",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Hour)),
		},
	}
	tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(jwtSecret))
	if _, err := parseToken(tok); err == nil {
		t.Error("expected error for expired token")
	}
}

func TestParseToken_WrongSecret(t *testing.T) {
	claims := JWTClaims{UserID: "u1", Email: "a@a.com", Name: "A"}
	tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("wrong-secret"))
	if _, err := parseToken(tok); err == nil {
		t.Error("expected error for wrong secret")
	}
}

//Send message

func TestSendMessage_EmptyContent(t *testing.T) {
	r := setupTestRouter()
	tok := makeToken("u1", "a@a.com", "A")

	body := bytes.NewBufferString(`{"room":"general","content":""}`)
	req := httptest.NewRequest(http.MethodPost, "/chat/messages", body)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSendMessage_InvalidJSON(t *testing.T) {
	r := setupTestRouter()
	tok := makeToken("u1", "a@a.com", "A")

	req := httptest.NewRequest(http.MethodPost, "/chat/messages", bytes.NewBufferString(`not json`))
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

//Edit/Delete message validation

func TestEditMessage_InvalidID(t *testing.T) {
	r := setupTestRouter()
	tok := makeToken("u1", "a@a.com", "A")

	body := bytes.NewBufferString(`{"content":"updated"}`)
	req := httptest.NewRequest(http.MethodPut, "/chat/messages/not-an-objectid", body)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestDeleteMessage_InvalidID(t *testing.T) {
	r := setupTestRouter()
	tok := makeToken("u1", "a@a.com", "A")

	req := httptest.NewRequest(http.MethodDelete, "/chat/messages/bad-id", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

//unit tests

func TestHub_JoinLeave(t *testing.T) {
	h := newHub()
	go h.run()
	time.Sleep(10 * time.Millisecond)

	c := &Client{
		send: make(chan []byte, 4),
		room: "test-room",
	}
	h.join <- c
	time.Sleep(10 * time.Millisecond)

	h.mu.RLock()
	_, exists := h.rooms["test-room"][c]
	h.mu.RUnlock()
	if !exists {
		t.Fatal("client not found in room after join")
	}

	h.leave <- c
	time.Sleep(10 * time.Millisecond)

	h.mu.RLock()
	_, exists = h.rooms["test-room"][c]
	h.mu.RUnlock()
	if exists {
		t.Fatal("client still in room after leave")
	}
}

func TestHub_Broadcast(t *testing.T) {
	h := newHub()
	go h.run()
	time.Sleep(10 * time.Millisecond)

	c := &Client{
		send: make(chan []byte, 4),
		room: "bcast-room",
	}
	h.join <- c
	time.Sleep(10 * time.Millisecond)

	payload := []byte(`{"type":"message"}`)
	h.broadcast("bcast-room", payload)
	time.Sleep(10 * time.Millisecond)

	select {
	case msg := <-c.send:
		if string(msg) != string(payload) {
			t.Errorf("wrong payload: %s", msg)
		}
	default:
		t.Fatal("no message received in client send channel")
	}

	h.leave <- c
}

func TestMessageJSONRoundtrip(t *testing.T) {
	msg := Message{
		ID:        primitive.NewObjectID(),
		Room:      "general",
		UserID:    "u1",
		Email:     "a@a.com",
		Name:      "Alice",
		Content:   "hello",
		CreatedAt: time.Now().UTC().Truncate(time.Second),
		UpdatedAt: time.Now().UTC().Truncate(time.Second),
	}
	b, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	var out Message
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if out.Content != msg.Content {
		t.Errorf("content mismatch: %q vs %q", out.Content, msg.Content)
	}
	if out.Room != msg.Room {
		t.Errorf("room mismatch: %q vs %q", out.Room, msg.Room)
	}
}

//publishEvent

func TestPublishEvent_NilChannel(t *testing.T) {
	amqpCh = nil
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("publishEvent panicked: %v", r)
		}
	}()
	publishEvent("message.sent", map[string]string{"test": "value"})
}

func TestClaimsFromContext_Missing(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	claims := claimsFrom(req)
	if claims != nil {
		t.Error("expected nil claims for unauthenticated request")
	}
}

func TestClaimsFromContext_Present(t *testing.T) {
	expected := &JWTClaims{UserID: "u1", Email: "a@a.com", Name: "A"}
	ctx := context.WithValue(context.Background(), "claims", expected)
	req := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	claims := claimsFrom(req)
	if claims == nil {
		t.Fatal("expected claims, got nil")
	}
	if claims.UserID != "u1" {
		t.Errorf("wrong userID: %q", claims.UserID)
	}
}
