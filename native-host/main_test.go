package main

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

func TestNativeMessageRoundTrip(t *testing.T) {
	var buffer bytes.Buffer
	want := descriptor{Type: "ready", OK: true, Version: protocol, Host: hostName}
	if err := writeNative(&buffer, want); err != nil {
		t.Fatal(err)
	}
	var got descriptor
	if err := readNative(&buffer, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != want.Type || got.Version != want.Version || !got.OK {
		t.Fatalf("unexpected round trip: %#v", got)
	}
}

func TestSessionValidation(t *testing.T) {
	if !validSession("abcdefghijklmnop") {
		t.Fatal("valid session rejected")
	}
	for _, value := range []string{"short", "bad/session/value", "bad session value"} {
		if validSession(value) {
			t.Fatalf("invalid session accepted: %q", value)
		}
	}
}

func TestTokenComparison(t *testing.T) {
	if !sameToken("same-token", "same-token") || sameToken("same-token", "other-token") {
		t.Fatal("constant-time token comparison returned wrong result")
	}
}

func TestSelectBindAddress(t *testing.T) {
	address, reachable := selectBindAddress(nil)
	if address != "127.0.0.1" || reachable {
		t.Fatalf("unexpected loopback fallback: %q, %t", address, reachable)
	}
	address, reachable = selectBindAddress([]string{"192.168.1.25", "10.0.0.4"})
	if address != "192.168.1.25" || !reachable {
		t.Fatalf("unexpected private-network selection: %q, %t", address, reachable)
	}
}

func TestActivityTrackerIdleLifecycle(t *testing.T) {
	var mu sync.Mutex
	now := time.Unix(100, 0)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(duration time.Duration) time.Time {
		mu.Lock()
		now = now.Add(duration)
		value := now
		mu.Unlock()
		return value
	}

	tracker := newActivityTracker(clock)
	if tracker.isIdle(advance(idleTimeout-time.Second), idleTimeout) {
		t.Fatal("tracker became idle before the timeout")
	}
	if !tracker.isIdle(advance(time.Second), idleTimeout) {
		t.Fatal("tracker did not become idle at the timeout")
	}

	end := tracker.begin()
	if tracker.isIdle(advance(idleTimeout*2), idleTimeout) {
		t.Fatal("active request was treated as idle")
	}
	end()
	end()
	if tracker.isIdle(advance(idleTimeout-time.Second), idleTimeout) {
		t.Fatal("tracker ignored activity completion time")
	}
	if !tracker.isIdle(advance(time.Second), idleTimeout) {
		t.Fatal("tracker did not become idle after activity completed")
	}

	tracker.touch()
	if tracker.isIdle(advance(idleTimeout-time.Second), idleTimeout) {
		t.Fatal("touch did not refresh the activity time")
	}
}

func TestReadNativeInputs(t *testing.T) {
	var buffer bytes.Buffer
	for _, request := range []nativeRequest{{Type: "status"}, {Type: "stop"}} {
		if err := writeNative(&buffer, request); err != nil {
			t.Fatal(err)
		}
	}

	inputs := make(chan nativeInput, 3)
	readNativeInputs(&buffer, inputs)
	first := <-inputs
	second := <-inputs
	end := <-inputs
	if first.err != nil || first.request.Type != "status" {
		t.Fatalf("unexpected first request: %#v", first)
	}
	if second.err != nil || second.request.Type != "stop" {
		t.Fatalf("unexpected second request: %#v", second)
	}
	if end.err == nil {
		t.Fatal("reader did not report end of input")
	}
	if _, open := <-inputs; open {
		t.Fatal("input channel remained open")
	}
}
