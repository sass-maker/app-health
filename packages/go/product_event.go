package apphealth

import (
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ProductMoney is explicitly declared tracked money in ISO currency minor units.
// It is independent of recorded payments and of the generic scalar Value.
type ProductMoney struct {
	AmountMinor int64  `json:"amount_minor"`
	Currency    string `json:"currency"`
}

// ProductAttribution is caller-supplied, sanitized acquisition evidence.
type ProductAttribution struct {
	Source    string `json:"source,omitempty"`
	Medium    string `json:"medium,omitempty"`
	Campaign  string `json:"campaign,omitempty"`
	Content   string `json:"content,omitempty"`
	Term      string `json:"term,omitempty"`
	EntryPath string `json:"entry_path"`
}

// TrackInput describes one deliberate product event. IDs must be anonymous UUIDs
// or opaque SHA-256 hashes; never pass email, customer identity, or request data.
type TrackInput struct {
	EventID     string              `json:"event_id,omitempty"`
	OccurredAt  int64               `json:"occurred_at,omitempty"`
	Type        string              `json:"type,omitempty"`
	Path        string              `json:"path,omitempty"`
	VisitorID   string              `json:"visitor_id,omitempty"`
	SessionID   string              `json:"session_id,omitempty"`
	Properties  map[string]any      `json:"properties,omitempty"`
	Value       *float64            `json:"value,omitempty"`
	Revenue     *ProductMoney       `json:"revenue,omitempty"`
	Interactive *bool               `json:"interactive,omitempty"`
	Attribution *ProductAttribution `json:"attribution,omitempty"`
}

// ProductEventV1 is the canonical explicit event envelope shared with other SDKs.
type ProductEventV1 struct {
	TrackInput
	SchemaVersion string `json:"schemaVersion"`
	Channel       string `json:"channel"`
	Name          string `json:"name"`
}
type queuedEvent struct {
	endpoint *EventV1
	product  *ProductEventV1
}
type productBatch struct {
	SchemaVersion int              `json:"schema_version"`
	BatchID       string           `json:"batch_id"`
	Environment   string           `json:"environment,omitempty"`
	Events        []ProductEventV1 `json:"events"`
}

var anonymousID = regexp.MustCompile(`(?i)^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$`)
var eventUUID = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var currencyCode = regexp.MustCompile(`^[A-Z]{3}$`)

func printable(value string, max int) bool {
	if value == "" || utf8.RuneCountInString(value) > max {
		return false
	}
	for _, char := range value {
		if char < 32 || char == 127 {
			return false
		}
	}
	return true
}
func productPath(value string) bool {
	decoded, err := url.PathUnescape(value)
	return err == nil && strings.HasPrefix(value, "/") && utf8.RuneCountInString(value) <= 256 && !strings.ContainsAny(decoded, "?#@\\ \t\r\n")
}
func productScalar(value any) bool {
	switch value := value.(type) {
	case string:
		return utf8.RuneCountInString(value) <= 255
	case bool:
		return true
	case float64:
		return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= 1e12
	case int:
		return float64(value) <= 1e12 && float64(value) >= -1e12
	case int64:
		return value <= 1e12 && value >= -1e12
	default:
		return false
	}
}
func productProperties(properties map[string]any) bool {
	if len(properties) > 30 {
		return false
	}
	for key, value := range properties {
		if !printable(key, 64) || key == "__proto__" || key == "constructor" || key == "prototype" || !productScalar(value) {
			return false
		}
	}
	return true
}
func productIdentity(input TrackInput) bool {
	if !eventUUID.MatchString(input.EventID) || input.OccurredAt < 0 {
		return false
	}
	return (input.VisitorID == "" || anonymousID.MatchString(input.VisitorID)) && (input.SessionID == "" || anonymousID.MatchString(input.SessionID))
}
func productAttribution(a *ProductAttribution) bool {
	if a == nil {
		return true
	}
	if !productPath(a.EntryPath) {
		return false
	}
	for _, tag := range []string{a.Source, a.Medium, a.Campaign, a.Content, a.Term} {
		if len(tag) > 100 || !attributionTag.MatchString(tag) {
			return false
		}
	}
	return true
}

var attributionTag = regexp.MustCompile(`^[a-zA-Z0-9 _.,:+/-]*$`)

func productRevenue(input TrackInput) bool {
	if input.Type != "revenue" {
		return input.Revenue == nil
	}
	r := input.Revenue
	return r != nil && r.AmountMinor >= 0 && r.AmountMinor <= 1e12 && currencyCode.MatchString(r.Currency)
}
func validTrack(input TrackInput) bool {
	if !productIdentity(input) || !productProperties(input.Properties) || !productAttribution(input.Attribution) || !productRevenue(input) {
		return false
	}
	if input.Path != "" && !productPath(input.Path) {
		return false
	}
	if input.Value != nil && (math.IsNaN(*input.Value) || math.IsInf(*input.Value, 0) || math.Abs(*input.Value) > 1e12) {
		return false
	}
	return input.Type == "event" || input.Type == "identify" || input.Type == "revenue"
}

// Track validates, snapshots, and queues one explicit event on the same bounded
// pipeline as endpoint summaries. It never inspects an HTTP request. Validation,
// closed-client, and capacity errors are returned and counted as dropped events.
func (c *Client) Track(name string, input TrackInput) error {
	name = strings.TrimSpace(name)
	if input.EventID == "" {
		input.EventID = newEventID()
	}
	if input.OccurredAt == 0 {
		input.OccurredAt = c.now().UnixMilli()
	}
	if input.Type == "" {
		input.Type = "event"
	}
	if !printable(name, 64) || !validTrack(input) {
		c.dropped.Add(1)
		return errors.New("apphealth: invalid product event")
	}
	event := ProductEventV1{TrackInput: input, SchemaVersion: "app-health.product-event.v1", Channel: "server", Name: name}
	raw, err := json.Marshal(event)
	if err != nil || len(raw) > 63*1024 {
		c.dropped.Add(1)
		return errors.New("apphealth: product event exceeds 64 KiB batch limit")
	}
	// Snapshot caller-owned maps and pointers before asynchronous delivery.
	event = ProductEventV1{}
	if json.Unmarshal(raw, &event) != nil {
		c.dropped.Add(1)
		return errors.New("apphealth: invalid product event")
	}
	if c.closed.Load() {
		c.dropped.Add(1)
		return errors.New("apphealth: client closed")
	}
	select {
	case c.queue <- queuedEvent{product: &event}:
		return nil
	default:
		c.dropped.Add(1)
		return errors.New("apphealth: product event queue full")
	}
}

func (c *Client) deliverProducts(events []ProductEventV1) {
	target, err := url.Parse(c.cfg.IngestURL)
	if err != nil {
		c.failed.Add(int64(len(events)))
		return
	}
	target.Path = "/v1/product-events"
	target.RawPath = ""
	target.RawQuery = ""
	target.Fragment = ""
	for len(events) > 0 {
		count := len(events)
		if count > 100 {
			count = 100
		}
		batch := productBatch{SchemaVersion: 1, BatchID: newEventID(), Environment: strings.ToLower(strings.TrimSpace(c.cfg.Environment))}
		var body []byte
		for count > 0 {
			batch.Events = events[:count]
			body, err = json.Marshal(batch)
			if err == nil && len(body) <= 64*1024 {
				break
			}
			count--
		}
		if count == 0 {
			c.failed.Add(1)
			events = events[1:]
			continue
		}
		c.deliverBody(body, count, target.String())
		events = events[count:]
	}
}
