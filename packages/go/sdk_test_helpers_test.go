package apphealth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// recordingServer is a test ingest endpoint that records every batch body it
// receives and can be programmed to return a fixed status, fail leading
// requests, or block until released.
type recordingServer struct {
	mu        sync.Mutex
	bodies    [][]byte
	attempts  [][]byte
	status    int
	blockCh   chan struct{}
	delay     time.Duration
	failFirst int // number of leading requests to fail with status 500
	seen      int
}

func newRecordingServer() *recordingServer {
	return &recordingServer{status: 202}
}

func (s *recordingServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if s.delay > 0 {
			time.Sleep(s.delay)
		}
		if s.blockCh != nil {
			<-s.blockCh
		}
		s.mu.Lock()
		s.seen++
		cur := s.seen
		s.attempts = append(s.attempts, body)
		status := s.status
		if s.failFirst > 0 && cur <= s.failFirst {
			status = 500
		}
		if status >= 200 && status < 300 {
			s.bodies = append(s.bodies, body)
		}
		s.mu.Unlock()
		w.WriteHeader(status)
	})
}

func (s *recordingServer) events() []EventV1 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []EventV1
	for _, b := range s.bodies {
		var batch EventBatchV1
		if err := json.Unmarshal(b, &batch); err != nil {
			continue
		}
		out = append(out, batch.Events...)
	}
	return out
}

func (s *recordingServer) batchBodies() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([][]byte, len(s.bodies))
	copy(cp, s.bodies)
	return cp
}

// attemptBodies returns every delivered payload including ones the server
// rejected, so tests can inspect retry replays.
func (s *recordingServer) attemptBodies() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([][]byte, len(s.attempts))
	copy(cp, s.attempts)
	return cp
}

// newTestClient builds a Client pointing at rs with fast, deterministic
// delivery tunables suitable for tests. The ingest key defaults to "test-key".
func newTestClient(t *testing.T, rs *recordingServer, cfg Config) *Client {
	t.Helper()
	srv := httptest.NewServer(rs.handler())
	t.Cleanup(srv.Close)
	if cfg.IngestURL == "" {
		cfg.IngestURL = srv.URL
	}
	if cfg.IngestKey == "" {
		cfg.IngestKey = "test-key"
	}
	if cfg.QueueSize == 0 {
		cfg.QueueSize = 64
	}
	if cfg.BatchSize == 0 {
		cfg.BatchSize = 8
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 20 * time.Millisecond
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = time.Second
	}
	if cfg.BaseBackoff == 0 {
		cfg.BaseBackoff = time.Millisecond
	}
	c := New(cfg)
	t.Cleanup(func() {
		ctx, cancel := contextWithTimeout(2 * time.Second)
		defer cancel()
		_ = c.Close(ctx)
	})
	return c
}

func doRequest(t *testing.T, h http.Handler, method, target string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// waitFor calls cond until it returns true or the timeout elapses.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return cond()
}

func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}
