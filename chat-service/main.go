package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	amqp "github.com/rabbitmq/amqp091-go"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

//Config

var (
	jwtSecret   = getEnv("JWT_SECRET", "dev-jwt-secret")
	mongoURI    = getEnv("MONGO_URI", "mongodb://localhost:27017/verbalyn")
	rabbitURL   = getEnv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
	port        = getEnv("PORT", "3003")
	frontendURL = getEnv("FRONTEND_URL", "http://localhost:5173")
)

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// Prometheus
var (
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP request duration",
		Buckets: []float64{0.05, 0.1, 0.3, 0.5, 1, 2},
	}, []string{"method", "route", "status_code"})

	wsConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "ws_active_connections",
		Help: "Active WebSocket connections",
	})

	messagesSent = promauto.NewCounter(prometheus.CounterOpts{
		Name: "chat_messages_sent_total",
		Help: "Total messages sent",
	})
)

//Models

type Message struct {
	ID        primitive.ObjectID `bson:"_id,omitempty" json:"_id,omitempty"`
	Room      string             `bson:"room" json:"room"`
	UserID    string             `bson:"userId" json:"userId"`
	Email     string             `bson:"email" json:"email"`
	Name      string             `bson:"name" json:"name"`
	Content   string             `bson:"content" json:"content"`
	Edited    bool               `bson:"edited" json:"edited"`
	CreatedAt time.Time          `bson:"createdAt" json:"createdAt"`
	UpdatedAt time.Time          `bson:"updatedAt" json:"updatedAt"`
}

type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Content string          `json:"content,omitempty"`
}

type JWTClaims struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	jwt.RegisteredClaims
}

type Client struct {
	conn   *websocket.Conn
	send   chan []byte
	room   string
	userID string
	email  string
	name   string
}

type Hub struct {
	mu      sync.RWMutex
	rooms   map[string]map[*Client]bool
	publish chan roomMsg
	join    chan *Client
	leave   chan *Client
}

type roomMsg struct {
	room    string
	payload []byte
}

func newHub() *Hub {
	return &Hub{
		rooms:   make(map[string]map[*Client]bool),
		publish: make(chan roomMsg, 256),
		join:    make(chan *Client, 64),
		leave:   make(chan *Client, 64),
	}
}

func (h *Hub) run() {
	for {
		select {
		case c := <-h.join:
			h.mu.Lock()
			if h.rooms[c.room] == nil {
				h.rooms[c.room] = make(map[*Client]bool)
			}
			h.rooms[c.room][c] = true
			h.mu.Unlock()
			wsConnections.Inc()

		case c := <-h.leave:
			h.mu.Lock()
			if clients, ok := h.rooms[c.room]; ok {
				delete(clients, c)
				if len(clients) == 0 {
					delete(h.rooms, c.room)
				}
			}
			h.mu.Unlock()
			close(c.send)
			wsConnections.Dec()

		case msg := <-h.publish:
			h.mu.RLock()
			for c := range h.rooms[msg.room] {
				select {
				case c.send <- msg.payload:
				default:
					// slow client — drop
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) broadcast(room string, payload []byte) {
	h.publish <- roomMsg{room: room, payload: payload}
}

var (
	msgCol *mongo.Collection
	amqpCh *amqp.Channel
	hub    *Hub
)

//JWT

func parseToken(tokenStr string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &JWTClaims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(jwtSecret), nil
	})
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return token.Claims.(*JWTClaims), nil
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer "), true
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t, true
	}
	return "", false
}

//Middleware

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(s int) {
	sw.status = s
	sw.ResponseWriter.WriteHeader(s)
}

func (sw *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := sw.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("underlying ResponseWriter does not support hijacking")
	}
	return h.Hijack()
}

func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, status: 200}
		start := time.Now()
		next.ServeHTTP(sw, r)
		httpDuration.WithLabelValues(r.Method, r.URL.Path, fmt.Sprintf("%d", sw.status)).
			Observe(time.Since(start).Seconds())
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Request-ID")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok, ok := bearerToken(r)
		if !ok {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		claims, err := parseToken(tok)
		if err != nil {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), "claims", claims)
		next(w, r.WithContext(ctx))
	}
}

