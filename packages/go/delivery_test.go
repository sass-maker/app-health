package apphealth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// 4.3: ingest outage does not change handler responses; failures are counted
// and silent (fail open).
func TestDelivery_OutageFailOpen(t *testing.T) {
	rs := newRecordingServer()
	rs.status = 500 // every request fails
	c := newTestClient(t, rs, Config{
		MaxRetries: 1,
		RouteResolver: func(*http.Request) string {
			return "/x"
		},
	})

	h := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	}))
	rr := doRequest(t, h, "GET", "/x", nil, nil)
	if rr.Code != 200 || rr.Body.String() != "ok" {
		t.Fatalf("response changed during outage: %d %q", rr.Code, rr.Body.String())
	}

	if !waitFor(t, 3*time.Second, func() bool { return c.Stats().Failed > 0 }) {
		t.Fatalf("expected failed counter > 0, got %+v", c.Stats())
	}
	if c.Stats().Sent != 0 {
		t.Fatalf("expected no successful sends during outage, got %d", c.Stats().Sent)
	}
}

// 4.3: bounded retries eventually succeed and increment the retry counter.
func TestDelivery_RetryThenSuccess(t *testing.T) {
	rs := newRecordingServer()
	rs.failFirst = 2 // first two attempts 500, then 202
	c := newTestClient(t, rs, Config{MaxRetries: 3, BaseBackoff: time.Millisecond})

	c.enqueue(EventV1{
		EventID: newEventID(), Timestamp: c.nowMs(), Method: "GET",
		Route: "/retry", StatusCode: 200, DurationMs: 1,
	})

	if !waitFor(t, 3*time.Second, func() bool { return c.Stats().Sent > 0 }) {
		t.Fatalf("expected eventual success, stats=%+v", c.Stats())
	}
	if c.Stats().Retries < 2 {
		t.Fatalf("expected at least 2 retries, got %d", c.Stats().Retries)
	}
	if len(rs.events()) != 1 {
		t.Fatalf("expected 1 event delivered, got %d", len(rs.events()))
	}
}

// 4.3: retried deliveries replay the identical batch so collector dedupe keyed
// on batch_id absorbs a retry whose earlier attempt actually landed, instead
// of double-counting the events.
func TestDelivery_RetryStableBatchID(t *testing.T) {
	rs := newRecordingServer()
	rs.failFirst = 2 // first two attempts 500, then 202
	c := newTestClient(t, rs, Config{MaxRetries: 3, BaseBackoff: time.Millisecond})

	c.enqueue(EventV1{
		EventID: newEventID(), Timestamp: c.nowMs(), Method: "GET",
		Route: "/retry", StatusCode: 200, DurationMs: 1,
	})

	if !waitFor(t, 3*time.Second, func() bool { return c.Stats().Sent > 0 }) {
		t.Fatalf("expected eventual success, stats=%+v", c.Stats())
	}
	attempts := rs.attemptBodies()
	if len(attempts) != 3 {
		t.Fatalf("expected 3 delivery attempts, got %d", len(attempts))
	}
	ids := make(map[string]bool, len(attempts))
	for _, body := range attempts {
		var batch EventBatchV1
		if err := json.Unmarshal(body, &batch); err != nil {
			t.Fatalf("invalid attempt body: %v", err)
		}
		if batch.BatchID == "" {
			t.Fatal("retry batch must have a nonempty deduplication ID")
		}
		if !bytes.Equal(body, attempts[0]) {
			t.Fatal("retry must preserve the complete batch payload")
		}
		ids[batch.BatchID] = true
	}
	if len(ids) != 1 {
		t.Fatalf("expected one stable batch_id across retries, got %d", len(ids))
	}
}

