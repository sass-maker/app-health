package apphealth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestTrackCanonicalSeparatedAndSnapshotted(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	var product productBatch
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/v1/product-events" {
			if r.Header.Get("Authorization") != "Bearer fixture" {
				t.Error("missing private key")
			}
			if err := json.NewDecoder(r.Body).Decode(&product); err != nil {
				t.Error(err)
			}
		}
		w.WriteHeader(202)
	}))
	defer server.Close()
	client := New(Config{IngestURL: server.URL + "/v1/ingest?unused=value", IngestKey: "fixture", Environment: "production", FlushInterval: time.Hour})
	props := map[string]any{"plan": "Pro"}
	value := 2.0
	if err := client.Track("Order Paid", TrackInput{Properties: props, Type: "revenue", Revenue: &ProductMoney{AmountMinor: 100, Currency: "USD"}, Value: &value}); err != nil {
		t.Fatal(err)
	}
	props["plan"] = "Changed"
	client.Record(RecordInput{Method: "GET", Route: "/orders/:id", StatusCode: 200})
	if err := client.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paths) != 2 || paths[0] != "/v1/ingest" || paths[1] != "/v1/product-events" {
		t.Fatalf("paths %v", paths)
	}
	event := product.Events[0]
	if event.Name != "Order Paid" || event.Channel != "server" || event.Properties["plan"] != "Pro" || event.Revenue.AmountMinor != 100 {
		t.Fatalf("event %#v", event)
	}
	if client.Stats().Sent != 2 {
		t.Fatalf("stats %#v", client.Stats())
	}
}

func TestTrackValidationAndBoundedPacking(t *testing.T) {
	var count int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			t.Error("product endpoint retains query")
		}
		var batch productBatch
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&batch); err != nil {
			t.Error(err)
		}
		if len(batch.Events) > 100 {
			t.Error("event limit")
		}
		count += len(batch.Events)
		w.WriteHeader(202)
	}))
	defer server.Close()
	client := New(Config{IngestURL: server.URL + "/v1/ingest?secret=omitted", FlushInterval: time.Hour, QueueSize: 100})
	for _, input := range []TrackInput{{VisitorID: "a@example.com"}, {Properties: map[string]any{"nested": map[string]any{"secret": 1}}}, {Path: "/%3Fsecret=1"}, {EventID: "invalid"}} {
		if client.Track("Order Paid", input) == nil {
			t.Error("invalid input accepted")
		}
	}
	props := map[string]any{}
	for i := 0; i < 30; i++ {
		props[string(rune('A'+i))] = string(make([]byte, 255))
	}
	for i := 0; i < 40; i++ {
		if err := client.Track("Large", TrackInput{Properties: props}); err != nil {
			t.Fatal(err)
		}
	}
	if err := client.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if count != 40 {
		t.Fatalf("sent %d", count)
	}
	if client.Track("Closed", TrackInput{}) == nil {
		t.Error("closed accepted")
	}
}

func TestTrackValidatesMoneyAndExplicitAttributionBeforeBatching(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch productBatch
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Error(err)
		}
		if len(batch.Events) != 1 || batch.Events[0].Revenue.Currency != "IQD" {
			t.Errorf("batch %#v", batch)
		}
		w.WriteHeader(202)
	}))
	defer server.Close()
	client := New(Config{IngestURL: server.URL + "/v1/ingest", FlushInterval: time.Hour})
	value := 3.0
	valid := TrackInput{Type: "revenue", Revenue: &ProductMoney{AmountMinor: 100, Currency: "IQD"}, Path: "/pricing", Value: &value, Attribution: &ProductAttribution{EntryPath: "/pricing", Campaign: "Pro Launch"}, Properties: map[string]any{"a": true, "b": float64(3), "c": int(3), "d": int64(3)}}
	if err := client.Track("Order Paid", valid); err != nil {
		t.Fatal(err)
	}
	for _, input := range []TrackInput{
		{Type: "revenue", Revenue: &ProductMoney{AmountMinor: 100, Currency: "XYZ"}},
		{Properties: map[string]any{"constructor": 1}},
		{Properties: map[string]any{"a": struct{}{}}},
		{Attribution: &ProductAttribution{EntryPath: "/x", Campaign: "a@example.test"}},
		{Attribution: &ProductAttribution{EntryPath: "bad"}},
		{Path: "/x?private=yes"}, {Type: "unknown"},
	} {
		if client.Track("Invalid", input) == nil {
			t.Errorf("accepted %#v", input)
		}
	}
	if client.Track("Control\nName", TrackInput{}) == nil {
		t.Error("accepted control name")
	}
	if err := client.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if client.Stats().Sent != 1 {
		t.Fatalf("stats %#v", client.Stats())
	}
}