func claimsFrom(r *http.Request) *JWTClaims {
	c, _ := r.Context().Value("claims").(*JWTClaims)
	return c
}

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok","service":"chat-service"}`))
}

// GET /chat/messages?room=general&limit=50
func listMessagesHandler(w http.ResponseWriter, r *http.Request) {
	room := r.URL.Query().Get("room")
	if room == "" {
		room = "general"
	}
	limit := int64(50)

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(limit)
	cur, err := msgCol.Find(ctx, bson.M{"room": room}, opts)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	defer cur.Close(ctx)

	var msgs []Message
	if err := cur.All(ctx, &msgs); err != nil {
		http.Error(w, `{"error":"decode error"}`, http.StatusInternalServerError)
		return
	}

	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	if msgs == nil {
		msgs = []Message{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(msgs)
}

// POST /chat/messages
func sendMessageHandler(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	var body struct {
		Room    string `json:"room"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Content == "" {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}
	if body.Room == "" {
		body.Room = "general"
	}

	msg := Message{
		ID:        primitive.NewObjectID(),
		Room:      body.Room,
		UserID:    claims.UserID,
		Email:     claims.Email,
		Name:      claims.Name,
		Content:   body.Content,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if _, err := msgCol.InsertOne(ctx, msg); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}

	messagesSent.Inc()
	publishEvent("message.sent", msg)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(msg)
}

// PUT /chat/messages/{id}
func editMessageHandler(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	idStr := mux.Vars(r)["id"]
	oid, err := primitive.ObjectIDFromHex(idStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}

	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Content == "" {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	res, err := msgCol.UpdateOne(ctx,
		bson.M{"_id": oid, "userId": claims.UserID},
		bson.M{"$set": bson.M{"content": body.Content, "edited": true, "updatedAt": time.Now()}},
	)
	if err != nil || res.MatchedCount == 0 {
		http.Error(w, `{"error":"not found or forbidden"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"message":"updated"}`))
}

// DELETE /chat/messages/{id}
func deleteMessageHandler(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	idStr := mux.Vars(r)["id"]
	oid, err := primitive.ObjectIDFromHex(idStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	res, err := msgCol.DeleteOne(ctx, bson.M{"_id": oid, "userId": claims.UserID})
	if err != nil || res.DeletedCount == 0 {
		http.Error(w, `{"error":"not found or forbidden"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"message":"deleted"}`))
}

// GET /chat/stats for dahboard
func statsHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	total, _ := msgCol.CountDocuments(ctx, bson.M{})

	//count active rooms
	cutoff := time.Now().Add(-24 * time.Hour)
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.M{"createdAt": bson.M{"$gte": cutoff}}}},
		{{Key: "$group", Value: bson.M{"_id": "$room"}}},
		{{Key: "$count", Value: "count"}},
	}
	cur, _ := msgCol.Aggregate(ctx, pipeline)
	var result []struct {
		Count int `bson:"count"`
	}
	cur.All(ctx, &result)
	activeRooms := 0
	if len(result) > 0 {
		activeRooms = result[0].Count
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"totalMessages": total,
		"activeRooms":   activeRooms,
	})
}

//WebSocket handler

func wsHandler(w http.ResponseWriter, r *http.Request) {
	tok, ok := bearerToken(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	claims, err := parseToken(tok)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	room := r.URL.Query().Get("room")
	if room == "" {
		room = "general"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("ws upgrade failed", "err", err)
		return
	}

	client := &Client{
		conn:   conn,
		send:   make(chan []byte, 64),
		room:   room,
		userID: claims.UserID,
		email:  claims.Email,
		name:   claims.Name,
	}
	hub.join <- client

	// Send message history on connect
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(50)
		cur, err := msgCol.Find(ctx, bson.M{"room": room}, opts)
		if err == nil {
			var msgs []Message
			cur.All(ctx, &msgs)
			for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
				msgs[i], msgs[j] = msgs[j], msgs[i]
			}
			if msgs == nil {
				msgs = []Message{}
			}
			payload, _ := json.Marshal(map[string]interface{}{"type": "history", "payload": msgs})
			client.send <- payload
		}
	}()

	// Writer goroutine
	go func() {
		defer conn.Close()
		for data := range client.send {
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				break
			}
		}
	}()

	defer func() { hub.leave <- client }()
	conn.SetReadLimit(4096)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	ticker := time.NewTicker(30 * time.Second)
	go func() {
		defer ticker.Stop()
		for range ticker.C {
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var wsMsg WSMessage
		if err := json.Unmarshal(raw, &wsMsg); err != nil {
			continue
		}

		switch wsMsg.Type {
		case "message":
			var body struct {
				Content string `json:"content"`
			}
			json.Unmarshal(raw, &body)
			if body.Content == "" {
				continue
			}
			msg := Message{
				ID:        primitive.NewObjectID(),
				Room:      room,
				UserID:    client.userID,
				Email:     client.email,
				Name:      client.name,
				Content:   body.Content,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			msgCol.InsertOne(ctx, msg)
			cancel()

			messagesSent.Inc()
			publishEvent("message.sent", msg)

			payload, _ := json.Marshal(map[string]interface{}{"type": "message", "payload": msg})
			hub.broadcast(room, payload)

		case "typing":
			payload, _ := json.Marshal(map[string]interface{}{
				"type":    "typing",
				"payload": map[string]string{"name": client.name, "email": client.email},
			})
			hub.broadcast(room, payload)
		}
	}
}

// RabbitMQ
func publishEvent(routingKey string, payload interface{}) {
	if amqpCh == nil {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	err = amqpCh.PublishWithContext(ctx, "verbalyn", routingKey, false, false, amqp.Publishing{
		ContentType:  "application/json",
		Body:         body,
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
	})
	if err != nil {
		slog.Error("amqp publish failed", "err", err)
	}
}

func connectRabbitMQ() {
	//Retry up to 10 times with backoff
	for i := 0; i < 10; i++ {
		conn, err := amqp.Dial(rabbitURL)
		if err != nil {
			slog.Warn("rabbitmq not ready, retrying...", "attempt", i+1, "err", err)
			time.Sleep(time.Duration(i+1) * 2 * time.Second)
			continue
		}
		ch, err := conn.Channel()
		if err != nil {
			conn.Close()
			continue
		}
		// Declare exchange
		err = ch.ExchangeDeclare("verbalyn", "topic", true, false, false, false, nil)
		if err != nil {
			slog.Error("exchange declare failed", "err", err)
			ch.Close()
			conn.Close()
			continue
		}
		amqpCh = ch
		slog.Info("RabbitMQ connected")
		return
	}
	slog.Warn("RabbitMQ unavailable — events will be skipped")
}

func main() {
	// MongoDB
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI))
	if err != nil {
		log.Fatalf("mongo connect: %v", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		log.Fatalf("mongo ping: %v", err)
	}
	msgCol = client.Database("verbalyn").Collection("messages")
	slog.Info("MongoDB connected")

	msgCol.Indexes().CreateOne(context.Background(), mongo.IndexModel{
		Keys: bson.D{{Key: "room", Value: 1}, {Key: "createdAt", Value: -1}},
	})

	// RabbitMQ
	go connectRabbitMQ()

	//Hub
	hub = newHub()
	go hub.run()

	//Router
	r := mux.NewRouter()
	r.Use(func(next http.Handler) http.Handler { return metricsMiddleware(corsMiddleware(next)) })

	r.HandleFunc("/health", healthHandler).Methods(http.MethodGet)
	r.Handle("/metrics", promhttp.Handler()).Methods(http.MethodGet)

	//WebSocket
	r.HandleFunc("/chat/ws", wsHandler).Methods(http.MethodGet)

	//REST
	r.HandleFunc("/chat/messages", authMiddleware(listMessagesHandler)).Methods(http.MethodGet)
	r.HandleFunc("/chat/messages", authMiddleware(sendMessageHandler)).Methods(http.MethodPost)
	r.HandleFunc("/chat/messages/{id}", authMiddleware(editMessageHandler)).Methods(http.MethodPut)
	r.HandleFunc("/chat/messages/{id}", authMiddleware(deleteMessageHandler)).Methods(http.MethodDelete)
	r.HandleFunc("/chat/stats", authMiddleware(statsHandler)).Methods(http.MethodGet)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	slog.Info("chat-service (Go) listening", "port", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