// 4.3: queue overflow drops telemetry without blocking and increments the
// dropped counter.
func TestDelivery_OverflowDrops(t *testing.T) {
	rs := newRecordingServer()
	rs.blockCh = make(chan struct{})
	c := newTestClient(t, rs, Config{QueueSize: 4, BatchSize: 2, MaxRetries: 0})

	// Block the delivery goroutine so the queue fills.
	// Enqueue well beyond the queue capacity; drops must be non-blocking.
	for i := 0; i < 50; i++ {
		c.enqueue(EventV1{
			EventID: newEventID(), Timestamp: c.nowMs(), Method: "GET",
			Route: "/overflow", StatusCode: 200, DurationMs: 1,
		})
	}
	if c.Stats().Dropped == 0 {
		t.Fatalf("expected drops when queue is full, got %+v", c.Stats())
	}
	// Enqueuing must not have blocked: the loop above returned.

	// Release the server and close; remaining queued events are delivered.
	close(rs.blockCh)
	ctx, cancel := contextWithTimeout(3 * time.Second)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// 4.3: Close flushes all pending events before returning.
func TestDelivery_CloseFlushes(t *testing.T) {
	rs := newRecordingServer()
	// Use a fresh client without the auto-close cleanup by building manually.
	srv := httptest.NewServer(rs.handler())
	defer srv.Close()

	c := New(Config{
		IngestURL:     srv.URL,
		IngestKey:     "k",
		QueueSize:     128,
		BatchSize:     16,
		FlushInterval: time.Hour, // disable timer-based flush
		Timeout:       time.Second,
		MaxRetries:    1,
		BaseBackoff:   time.Millisecond,
	})

	for i := 0; i < 40; i++ {
		c.enqueue(EventV1{
			EventID: newEventID(), Timestamp: c.nowMs(), Method: "GET",
			Route: "/close", StatusCode: 200, DurationMs: 1,
		})
	}
	ctx, cancel := contextWithTimeout(3 * time.Second)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	if len(rs.events()) != 40 {
		t.Fatalf("expected 40 events flushed on close, got %d", len(rs.events()))
	}
}

// 4.3: Flush synchronously delivers the queue and the loop's partial batch
// without closing the client.
func TestDelivery_FlushDrains(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{
		QueueSize:     64,
		BatchSize:     32,
		FlushInterval: time.Hour,
		MaxRetries:    0,
	})

	for i := 0; i < 10; i++ {
		c.enqueue(EventV1{
			EventID: newEventID(), Timestamp: c.nowMs(), Method: "GET",
			Route: "/flush", StatusCode: 200, DurationMs: 1,
		})
	}
	if !waitFor(t, time.Second, func() bool { return c.Stats().Queued == 0 }) {
		t.Fatalf("delivery loop did not consume queued events")
	}
	if got := len(rs.events()); got != 0 {
		t.Fatalf("expected events to remain in the partial batch before Flush, got %d", got)
	}
	ctx, cancel := contextWithTimeout(3 * time.Second)
	defer cancel()
	if err := c.Flush(ctx); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if got := len(rs.events()); got != 10 {
		t.Fatalf("expected Flush to deliver all 10 events, got %d", got)
	}
	// Client still usable after Flush.
	if c.closed.Load() {
		t.Fatal("client should not be closed after Flush")
	}
}

// 4.3: a second Close call is a no-op and returns the first error (nil here).
func TestDelivery_CloseIdempotent(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{})
	// The test cleanup also closes; call once explicitly and expect no panic.
	ctx, cancel := contextWithTimeout(time.Second)
	defer cancel()
	_ = c.Close(ctx)
	// Second close via cleanup must not panic or hang.
}

// Repeated Close calls return the exact first error, even after the delivery
// goroutine subsequently finishes.
func TestDelivery_CloseReturnsFirstError(t *testing.T) {
	rs := newRecordingServer()
	rs.blockCh = make(chan struct{})
	c := newTestClient(t, rs, Config{BatchSize: 1, Timeout: time.Second})
	c.enqueue(EventV1{
		EventID: newEventID(), Timestamp: c.nowMs(), Method: "GET",
		Route: "/close-error", StatusCode: 200, DurationMs: 1,
	})
	if !waitFor(t, time.Second, func() bool { return c.Stats().Queued == 0 }) {
		t.Fatal("delivery loop did not consume event")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	first := c.Close(ctx)
	if !errors.Is(first, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", first)
	}
	second := c.Close(context.Background())
	if second != first {
		t.Fatalf("expected repeated Close to return the same error: first=%v second=%v", first, second)
	}

	close(rs.blockCh)
	select {
	case <-c.done:
	case <-time.After(2 * time.Second):
		t.Fatal("delivery goroutine did not finish after server unblocked")
	}
	if third := c.Close(context.Background()); third != first {
		t.Fatalf("expected first error after shutdown completed: first=%v third=%v", first, third)
	}
}

// 4.1: the Authorization header carries the ingest key and the batch carries
// the go runtime and schema version.
func TestDelivery_AuthAndSchema(t *testing.T) {
	rs := newRecordingServer()
	var gotAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		body, _ := io.ReadAll(r.Body)
		rs.mu.Lock()
		rs.bodies = append(rs.bodies, body)
		rs.mu.Unlock()
		w.WriteHeader(202)
	}))
	defer srv.Close()

	c := New(Config{
		IngestURL:     srv.URL,
		IngestKey:     "secret-key-123",
		Environment:   "local",
		QueueSize:     16,
		BatchSize:     4,
		FlushInterval: 20 * time.Millisecond,
		Timeout:       time.Second,
		MaxRetries:    0,
		BaseBackoff:   time.Millisecond,
	})
	c.enqueue(EventV1{
		EventID: newEventID(), Timestamp: c.nowMs(), Method: "GET",
		Route: "/auth", StatusCode: 200, DurationMs: 1,
	})
	if !waitFor(t, 2*time.Second, func() bool { return len(rs.batchBodies()) >= 1 }) {
		t.Fatalf("expected a batch")
	}
	if got, _ := gotAuth.Load().(string); got != "Bearer secret-key-123" {
		t.Fatalf("expected bearer auth, got %q", got)
	}
	var batch EventBatchV1
	if err := jsonStrictUnmarshal(rs.batchBodies()[0], &batch); err != nil {
		t.Fatalf("invalid batch: %v", err)
	}
	if batch.SchemaVersion != SchemaVersion {
		t.Fatalf("expected schema %q, got %q", SchemaVersion, batch.SchemaVersion)
	}
	if batch.Runtime != RuntimeGo {
		t.Fatalf("expected runtime %q, got %q", RuntimeGo, batch.Runtime)
	}
	if batch.Environment != "local" {
		t.Fatalf("expected environment %q, got %q", "local", batch.Environment)
	}
	ctx, cancel := contextWithTimeout(2 * time.Second)
	defer cancel()
	_ = c.Close(ctx)
}
