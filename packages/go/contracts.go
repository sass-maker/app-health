// Package apphealth defines the V1 endpoint-health contract shared by the Go
// SDK and the ingest service. It mirrors packages/contracts in TypeScript so
// canonical Node and Go fixtures validate into the same internal event shape.
//
// Wave 0 only defines types, bounds, validation, and canonical fixtures. The
// net/http middleware, batching, retries, and fail-open delivery are
// implemented in Wave 1 (tasks 4.1-4.6).
package apphealth

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// SchemaVersion is the single ingest schema version accepted by V0.
const SchemaVersion = "v1"

// Field bounds. These mirror packages/contracts/src/constants.ts.
const (
	MaxBatchEvents       = 1000
	MaxMethodLength      = 16
	MaxRouteLength       = 256
	MaxReleaseLength     = 128
	MaxEnvironmentLength = 64
	MaxDurationMs        = 600_000
	MaxResponseBytes     = 268_435_456
	MaxClockSkewMs       = 5 * 60 * 1000
	MinStatusCode        = 100
	MaxStatusCode        = 599
	InsufficientMinReq   = 20
	UnhealthyErrRate     = 0.05
	UnhealthyP95Ms       = 2000
	DegradedErrRate      = 0.01
	DegradedP95Ms        = 1000
)

// LatencyBucketBoundsMs mirrors the TypeScript fixed histogram bounds.
var LatencyBucketBoundsMs = [15]int{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000}

// LatencyHistogramBuckets is the number of histogram buckets (bounds + overflow).
const LatencyHistogramBuckets = 16

// Runtime is the SDK runtime reported for installation verification.
type Runtime string

const (
	RuntimeNode Runtime = "node"
	RuntimeGo   Runtime = "go"
)

// Window is a supported query window.
type Window string

const (
	Window15m Window = "15m"
	Window1h  Window = "1h"
	Window24h Window = "24h"
)

// HealthState is the deterministic label for a windowed endpoint aggregate.
type HealthState string

const (
	HealthHealthy          HealthState = "healthy"
	HealthDegraded         HealthState = "degraded"
	HealthUnhealthy        HealthState = "unhealthy"
	HealthInsufficientData HealthState = "insufficient-data"
)

// InstallationState is the installation-status state value.
type InstallationState string

const (
	InstallationWaiting   InstallationState = "waiting"
	InstallationConnected InstallationState = "connected"
	InstallationStale     InstallationState = "stale"
	InstallationRevoked   InstallationState = "revoked"
	InstallationError     InstallationState = "error"
)

// EventV1 is a single endpoint performance summary.
type EventV1 struct {
	EventID       string  `json:"event_id"`
	Timestamp     int64   `json:"timestamp"`
	Method        string  `json:"method"`
	Route         string  `json:"route"`
	StatusCode    int     `json:"status_code"`
	DurationMs    int     `json:"duration_ms"`
	ResponseBytes *int64  `json:"response_bytes,omitempty"`
	Release       *string `json:"release,omitempty"`
}

// EventBatchV1 is the V1 ingest batch.
type EventBatchV1 struct {
	BatchID       string    `json:"batch_id"`
	SchemaVersion string    `json:"schema_version"`
	Runtime       Runtime   `json:"runtime"`
	Environment   string    `json:"environment,omitempty"`
	Release       *string   `json:"release,omitempty"`
	Events        []EventV1 `json:"events"`
}

// EndpointAggregateV1 is a windowed endpoint aggregate returned by the query API.
type EndpointAggregateV1 struct {
	Method                string      `json:"method"`
	Route                 string      `json:"route"`
	RequestCount          int         `json:"request_count"`
	ErrorCount            int         `json:"error_count"`
	ErrorRate             float64     `json:"error_rate"`
	P50Ms                 int         `json:"p50_ms"`
	P95Ms                 int         `json:"p95_ms"`
	AvgResponseBytes      *float64    `json:"avg_response_bytes"`
	TotalResponseBytes    *float64    `json:"total_response_bytes"`
	ResponseBytesDeltaPct *float64    `json:"response_bytes_delta_pct"`
	LastSeen              *int64      `json:"last_seen"`
	HealthState           HealthState `json:"health_state"`
}

// AppV1, EnvironmentV1, KeyRecordV1, KeyDisplayV1 mirror the TypeScript setup contract.
type AppV1 struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
}

