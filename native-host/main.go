package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	hostName          = "com.webomni.lan"
	protocol          = 2
	maxNativeBytes    = 1024 * 1024
	maxRelayBytes     = 2 * 1024 * 1024
	idleTimeout       = 5 * time.Minute
	idleCheckInterval = 15 * time.Second
)

//go:embed web/*
var webFiles embed.FS

type descriptor struct {
	Type               string   `json:"type"`
	OK                 bool     `json:"ok"`
	Version            int      `json:"version"`
	Host               string   `json:"host"`
	PageURL            string   `json:"pageUrl"`
	RelayURL           string   `json:"relayUrl"`
	PrivateIPs         []string `json:"privateIps"`
	BindAddress        string   `json:"bindAddress"`
	MobileReachable    bool     `json:"mobileReachable"`
	IdleTimeoutSeconds int      `json:"idleTimeoutSeconds,omitempty"`
	Notice             string   `json:"notice,omitempty"`
	Error              string   `json:"error,omitempty"`
}

type nativeRequest struct {
	Type string `json:"type"`
}

type relayClient struct {
	role string
	conn *websocket.Conn
	send chan []byte
}

type relayRoom struct {
	desktop *relayClient
	mobile  *relayClient
	pending map[string][][]byte
}

type relayHub struct {
	mu    sync.Mutex
	rooms map[string]*relayRoom
}

type nativeInput struct {
	request nativeRequest
	err     error
}

type activityTracker struct {
	mu     sync.Mutex
	now    func() time.Time
	last   time.Time
	active int
}

func newActivityTracker(now func() time.Time) *activityTracker {
	return &activityTracker{now: now, last: now()}
}

func (a *activityTracker) touch() {
	a.mu.Lock()
	a.last = a.now()
	a.mu.Unlock()
}

func (a *activityTracker) begin() func() {
	a.mu.Lock()
	a.active++
	a.last = a.now()
	a.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			if a.active > 0 {
				a.active--
			}
			a.last = a.now()
			a.mu.Unlock()
		})
	}
}

func (a *activityTracker) isIdle(at time.Time, timeout time.Duration) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.active == 0 && !at.Before(a.last) && at.Sub(a.last) >= timeout
}

func main() {
	logger := log.New(os.Stderr, "web-omni-lan-helper: ", log.LstdFlags|log.LUTC)
	token, err := randomToken(32)
	if err != nil {
		writeNative(os.Stdout, descriptor{Type: "ready", OK: false, Version: protocol, Host: hostName, Error: err.Error()})
		return
	}

	addresses := privateIPv4Addresses()
	bindAddress, mobileReachable := selectBindAddress(addresses)
	listener, err := net.Listen("tcp4", net.JoinHostPort(bindAddress, "0"))
	if err != nil {
		writeNative(os.Stdout, descriptor{Type: "ready", OK: false, Version: protocol, Host: hostName, Error: err.Error()})
		return
	}
	port := listener.Addr().(*net.TCPAddr).Port
	notice := ""
	if !mobileReachable {
		notice = "No private IPv4 address is available; this session is reachable only from this computer."
	}

	activity := newActivityTracker(time.Now)
	hub := &relayHub{rooms: make(map[string]*relayRoom)}
	server := &http.Server{
		Handler:           withActivity(activity, newHandler(token, hub, logger)),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       45 * time.Second,
	}
	serverDone := make(chan error, 1)
	go func() {
		serveErr := server.Serve(listener)
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		serverDone <- serveErr
	}()

	base := fmt.Sprintf("http://%s:%d/", bindAddress, port)
	relay := fmt.Sprintf("ws://%s:%d/v2/ws?token=%s", bindAddress, port, token)
	ready := descriptor{
		Type:               "ready",
		OK:                 true,
		Version:            protocol,
		Host:               hostName,
		PageURL:            base,
		RelayURL:           relay,
		PrivateIPs:         addresses,
		BindAddress:        bindAddress,
		MobileReachable:    mobileReachable,
		IdleTimeoutSeconds: int(idleTimeout / time.Second),
		Notice:             notice,
	}
	if err := writeNative(os.Stdout, ready); err != nil {
		logger.Printf("native ready response failed: %v", err)
	}

	inputs := make(chan nativeInput, 1)
	go readNativeInputs(bufio.NewReader(os.Stdin), inputs)
	idleTicker := time.NewTicker(idleCheckInterval)
	defer idleTicker.Stop()

	running := true
	for running {
		select {
		case input, open := <-inputs:
			if !open {
				running = false
				continue
			}
			if input.err != nil {
				if !errors.Is(input.err, io.EOF) {
					logger.Printf("native request failed: %v", input.err)
				}
				running = false
				continue
			}
			activity.touch()
			switch input.request.Type {
			case "status", "start", "":
				_ = writeNative(os.Stdout, ready)
			case "stop":
				_ = writeNative(os.Stdout, descriptor{Type: "stopped", OK: true, Version: protocol, Host: hostName})
				running = false
			default:
				_ = writeNative(os.Stdout, descriptor{Type: "error", OK: false, Version: protocol, Host: hostName, Error: "unsupported request"})
			}
		case now := <-idleTicker.C:
			if activity.isIdle(now, idleTimeout) {
				logger.Printf("idle for %s; shutting down", idleTimeout)
				running = false
			}
		case serveErr := <-serverDone:
			if serveErr != nil {
				logger.Printf("HTTP server stopped: %v", serveErr)
			}
			running = false
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func readNativeInputs(reader io.Reader, inputs chan<- nativeInput) {
	defer close(inputs)
	for {
		var request nativeRequest
		if err := readNative(reader, &request); err != nil {
			inputs <- nativeInput{err: err}
			return
		}
		inputs <- nativeInput{request: request}
	}
}

func withActivity(activity *activityTracker, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		end := activity.begin()
		defer end()
		next.ServeHTTP(w, r)
	})
}

func newHandler(token string, hub *relayHub, logger *log.Logger) http.Handler {
	mux := http.NewServeMux()
	staticFS, _ := fs.Sub(webFiles, "web")
	fileServer := http.FileServer(http.FS(staticFS))
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": protocol})
	})
	mux.HandleFunc("/v2/ws", func(w http.ResponseWriter, r *http.Request) {
		if !sameToken(token, r.URL.Query().Get("token")) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		session := r.URL.Query().Get("session")
		role := r.URL.Query().Get("role")
		if !validSession(session) || (role != "desktop" && role != "mobile") {
			http.Error(w, "invalid relay parameters", http.StatusBadRequest)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			logger.Printf("websocket accept failed: %v", err)
			return
		}
		conn.SetReadLimit(maxRelayBytes)
		hub.serve(r.Context(), session, role, conn)
	})
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss: https:")
		fileServer.ServeHTTP(w, r)
	}))
	return mux
}

