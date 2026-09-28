package apphealth

import (
	"strings"
	"testing"
)

func TestValidateBatch_AcceptsCanonicalFixtures(t *testing.T) {
	for _, b := range []EventBatchV1{NodeBatchFixture(), GoBatchFixture()} {
		if _, err := ValidateBatch(b); err != nil {
			t.Fatalf("expected canonical batch to validate, got %v", err)
		}
	}
}

func TestValidateBatch_RejectsUnknownSchemaVersion(t *testing.T) {
	b := GoBatchFixture()
	b.SchemaVersion = "v2"
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for unknown schema version")
	}
}

func TestValidateBatch_RequiresRuntime(t *testing.T) {
	b := GoBatchFixture()
	b.Runtime = ""
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for missing runtime")
	}
}

func TestValidateBatch_RejectsInvalidBatchRelease(t *testing.T) {
	b := GoBatchFixture()
	release := ""
	b.Release = &release
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for empty batch release")
	}
}

func TestValidateBatch_RejectsEmptyEvents(t *testing.T) {
	b := GoBatchFixture()
	b.Events = nil
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for empty events")
	}
}

func TestValidateBatch_RejectsTooManyEvents(t *testing.T) {
	b := GoBatchFixture()
	events := make([]EventV1, 0, MaxBatchEvents+1)
	for i := 0; i < MaxBatchEvents+1; i++ {
		e := b.Events[0]
		e.EventID = deterministicUUID(uint32(i + 1))
		e.Timestamp = e.Timestamp + int64(i)
		events = append(events, e)
	}
	b.Events = events
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for too many events")
	}
}

func TestValidateBatch_RejectsBadRoute(t *testing.T) {
	b := GoBatchFixture()
	b.Events[0].Route = "users/:id"
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for route not starting with /")
	}
}

func TestValidateBatch_RejectsBadStatus(t *testing.T) {
	b := GoBatchFixture()
	b.Events[0].StatusCode = 99
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for status code below 100")
	}
}

func TestValidateBatch_RejectsNegativeDuration(t *testing.T) {
	b := GoBatchFixture()
	b.Events[0].DurationMs = -1
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for negative duration")
	}
}

func TestValidateBatch_NormalizesLowercaseMethod(t *testing.T) {
	b := GoBatchFixture()
	b.Events[0].Method = "get"
	out, err := ValidateBatch(b)
	if err != nil {
		t.Fatalf("expected normalization, got error: %v", err)
	}
	if out.Events[0].Method != "GET" {
		t.Fatalf("expected GET, got %q", out.Events[0].Method)
	}
}

func TestValidateBatch_RejectsMethodWithNonLetters(t *testing.T) {
	b := GoBatchFixture()
	b.Events[0].Method = "G3T"
	if _, err := ValidateBatch(b); err == nil {
		t.Fatal("expected error for method with non-letter characters")
	}
}

func TestAreEndpointEquivalent_NodeAndGo(t *testing.T) {
	if !AreEndpointEquivalent(NodeBatchFixture(), GoBatchFixture()) {
		t.Fatal("expected Node and Go fixtures to be endpoint-equivalent")
	}
}

func TestComputeHealthState(t *testing.T) {
	cases := []struct {
		name    string
		reqs    int
		errRate float64
		p95     int
		want    HealthState
	}{
		{"low volume", 10, 0.5, 5000, HealthInsufficientData},
		{"healthy", 100, 0, 100, HealthHealthy},
		{"degraded err", 100, 0.01, 100, HealthDegraded},
		{"degraded p95", 100, 0, 1000, HealthDegraded},
		{"unhealthy err", 100, 0.05, 100, HealthUnhealthy},
		{"unhealthy p95", 100, 0, 2000, HealthUnhealthy},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ComputeHealthState(c.reqs, c.errRate, c.p95)
			if got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}

func TestLatencyHistogramIndexResolvesUnhealthyBoundary(t *testing.T) {
	cases := []struct {
		duration int
		want     int
	}{
		{duration: 1999, want: 9},
		{duration: 2000, want: 10},
		{duration: 4000, want: 10},
		{duration: 4001, want: 11},
	}
	for _, c := range cases {
		if got := LatencyHistogramIndex(c.duration); got != c.want {
			t.Errorf("LatencyHistogramIndex(%d) = %d, want %d", c.duration, got, c.want)
		}
	}
}

func TestValidateBatch_ErrorMentionsField(t *testing.T) {
	b := GoBatchFixture()
	b.Events[0].EventID = "not-a-uuid"
	_, err := ValidateBatch(b)
	if err == nil || !strings.Contains(err.Error(), "event_id") {
		t.Fatalf("expected error to mention event_id, got %v", err)
	}
}
