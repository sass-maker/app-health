package apphealth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Default tunables for the Go SDK delivery pipeline. They are deliberately
// small to keep request-path work bounded and to fail open fast.
const (
	DefaultQueueSize     = 1024
	DefaultBatchSize     = 100
	DefaultFlushInterval = 5 * time.Second
	DefaultTimeout       = 3 * time.Second
	DefaultMaxRetries    = 3
	DefaultBaseBackoff   = 200 * time.Millisecond
)

// Config configures a Go SDK Client.
//
// IngestURL is the fully-qualified v1 ingest endpoint
// (e.g. "http://localhost:8787/v1/ingest"). IngestKey is the product ingest
// key supplied by the operator. Environment routes the batch beneath that
// product. Release is an optional release tag attached to every batch.
//
// All tunable fields default to sane values when zero, so a minimal
// installation only needs IngestURL and IngestKey.
type Config struct {
	IngestURL   string
	IngestKey   string
	Project     string
	Environment string
	Release     string

	QueueSize     int
	BatchSize     int
	FlushInterval time.Duration
	Timeout       time.Duration
	MaxRetries    int
	BaseBackoff   time.Duration

	// HTTPClient overrides the default *http.Client used for delivery. If nil,
	// a client with the configured Timeout is used. Tests may inject a fake
	// transport here.
	HTTPClient *http.Client

	// RouteResolver optionally resolves a normalized route template for
	// third-party routers. Return "" to use an available ServeMux pattern; if
	// neither exists, the event is dropped rather than using a concrete path.
	RouteResolver RouteResolver

	// Now overrides the wall-clock source for event timestamps. Defaults to
	// time.Now. Tests may inject a deterministic clock.
	Now func() time.Time
}

// Client is the Go SDK entry point. It owns a bounded async delivery pipeline
// and exposes net/http middleware. Client is safe for concurrent use.
type Client struct {
	cfg Config

	queue chan EventV1
	flush chan chan struct{}
	stop  chan struct{}
	done  chan struct{}

	httpClient *http.Client
	now        func() time.Time

	// Diagnostic counters, read via Stats. All updates use atomic ops.
	dropped     atomic.Int64
	sent        atomic.Int64
	failed      atomic.Int64
	retries     atomic.Int64
	batchesSent atomic.Int64

	closeOnce sync.Once
	closeErr  error
	closed    atomic.Bool
}

// Stats reports local diagnostic counters. These are best-effort and never
// affect application behavior.
type Stats struct {
	Queued      int
	Dropped     int64
	Sent        int64
	Failed      int64
	Retries     int64
	BatchesSent int64
}

// RecordInput is the framework-neutral endpoint summary accepted by Record.
// Route must be a framework route template such as "/users/:id", never a
// concrete URL. Query strings and fragments are rejected to protect privacy.
type RecordInput struct {
	Method     string
	Route      string
	StatusCode int
	Duration   time.Duration
	Timestamp  time.Time
	// ResponseBytes is the response payload size in bytes, or nil when the
	// size was not measured. The value is a byte count, never response content.
	ResponseBytes *int64
}

// New creates and starts a Client. The background delivery goroutine begins
// flushing immediately. Use Close to flush pending telemetry and stop the
// goroutine.
func New(cfg Config) *Client {
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = DefaultBatchSize
	}
	if cfg.BatchSize > MaxBatchEvents {
		cfg.BatchSize = MaxBatchEvents
	}
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = DefaultFlushInterval
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = DefaultMaxRetries
	}
	if cfg.BaseBackoff <= 0 {
		cfg.BaseBackoff = DefaultBaseBackoff
	}
	cfg.Release = normalizeRelease(cfg.Release)
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: cfg.Timeout}
	}

	c := &Client{
		cfg:        cfg,
		queue:      make(chan EventV1, cfg.QueueSize),
		flush:      make(chan chan struct{}),
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		httpClient: hc,
		now:        now,
	}
	go c.loop()
	return c
}

// enqueue records a single endpoint summary. It never blocks the request path:
// if the bounded queue is full the event is dropped and the dropped counter is
// incremented. Drops are silent by design.
func (c *Client) enqueue(ev EventV1) {
	if c.closed.Load() {
		c.dropped.Add(1)
		return
	}
	select {
	case c.queue <- ev:
	default:
		c.dropped.Add(1)
	}
}

// Record validates and queues one endpoint summary without blocking the
// request path. Invalid input and events received after Close are dropped and
// reflected in Stats. Record never reads or accepts headers, query values,
// route parameters, bodies, cookies, or identity.
func (c *Client) Record(input RecordInput) {
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	route := normalizeRouteTemplate(input.Route)
	if !isHTTPMethod(method) || route == "" ||
		input.StatusCode < MinStatusCode || input.StatusCode > MaxStatusCode ||
		input.Duration < 0 {
		c.dropped.Add(1)
		return
	}

	durationMs := int(input.Duration.Milliseconds())
	if durationMs > MaxDurationMs {
		durationMs = MaxDurationMs
	}
	timestamp := input.Timestamp
	if timestamp.IsZero() {
		timestamp = c.now()
	}

	event := EventV1{
		EventID:    newEventID(),
		Timestamp:  timestamp.UnixMilli(),
		Method:     method,
		Route:      route,
		StatusCode: input.StatusCode,
		DurationMs: durationMs,
	}
	if input.ResponseBytes != nil && *input.ResponseBytes >= 0 && *input.ResponseBytes <= MaxResponseBytes {
		bytes := *input.ResponseBytes
		event.ResponseBytes = &bytes
	}
	if release := c.cfg.Release; release != "" {
		event.Release = &release
	}
	c.enqueue(event)
}

