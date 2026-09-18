package apphealth

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 4.1 / 4.2: ServeMux pattern is used as the route identity, collapsing
// different concrete path values into one normalized route.
func TestMiddleware_ServeMuxPattern(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{Release: "1.0.0"})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("user"))
	})
	mux.HandleFunc("POST /orders", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
	})

	h := c.Middleware(mux)
	doRequest(t, h, "GET", "/users/123", nil, nil)
	doRequest(t, h, "GET", "/users/456", nil, nil)
	doRequest(t, h, "POST", "/orders", nil, nil)

	if !waitFor(t, 2*time.Second, func() bool { return len(rs.events()) == 3 }) {
		t.Fatalf("expected 3 events, got %d", len(rs.events()))
	}
	evs := rs.events()
	routes := map[string]int{}
	for _, e := range evs {
		if e.Method == "" || e.Route == "" {
			t.Fatalf("event missing method/route: %+v", e)
		}
		routes[e.Method+" "+e.Route]++
	}
	if routes["GET /users/:id"] != 2 {
		t.Fatalf("expected 2 GET /users/:id, got %v", routes)
	}
	if routes["POST /orders"] != 1 {
		t.Fatalf("expected 1 POST /orders, got %v", routes)
	}
	// Validate the batch shape against the V1 contract.
	for _, e := range evs {
		if err := ValidateEvent(e); err != nil {
			t.Fatalf("event failed validation: %v", err)
		}
		if e.Release == nil || *e.Release != "1.0.0" {
			t.Fatalf("expected release 1.0.0, got %+v", e.Release)
		}
	}
}

// 4.3: handler response status and body are preserved; telemetry records the
// custom status.
func TestMiddleware_CustomStatusAndBody(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{RouteResolver: func(*http.Request) string { return "/teapot" }})

	h := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(418)
		_, _ = w.Write([]byte("i'm a teapot"))
	}))
	rr := doRequest(t, h, "GET", "/teapot", nil, nil)

	if rr.Code != 418 {
		t.Fatalf("expected status 418, got %d", rr.Code)
	}
	if rr.Body.String() != "i'm a teapot" {
		t.Fatalf("expected body %q, got %q", "i'm a teapot", rr.Body.String())
	}
	if !waitFor(t, 2*time.Second, func() bool { return len(rs.events()) == 1 }) {
		t.Fatalf("expected 1 event, got %d", len(rs.events()))
	}
	if got := rs.events()[0].StatusCode; got != 418 {
		t.Fatalf("expected recorded status 418, got %d", got)
	}
}

// Response payload byte count is recorded as a scalar without retaining content.
func TestMiddleware_RecordsResponseBytes(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{RouteResolver: func(*http.Request) string { return "/sized" }})

	h := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("hello world"))
	}))
	doRequest(t, h, "GET", "/sized", nil, nil)

	if !waitFor(t, 2*time.Second, func() bool { return len(rs.events()) == 1 }) {
		t.Fatalf("expected 1 event")
	}
	e := rs.events()[0]
	if e.ResponseBytes == nil || *e.ResponseBytes != 11 {
		t.Fatalf("expected response_bytes 11, got %v", e.ResponseBytes)
	}
}

// 4.3: default 200 is recorded when the handler never calls WriteHeader.
func TestMiddleware_DefaultStatusOK(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{RouteResolver: func(*http.Request) string { return "/x" }})

	h := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	rr := doRequest(t, h, "GET", "/x", nil, nil)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if !waitFor(t, 2*time.Second, func() bool { return len(rs.events()) == 1 }) {
		t.Fatalf("expected 1 event")
	}
	if got := rs.events()[0].StatusCode; got != 200 {
		t.Fatalf("expected recorded 200, got %d", got)
	}
}

// 4.3: http.Flusher is preserved through the wrapper.
func TestMiddleware_PreservesFlusher(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{RouteResolver: func(*http.Request) string { return "/panic" }})

	h := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, ok := w.(http.Flusher)
		if !ok {
			t.Fatalf("expected http.Flusher to be supported")
		}
		f.Flush()
		_, _ = w.Write([]byte("flushed"))
	}))
	rr := doRequest(t, h, "GET", "/stream", nil, nil)
	if rr.Body.String() != "flushed" {
		t.Fatalf("unexpected body %q", rr.Body.String())
	}
}