func (h *relayHub) serve(ctx context.Context, session, role string, conn *websocket.Conn) {
	client := &relayClient{role: role, conn: conn, send: make(chan []byte, 32)}
	pending := h.join(session, client)
	defer h.leave(session, client)

	writeCtx, cancelWrite := context.WithCancel(ctx)
	defer cancelWrite()
	go func() {
		for message := range client.send {
			writeTimeout, cancel := context.WithTimeout(writeCtx, 10*time.Second)
			err := client.conn.Write(writeTimeout, websocket.MessageText, message)
			cancel()
			if err != nil {
				cancelWrite()
				return
			}
		}
	}()
	for _, message := range pending {
		select {
		case client.send <- message:
		default:
			return
		}
	}

	for {
		messageType, message, err := conn.Read(writeCtx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageText || len(message) == 0 || len(message) > maxRelayBytes {
			_ = conn.Close(websocket.StatusUnsupportedData, "text frames only")
			return
		}
		if !h.forward(session, role, message) {
			continue
		}
	}
}

func (h *relayHub) join(session string, client *relayClient) [][]byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[session]
	if room == nil {
		room = &relayRoom{pending: map[string][][]byte{"desktop": {}, "mobile": {}}}
		h.rooms[session] = room
	}
	if client.role == "desktop" {
		if room.desktop != nil {
			_ = room.desktop.conn.Close(websocket.StatusPolicyViolation, "replaced")
		}
		room.desktop = client
	} else {
		if room.mobile != nil {
			_ = room.mobile.conn.Close(websocket.StatusPolicyViolation, "replaced")
		}
		room.mobile = client
	}
	pending := room.pending[client.role]
	room.pending[client.role] = nil
	return pending
}

func (h *relayHub) forward(session, fromRole string, message []byte) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[session]
	if room == nil {
		return false
	}
	targetRole := "mobile"
	target := room.mobile
	if fromRole == "mobile" {
		targetRole = "desktop"
		target = room.desktop
	}
	copyOfMessage := append([]byte(nil), message...)
	if target == nil {
		if len(room.pending[targetRole]) < 16 {
			room.pending[targetRole] = append(room.pending[targetRole], copyOfMessage)
		}
		return false
	}
	select {
	case target.send <- copyOfMessage:
		return true
	default:
		return false
	}
}

func (h *relayHub) leave(session string, client *relayClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[session]
	if room == nil {
		return
	}
	if room.desktop == client {
		room.desktop = nil
	}
	if room.mobile == client {
		room.mobile = nil
	}
	close(client.send)
	if room.desktop == nil && room.mobile == nil {
		delete(h.rooms, session)
	}
}

func privateIPv4Addresses() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := make(map[string]bool)
	var output []string
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp == 0 || networkInterface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := networkInterface.Addrs()
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err != nil || ip.To4() == nil || !ip.IsPrivate() {
				continue
			}
			value := ip.String()
			if !seen[value] {
				seen[value] = true
				output = append(output, value)
			}
		}
	}
	return output
}

func selectBindAddress(addresses []string) (string, bool) {
	if len(addresses) == 0 {
		return "127.0.0.1", false
	}
	return addresses[0], true
}

func randomToken(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func sameToken(expected, actual string) bool {
	if len(expected) != len(actual) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

func validSession(value string) bool {
	if len(value) < 16 || len(value) > 128 || strings.ContainsAny(value, " /\\?&#") {
		return false
	}
	return true
}

func readNative(reader io.Reader, target any) error {
	var size uint32
	if err := binary.Read(reader, binary.LittleEndian, &size); err != nil {
		return err
	}
	if size == 0 || size > maxNativeBytes {
		return fmt.Errorf("invalid native message size: %d", size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return err
	}
	return json.Unmarshal(payload, target)
}

func writeNative(writer io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) > maxNativeBytes {
		return errors.New("native response is too large")
	}
	if err := binary.Write(writer, binary.LittleEndian, uint32(len(payload))); err != nil {
		return err
	}
	_, err = writer.Write(payload)
	return err
}
