package apphealth

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

var responseWriterPool = sync.Pool{
	New: func() any { return new(responseWriter) },
}

// RouteResolver resolves a normalized route template for a request when the
// framework does not populate Request.Pattern (e.g. third-party routers).
// Return "" to fall back to Request.Pattern; if neither produces a trusted
// template, the event is dropped.
type RouteResolver func(*http.Request) string

// Middleware returns net/http middleware that records method, normalized
// route, status code, duration, response payload byte count, timestamp, and
// optional release for each completed request, then enqueues the summary for
// asynchronous delivery.
//
// The middleware preserves handler response behavior (status, headers, body),
// the http.Flusher, http.Hijacker, http.Pusher, and io.ReaderFrom optional
// interfaces when the underlying ResponseWriter supports them, and panic
// behavior: a panicking handler still propagates the panic to the surrounding
// server's recovery (which returns 500 to the client). The middleware records
// status 500 for a panicked handler and re-raises the original panic value.
func (c *Client) Middleware(next http.Handler) http.Handler {
	// Go 1.22 does not expose Request.Pattern. When the wrapped handler is a
	// standard ServeMux, resolve its registered pattern before dispatch so the
	// SDK still records templates without reading the concrete URL path.
	serveMux, _ := next.(*http.ServeMux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := c.now()
		muxPattern := ""
		if serveMux != nil {
			_, muxPattern = serveMux.Handler(r)
		}
		rw := responseWriterPool.Get().(*responseWriter)
		rw.ResponseWriter = w
		rw.status = 0
		rw.wroteHeader = false
		rw.bytes = 0
		defer func() {
			rw.ResponseWriter = nil
			responseWriterPool.Put(rw)
		}()
		defer func() {
			elapsed := c.now().Sub(start)
			if rec := recover(); rec != nil {
				// The surrounding server's recovery returns 500 to the client.
				// Record 500 for the panicked handler, then re-raise so panic
				// behavior (propagation, server recovery, client response) is
				// unchanged by instrumentation.
				rw.status = http.StatusInternalServerError
				rw.wroteHeader = true
				c.record(rw, r, muxPattern, start, elapsed)
				panic(rec)
			}
			rw.finish()
			c.record(rw, r, muxPattern, start, elapsed)
		}()
		next.ServeHTTP(rw, r)
	})
}

// record builds and enqueues a single EventV1. It never reads headers,
// cookies, query, parameters, or bodies.
func (c *Client) record(rw *responseWriter, r *http.Request, muxPattern string, start time.Time, elapsed time.Duration) {
	route := c.resolveRoute(r, muxPattern)
	if route == "" {
		// No usable route identity; drop rather than emit a misleading event.
		return
	}
	method := strings.ToUpper(strings.TrimSpace(r.Method))
	if method == "" {
		method = "GET"
	}
	if len(method) > MaxMethodLength {
		method = method[:MaxMethodLength]
	}

	status := rw.status
	if status < MinStatusCode || status > MaxStatusCode {
		// Unknown or missing status; record as 200 which is the net/http
		// default when WriteHeader is never called.
		status = http.StatusOK
	}

	if elapsed < 0 {
		elapsed = 0
	}
	c.Record(RecordInput{
		Method:        method,
		Route:         route,
		StatusCode:    status,
		Duration:      elapsed,
		Timestamp:     start,
		ResponseBytes: &rw.bytes,
	})
}

// resolveRoute picks the route identity in priority order:
//  1. configured RouteResolver (if any and returns non-empty)
//  2. Go 1.23+ Request.Pattern (ServeMux), converted to :wildcard form
//  3. a Go 1.22 ServeMux pattern resolved by Middleware before dispatch
//  4. drop the event rather than read the concrete request path
func (c *Client) resolveRoute(r *http.Request, muxPattern string) string {
	if c.cfg.RouteResolver != nil {
		if route := c.cfg.RouteResolver(r); route != "" {
			return normalizeRouteTemplate(route)
		}
	}
	if pattern, ok := requestPattern(r); ok {
		return patternToRoute(pattern)
	}
	if muxPattern != "" {
		return patternToRoute(muxPattern)
	}
	return ""
}

// responseWriter wraps http.ResponseWriter to capture the final status code
// while preserving optional interfaces. It deliberately does NOT recover
// panics so handler panic semantics are unchanged.
type responseWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	bytes       int64
}

func (w *responseWriter) WriteHeader(code int) {
	if w.wroteHeader {
		return
	}
	w.status = code
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *responseWriter) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.status = http.StatusOK
		w.wroteHeader = true
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

// finish finalizes the status if the handler never called WriteHeader or Write.
func (w *responseWriter) finish() {
	if !w.wroteHeader {
		w.status = http.StatusOK
		w.wroteHeader = true
	}
}

// Flush proxies http.Flusher when supported.
func (w *responseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack proxies http.Hijacker when supported. The signature matches
// http.Hijacker so the wrapper satisfies the interface when the underlying
// writer does.
func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// Push proxies http.Pusher when supported.
func (w *responseWriter) Push(target string, opts *http.PushOptions) error {
	if p, ok := w.ResponseWriter.(http.Pusher); ok {
		return p.Push(target, opts)
	}
	return http.ErrNotSupported
}

// ReadFrom proxies io.ReaderFrom when supported so handlers using io.Copy into
// the ResponseWriter keep their zero-copy fast path. The signature matches
// io.ReaderFrom.
func (w *responseWriter) ReadFrom(src io.Reader) (int64, error) {
	var n int64
	var err error
	if rf, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		n, err = rf.ReadFrom(src)
	} else {
		n, err = io.Copy(w.ResponseWriter, src)
	}
	w.bytes += n
	return n, err
}