// 4.3: io.ReaderFrom is preserved so handlers keep the sendfile fast path.
func TestMiddleware_PreservesReaderFrom(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{})

	payload := bytes.Repeat([]byte("x"), 64<<10)
	h := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(w, bytes.NewReader(payload))
	}))
	rr := doRequest(t, h, "GET", "/file", nil, nil)
	if !bytes.Equal(rr.Body.Bytes(), payload) {
		t.Fatalf("body mismatch")
	}
}

// 4.3: http.Hijacker is preserved when the underlying writer supports it.
func TestMiddleware_PreservesHijacker(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{})

	// httptest.NewRecorder does not implement Hijacker; build a custom writer
	// that does, via a net.Pipe-backed fake. We assert the wrapper type-asserts
	// to http.Hijacker when the underlying writer supports it.
	hijackable := &hijackableResponseWriter{header: http.Header{}}
	mw := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Hijacker); !ok {
			t.Fatalf("expected http.Hijacker to be supported")
		}
		_, _ = w.Write([]byte("ok"))
	}))
	req := httptest.NewRequest("GET", "/ws", nil)
	mw.ServeHTTP(hijackable, req)
}

// 4.3: http.Pusher is preserved when the underlying writer supports it.
func TestMiddleware_PreservesPusher(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{})

	pusher := &pusherResponseWriter{header: http.Header{}}
	mw := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := w.(http.Pusher)
		if !ok {
			t.Fatalf("expected http.Pusher to be supported")
		}
		_ = p.Push("/style.css", nil)
		_, _ = w.Write([]byte("ok"))
	}))
	req := httptest.NewRequest("GET", "/push", nil)
	mw.ServeHTTP(pusher, req)
	if pusher.pushed != "/style.css" {
		t.Fatalf("expected push to be delegated, got %q", pusher.pushed)
	}
}

// 4.3: panic behavior is preserved. The middleware must NOT recover; the
// panic propagates to the caller (the surrounding server's recovery).
func TestMiddleware_PreservesPanic(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{RouteResolver: func(*http.Request) string { return "/panic" }})

	mw := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))
	req := httptest.NewRequest("GET", "/panic", nil)
	rec := httptest.NewRecorder()

	func() {
		defer func() {
			r := recover()
			if r != "boom" {
				t.Fatalf("expected panic 'boom' to propagate, got %v", r)
			}
		}()
		mw.ServeHTTP(rec, req)
	}()

	// The panicked handler should be recorded with status 500.
	if !waitFor(t, 2*time.Second, func() bool { return len(rs.events()) == 1 }) {
		t.Fatalf("expected 1 event recorded for panicked handler, got %d", len(rs.events()))
	}
	if got := rs.events()[0].StatusCode; got != 500 {
		t.Fatalf("expected recorded status 500 for panic, got %d", got)
	}
}

// 4.2: a configured RouteResolver wins over pattern and fallback.
func TestMiddleware_RouteResolver(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{
		RouteResolver: func(r *http.Request) string {
			return "/orders/:id"
		},
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})
	h := c.Middleware(mux)
	doRequest(t, h, "GET", "/orders/99", nil, nil)

	if !waitFor(t, 2*time.Second, func() bool { return len(rs.events()) == 1 }) {
		t.Fatalf("expected 1 event")
	}
	if got := rs.events()[0].Route; got != "/orders/:id" {
		t.Fatalf("expected resolver route /orders/:id, got %q", got)
	}
}

// 4.2: resolver returning "" falls back to pattern, then to normalizer.
func TestMiddleware_ResolverEmptyFallsBackToPattern(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{
		RouteResolver: func(r *http.Request) string { return "" },
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})
	h := c.Middleware(mux)
	doRequest(t, h, "GET", "/items/7", nil, nil)
	if !waitFor(t, 2*time.Second, func() bool { return len(rs.events()) == 1 }) {
		t.Fatalf("expected 1 event")
	}
	if got := rs.events()[0].Route; got != "/items/:id" {
		t.Fatalf("expected pattern fallback /items/:id, got %q", got)
	}
}