type EnvironmentV1 struct {
	ID        string `json:"id"`
	AppID     string `json:"app_id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
}

type KeyRecordV1 struct {
	ID            string  `json:"id"`
	AppID         string  `json:"app_id"`
	EnvironmentID *string `json:"environment_id"`
	VerifierHash  string  `json:"verifier_hash"`
	CreatedAt     int64   `json:"created_at"`
	RevokedAt     *int64  `json:"revoked_at"`
}

type KeyDisplayV1 struct {
	Key           string  `json:"key"`
	AppID         string  `json:"app_id"`
	EnvironmentID *string `json:"environment_id"`
	CreatedAt     int64   `json:"created_at"`
}

type CreateAppRequestV1 struct {
	Name        string `json:"name"`
	Environment string `json:"environment"`
}

type CreateAppResponseV1 struct {
	App         AppV1         `json:"app"`
	Environment EnvironmentV1 `json:"environment"`
	Key         KeyDisplayV1  `json:"key"`
}

// InstallationStatusV1 mirrors the TypeScript installation-status contract.
type InstallationStatusV1 struct {
	State      InstallationState `json:"state"`
	Runtime    *Runtime          `json:"runtime,omitempty"`
	FirstSeen  *int64            `json:"first_seen"`
	LastSeen   *int64            `json:"last_seen"`
	NextAction string            `json:"next_action"`
}

// EndpointQueryRequestV1 mirrors the TypeScript query request.
type EndpointQueryRequestV1 struct {
	AppID         string `json:"app_id"`
	EnvironmentID string `json:"environment_id"`
	Window        Window `json:"window"`
	Sort          string `json:"sort"`
	SortDir       string `json:"sort_dir"`
}

// EndpointQueryResponseV1 mirrors the TypeScript query response.
type EndpointQueryResponseV1 struct {
	RefreshedAt int64                 `json:"refreshed_at"`
	Window      Window                `json:"window"`
	Endpoints   []EndpointAggregateV1 `json:"endpoints"`
}

var (
	uuidV4Pattern      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	methodPattern      = regexp.MustCompile(`^[A-Z]+$`)
	environmentPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
)

// validateResponseBytes bounds the optional response payload byte count.
// A nil value means the size was not measured and is always valid.
func validateResponseBytes(bytes *int64) error {
	if bytes == nil {
		return nil
	}
	if *bytes < 0 || *bytes > MaxResponseBytes {
		return fmt.Errorf("response_bytes: must be 0..%d", MaxResponseBytes)
	}
	return nil
}

func validateRelease(release *string) error {
	if release == nil {
		return nil
	}
	r := strings.TrimSpace(*release)
	if len(r) == 0 || len(r) > MaxReleaseLength {
		return fmt.Errorf("release: must be 1..%d chars", MaxReleaseLength)
	}
	return nil
}

func ValidateEvent(e EventV1) error {
	if !uuidV4Pattern.MatchString(e.EventID) {
		return fmt.Errorf("event_id: not a uuid v4")
	}
	if e.Timestamp < 0 {
		return fmt.Errorf("timestamp: must be >= 0")
	}
	method := strings.ToUpper(strings.TrimSpace(e.Method))
	if len(method) == 0 || len(method) > MaxMethodLength || !methodPattern.MatchString(method) {
		return fmt.Errorf("method: must be uppercase A-Z, 1..%d chars", MaxMethodLength)
	}
	if len(e.Route) == 0 || len(e.Route) > MaxRouteLength || !strings.HasPrefix(e.Route, "/") {
		return fmt.Errorf("route: must start with / and be 1..%d chars", MaxRouteLength)
	}
	if e.StatusCode < MinStatusCode || e.StatusCode > MaxStatusCode {
		return fmt.Errorf("status_code: must be %d..%d", MinStatusCode, MaxStatusCode)
	}
	if e.DurationMs < 0 || e.DurationMs > MaxDurationMs {
		return fmt.Errorf("duration_ms: must be 0..%d", MaxDurationMs)
	}
	if err := validateResponseBytes(e.ResponseBytes); err != nil {
		return err
	}
	return validateRelease(e.Release)
}

// ValidateBatch validates a V1 batch and normalizes runtime/method casing.
func ValidateBatch(b EventBatchV1) (EventBatchV1, error) {
	if !uuidV4Pattern.MatchString(b.BatchID) {
		return b, errors.New("batch_id: must be a UUID v4")
	}
	if b.SchemaVersion != SchemaVersion {
		return b, fmt.Errorf("schema_version: expected %q, got %q", SchemaVersion, b.SchemaVersion)
	}
	if b.Runtime != RuntimeNode && b.Runtime != RuntimeGo {
		return b, fmt.Errorf("runtime: must be %q or %q", RuntimeNode, RuntimeGo)
	}
	if b.Environment != "" {
		b.Environment = strings.ToLower(strings.TrimSpace(b.Environment))
		if len(b.Environment) > MaxEnvironmentLength || !environmentPattern.MatchString(b.Environment) {
			return b, fmt.Errorf("environment: must be a lower-case slug up to %d chars", MaxEnvironmentLength)
		}
	}
	if b.Release != nil {
		r := strings.TrimSpace(*b.Release)
		if len(r) == 0 || len(r) > MaxReleaseLength {
			return b, fmt.Errorf("release: must be 1..%d chars", MaxReleaseLength)
		}
	}
	n := len(b.Events)
	if n == 0 {
		return b, errors.New("events: must not be empty")
	}
	if n > MaxBatchEvents {
		return b, fmt.Errorf("events: must be <= %d, got %d", MaxBatchEvents, n)
	}
	for i := range b.Events {
		ev := b.Events[i]
		ev.Method = strings.ToUpper(strings.TrimSpace(ev.Method))
		if err := ValidateEvent(ev); err != nil {
			return b, fmt.Errorf("events[%d]: %w", i, err)
		}
		b.Events[i] = ev
	}
	return b, nil
}

// HealthState computes the deterministic health state for a windowed aggregate.
func ComputeHealthState(requestCount int, errorRate float64, p95Ms int) HealthState {
	if requestCount < InsufficientMinReq {
		return HealthInsufficientData
	}
	if errorRate >= UnhealthyErrRate || p95Ms >= UnhealthyP95Ms {
		return HealthUnhealthy
	}
	if errorRate >= DegradedErrRate || p95Ms >= DegradedP95Ms {
		return HealthDegraded
	}
	return HealthHealthy
}