// loop is the single delivery goroutine. It batches events by size or time and
// delivers each batch with bounded retries. It exits when Close is called or
// the context used by Close is cancelled.
func (c *Client) loop() {
	defer close(c.done)

	batch := make([]EventV1, 0, c.cfg.BatchSize)
	flushTimer := time.NewTimer(c.cfg.FlushInterval)
	defer flushTimer.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		c.deliverBatch(batch)
		batch = batch[:0]
	}

	for {
		select {
		case <-c.stop:
			// Drain any remaining queued events, then flush the in-flight batch.
			for {
				select {
				case ev := <-c.queue:
					batch = append(batch, ev)
					if len(batch) >= c.cfg.BatchSize {
						flush()
					}
				default:
					flush()
					return
				}
			}
		case ev := <-c.queue:
			batch = append(batch, ev)
			if len(batch) >= c.cfg.BatchSize {
				flush()
				if !flushTimer.Stop() {
					select {
					case <-flushTimer.C:
					default:
					}
				}
				flushTimer.Reset(c.cfg.FlushInterval)
			}
		case <-flushTimer.C:
			flush()
			flushTimer.Reset(c.cfg.FlushInterval)
		case flushed := <-c.flush:
			// Drain everything already accepted into the queue, then deliver the
			// partial batch before acknowledging the synchronous flush request.
			draining := true
			for draining {
				select {
				case ev := <-c.queue:
					batch = append(batch, ev)
					if len(batch) >= c.cfg.BatchSize {
						flush()
					}
				default:
					draining = false
				}
			}
			flush()
			close(flushed)
		}
	}
}

// deliverBatch sends one batch to ingest with bounded retries. Retries use an
// exponential backoff capped at BaseBackoff*2^MaxRetries. All failures are
// counted; the final failure is silent (fail open).
func (c *Client) deliverBatch(events []EventV1) {
	batch := c.buildBatch(events)
	body, err := json.Marshal(batch)
	if err != nil {
		c.failed.Add(int64(len(events)))
		return
	}

	deadline := c.cfg.Timeout
	for attempt := 0; attempt <= c.cfg.MaxRetries; attempt++ {
		if attempt > 0 {
			c.retries.Add(1)
			backoff := c.cfg.BaseBackoff << (attempt - 1)
			// Cap backoff to a sane maximum to avoid very long sleeps.
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			select {
			case <-c.stop:
				return
			case <-time.After(backoff):
			}
		}
		if c.sendOnce(body, deadline) {
			c.sent.Add(int64(len(events)))
			c.batchesSent.Add(1)
			return
		}
	}
	c.failed.Add(int64(len(events)))
}

func (c *Client) buildBatch(events []EventV1) EventBatchV1 {
	out := EventBatchV1{
		BatchID:       newEventID(),
		SchemaVersion: SchemaVersion,
		Runtime:       RuntimeGo,
		Environment:   strings.ToLower(strings.TrimSpace(c.cfg.Environment)),
		Events:        events,
	}
	if r := c.cfg.Release; r != "" {
		// Copy so the slice backing the batch is not shared with the caller.
		rr := r
		out.Release = &rr
	}
	return out
}

// sendOnce performs a single POST. It returns true on a 2xx response.
func (c *Client) sendOnce(body []byte, timeout time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.IngestURL, bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.IngestKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.IngestKey)
	}
	req.Header.Set("User-Agent", "app-health-go/1")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

// Flush blocks until all currently-queued events have been delivered or the
// context is cancelled. It does not close the Client. Flush is best-effort:
// delivery failures are still silent (fail open).
func (c *Client) Flush(ctx context.Context) error {
	if c.closed.Load() {
		return errors.New("apphealth: client closed")
	}
	flushed := make(chan struct{})
	select {
	case c.flush <- flushed:
	case <-c.done:
		return errors.New("apphealth: client closed")
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-flushed:
		return nil
	case <-c.done:
		return errors.New("apphealth: client closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close stops accepting new events, flushes all pending events with the given
// timeout, and stops the delivery goroutine. Calling Close more than once
// returns the first error.
func (c *Client) Close(ctx context.Context) error {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		close(c.stop)
		select {
		case <-c.done:
		case <-ctx.Done():
			c.closeErr = fmt.Errorf("apphealth: close timed out: %w", ctx.Err())
		}
	})
	return c.closeErr
}

// Stats returns a snapshot of local diagnostic counters. Queued is the
// approximate number of events waiting in the bounded queue.
func (c *Client) Stats() Stats {
	return Stats{
		Queued:      len(c.queue),
		Dropped:     c.dropped.Load(),
		Sent:        c.sent.Load(),
		Failed:      c.failed.Load(),
		Retries:     c.retries.Load(),
		BatchesSent: c.batchesSent.Load(),
	}
}

// now returns the current wall clock in milliseconds.
func (c *Client) nowMs() int64 {
	return c.now().UnixMilli()
}