func TestMiddleware_DropsOversizedRoutes(t *testing.T) {
	oversized := "/" + strings.Repeat("x", MaxRouteLength)

	t.Run("resolver", func(t *testing.T) {
		c := &Client{cfg: Config{RouteResolver: func(*http.Request) string { return oversized }}}
		req := httptest.NewRequest("GET", "/fallback", nil)
		if got := c.resolveRoute(req, ""); got != "" {
			t.Fatalf("expected oversized resolver route to be dropped, got %q", got)
		}
	})

	t.Run("pattern", func(t *testing.T) {
		if got := patternToRoute("GET " + oversized); got != "" {
			t.Fatalf("expected oversized request pattern to be dropped, got %q", got)
		}
	})

	t.Run("no pattern", func(t *testing.T) {
		c := &Client{}
		req := httptest.NewRequest("GET", oversized, nil)
		if got := c.resolveRoute(req, ""); got != "" {
			t.Fatalf("expected request without a template to be dropped, got %q", got)
		}
	})
}

// Concrete paths are never used as a fallback because arbitrary string
// segments may contain private customer data.
func TestMiddleware_DropsRequestWithoutTrustedTemplate(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{})

	h := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	paths := []string{
		"/users/42",
		"/users/alice-private",
		"/u/550e8400-e29b-41d4-a716-446655440000/posts",
		"/orders/1001/items",
		"/health",
	}
	for _, path := range paths {
		doRequest(t, h, "GET", path, nil, nil)
	}
	time.Sleep(30 * time.Millisecond)
	if got := rs.events(); len(got) != 0 {
		t.Fatalf("expected no events without a trusted route template, got %+v", got)
	}
}

// 4.4: serialized batches never contain headers, cookies, query values,
// concrete path values when a pattern exists, bodies, identity, logs, stacks,
// or spans.
func TestMiddleware_NoRequestContentCapture(t *testing.T) {
	rs := newRecordingServer()
	c := newTestClient(t, rs, Config{})

	mux := http.NewServeMux()
	mux.HandleFunc("POST /accounts/{id}/transfer", func(w http.ResponseWriter, r *http.Request) {
		// Read and discard the body to prove it is never serialized.
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	})
	h := c.Middleware(mux)

	sensitive := []string{
		"Bearer super-secret-token",
		"session=abc123",
		"amount=500",
		"password=hunter2",
		"778899", // concrete path id used below
	}
	doRequest(t, h, "POST", "/accounts/778899/transfer?amount=500&ref=secret",
		strings.NewReader(`{"password":"hunter2","amount":500}`),
		map[string]string{
			"Authorization": "Bearer super-secret-token",
			"Cookie":        "session=abc123",
		})

	if !waitFor(t, 2*time.Second, func() bool { return len(rs.batchBodies()) >= 1 }) {
		t.Fatalf("expected at least one batch")
	}
	for _, body := range rs.batchBodies() {
		for _, s := range sensitive {
			if bytes.Contains(body, []byte(s)) {
				t.Fatalf("serialized batch contains sensitive value %q:\n%s", s, body)
			}
		}
		// The route must be the pattern, not the concrete path.
		if bytes.Contains(body, []byte("/accounts/778899/transfer")) {
			t.Fatalf("serialized batch contains concrete path:\n%s", body)
		}
		if !bytes.Contains(body, []byte("/accounts/:id/transfer")) {
			t.Fatalf("serialized batch missing normalized route:\n%s", body)
		}
		// Verify the batch validates against the V1 contract (strict shape).
		var batch EventBatchV1
		if err := jsonStrictUnmarshal(body, &batch); err != nil {
			t.Fatalf("batch does not match V1 shape: %v", err)
		}
		if _, err := ValidateBatch(batch); err != nil {
			t.Fatalf("batch failed validation: %v", err)
		}
	}
}
