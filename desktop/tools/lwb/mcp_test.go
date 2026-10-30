package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const initializeMsg = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0"}}}`

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestMCPForwardsToBrowser(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true)
	r := startMCP(t, c, "--profile="+profile)

	r.send(initializeMsg)
	if m := r.recv(); jget(m, "id") != 1.0 || jget(m, "result", "from") != "browser" || jget(m, "result", "method") != "initialize" {
		t.Fatalf("initialize answer = %v, want the browser's", m)
	}
	r.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	r.send(`{"jsonrpc":"2.0","id":"two","method":"tools/list"}`)
	if m := r.recv(); jget(m, "id") != "two" || jget(m, "result", "method") != "tools/list" {
		t.Fatalf("tools/list answer = %v", m)
	}
	if code, rest := r.finish(); code != 0 || len(rest) != 0 {
		t.Fatalf("exit %d, extra output %s", code, rest)
	}

	log := f.mcpLog()
	want := []string{"initialize#1", "notifications/initialized", `tools/list#"two"`, "DELETE"}
	if len(log) != 4 || log[3] != "DELETE" || !slices.Equal(sorted(log[:3]), sorted(want[:3])) {
		t.Errorf("browser saw %q, want %q (DELETE last)", log, want)
	}
	var session string
	for _, req := range f.requests() {
		h := req.Header
		if h.Get("Authorization") != "Bearer "+f.token || h.Get("X-Lwb-Client") != "test-client" ||
			h.Get("X-Lwb-Label") != "demo-project" || h.Get("Origin") != "" {
			t.Errorf("%s %s: headers %v", req.Method, req.Path, h)
		}
		if session == "" {
			session = h.Get("X-Lwb-Session")
		}
		if h.Get("X-Lwb-Session") != session || !uuidRe.MatchString(session) {
			t.Errorf("%s %s: session %q (first %q)", req.Method, req.Path, h.Get("X-Lwb-Session"), session)
		}
	}
}

func sorted(s []string) []string {
	s = slices.Clone(s)
	slices.Sort(s)
	return s
}

func TestMCPAnswersLocallyWhileBrowserIsClosed(t *testing.T) {
	c, _, _ := newTestCLI(t, nil) // a browser start would fail the test
	profile := t.TempDir()        // no endpoint file: the browser is not running
	r := startMCP(t, c, "--profile="+profile)

	r.send(initializeMsg)
	m := r.recv()
	if jget(m, "result", "protocolVersion") != "2025-03-26" ||
		jget(m, "result", "capabilities", "tools", "listChanged") != false ||
		jget(m, "result", "serverInfo", "name") != "ludworks-browser" ||
		!strings.Contains(fmt.Sprint(jget(m, "result", "instructions")), "browser_snapshot") {
		t.Fatalf("initialize answer = %v", m)
	}
	r.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	r.send(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	r.send(`{"jsonrpc":"2.0","id":3,"method":"ping"}`)
	r.send(`{"jsonrpc":"2.0","id":4,"method":"resources/list"}`)
	r.send(`{"jsonrpc":"2.0","id":5,"method":"prompts/list"}`)
	r.send(`{"jsonrpc":"2.0","id":6,"method":"completion/complete","params":{}}`)
	got := r.recvByID(5)

	cat, _ := builtinCatalog()
	tools, _ := jget(got["2"], "result", "tools").([]any)
	if len(tools) != len(cat.tools) || jget(tools[0], "name") != "browser_navigate" ||
		jget(tools[0], "inputSchema", "required") == nil {
		t.Errorf("tools/list = %v", got["2"])
	}
	if res, ok := jget(got["3"], "result").(map[string]any); !ok || len(res) != 0 {
		t.Errorf("ping = %v", got["3"])
	}
	if l, ok := jget(got["4"], "result", "resources").([]any); !ok || len(l) != 0 {
		t.Errorf("resources/list = %v", got["4"])
	}
	if l, ok := jget(got["5"], "result", "prompts").([]any); !ok || len(l) != 0 {
		t.Errorf("prompts/list = %v", got["5"])
	}
	if jget(got["6"], "error", "code") != -32601.0 {
		t.Errorf("unknown method = %v", got["6"])
	}
	if code, rest := r.finish(); code != 0 || len(rest) != 0 {
		t.Errorf("exit %d, extra output (the notification must get none) %s", code, rest)
	}
}

func TestMCPToolCallWithoutBrowserIsAToolError(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	r := startMCP(t, c, "--profile="+t.TempDir(), "--no-launch")
	r.send(initializeMsg)
	r.recv()
	r.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}`)
	m := r.recv()
	text := fmt.Sprint(jget(m, "result", "content"))
	if jget(m, "error") != nil || jget(m, "result", "isError") != true ||
		!strings.Contains(text, "Settings → AI agents") || !strings.Contains(text, "--no-launch") {
		t.Errorf("tools/call = %v, want an isError result explaining how to turn on agent access", m)
	}
}

func TestMCPStartsBrowserForToolCall(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "electron")
	appDir := t.TempDir()
	if err := os.WriteFile(exe, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	c, _, stderr := newTestCLI(t, map[string]string{"LWB_BROWSER": exe, "LWB_BROWSER_APP": appDir})
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, false)
	var mu sync.Mutex
	var started [][]string
	c.start = func(path string, args []string, dir string) error {
		mu.Lock()
		started = append(started, append([]string{path, dir}, args...))
		mu.Unlock()
		// The browser comes up a little later; lwb must keep looking.
		time.AfterFunc(150*time.Millisecond, f.publish)
		return nil
	}
	r := startMCP(t, c, "--profile="+profile)

	r.send(initializeMsg)
	if m := r.recv(); jget(m, "result", "from") != nil || jget(m, "result", "serverInfo") == nil {
		t.Fatalf("initialize should be answered locally, got %v", m)
	}
	r.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	r.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com"}}}`)
	if m := r.recv(); jget(m, "id") != 2.0 || jget(m, "result", "from") != "browser" {
		t.Fatalf("tools/call answer = %v, want the browser's", m)
	}
	r.finish()

	want := []string{exe, filepath.Dir(exe), appDir, "--agent-request=test-client", "--user-data-dir=" + profile}
	if len(started) != 1 || !slices.Equal(started[0], want) {
		t.Errorf("started %q, want once %q", started, want)
	}
	// The browser never saw initialize, so lwb replays the client's before the call.
	wantLog := []string{`initialize#"lwb-init-1"`, "notifications/initialized", "tools/call#2", "DELETE"}
	if log := f.mcpLog(); !slices.Equal(log, wantLog) {
		t.Errorf("browser saw %q, want %q", log, wantLog)
	}
	for _, req := range f.requests() {
		if req.Path == "/mcp" && req.Method == http.MethodPost {
			var m rpcMessage
			json.Unmarshal(req.Body, &m)
			if m.Method == "initialize" && !strings.Contains(string(m.Params), `"test-client"`) {
				t.Errorf("replayed initialize params %s, want the client's", m.Params)
			}
		}
	}
	wait := `Waiting for Ludworks Browser — allow "test-client" in the browser window…`
	if n := strings.Count(stderr.String(), wait); n != 1 {
		t.Errorf("stderr has the waiting message %d times:\n%s", n, stderr)
	}
}

// callLog records, in the fake browser, when each tool call arrives and is answered.
type callLog struct {
	mu     sync.Mutex
	events []string
}

func (l *callLog) add(e string) {
	l.mu.Lock()
	l.events = append(l.events, e)
	l.mu.Unlock()
}

func (l *callLog) get() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.events)
}

func callResult(id json.RawMessage, text string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":%q}]}}`, id, text)
}

func TestMCPToolCallsInArrivalOrder(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true)
	var log callLog
	f.onMCP = func(w http.ResponseWriter, r *http.Request, msg rpcMessage) {
		if msg.Method != "tools/call" {
			f.defaultMCP(w, msg)
			return
		}
		log.add("arrived " + string(msg.ID))
		if string(msg.ID) == "1" {
			time.Sleep(300 * time.Millisecond) // a slow navigate: the next call must wait for it
		}
		log.add("answered " + string(msg.ID))
		writeJSON(w, http.StatusOK, callResult(msg.ID, "done "+string(msg.ID)))
	}
	r := startMCP(t, c, "--profile="+profile)
	r.send(initializeMsg)
	r.recv()
	// Two calls piped together, as a client sends parallel tool calls, and a ping behind them.
	r.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com"}}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}` + "\n" +
		`{"jsonrpc":"2.0","id":3,"method":"ping"}`)
	if m := r.recv(); jget(m, "id") != 3.0 {
		t.Fatalf("first answer %v, want the ping's: only tool calls wait for each other", m)
	}
	got := r.recvByID(2)
	for _, id := range []string{"1", "2"} {
		if text := fmt.Sprint(jget(got[id], "result", "content")); !strings.Contains(text, "done "+id) {
			t.Errorf("call %s = %v", id, got[id])
		}
	}
	want := []string{"arrived 1", "answered 1", "arrived 2", "answered 2"}
	if events := log.get(); !slices.Equal(events, want) {
		t.Errorf("browser saw %q, want %q", events, want)
	}
}

func TestMCPOtherRequestsRunBesideToolCalls(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true)
	listed := make(chan struct{})
	var once sync.Once
	f.onMCP = func(w http.ResponseWriter, r *http.Request, msg rpcMessage) {
		switch msg.Method {
		case "tools/list":
			once.Do(func() { close(listed) })
			f.defaultMCP(w, msg)
		case "tools/call":
			// Answers only once tools/list has come in: it must not wait behind the call.
			text := "done"
			select {
			case <-listed:
			case <-time.After(5 * time.Second):
				text = "tools/list never came"
			}
			writeJSON(w, http.StatusOK, callResult(msg.ID, text))
		default:
			f.defaultMCP(w, msg)
		}
	}
	r := startMCP(t, c, "--profile="+profile)
	r.send(initializeMsg)
	r.recv()
	r.send(`{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}`)
	r.send(`{"jsonrpc":"2.0","id":11,"method":"tools/list"}`)
	got := r.recvByID(2)
	if text := fmt.Sprint(jget(got["10"], "result", "content")); !strings.Contains(text, "done") {
		t.Errorf("call = %v", got["10"])
	}
	if jget(got["11"], "result", "from") != "browser" {
		t.Errorf("tools/list = %v", got["11"])
	}
}

func TestMCPCancelQueuedToolCall(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true)
	var log callLog
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	f.onMCP = func(w http.ResponseWriter, r *http.Request, msg rpcMessage) {
		if msg.Method != "tools/call" {
			f.defaultMCP(w, msg)
			return
		}
		log.add("arrived " + string(msg.ID))
		if string(msg.ID) == "1" {
			started <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
			case <-time.After(10 * time.Second):
			}
		}
		log.add("answered " + string(msg.ID))
		writeJSON(w, http.StatusOK, callResult(msg.ID, "done "+string(msg.ID)))
	}
	r := startMCP(t, c, "--profile="+profile)
	r.send(initializeMsg)
	r.recv()
	for id := 1; id <= 3; id++ {
		r.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}`, id))
	}
	waitFor(t, started, "the first call to reach the browser")
	r.send(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}`)
	// Call 2 is answered at once, while call 1 is still running and call 3 still waits.
	m := r.recv()
	if jget(m, "id") != 2.0 || jget(m, "result", "isError") != true ||
		!strings.Contains(fmt.Sprint(jget(m, "result", "content")), "Cancelled") {
		t.Fatalf("answer %v, want call 2 cancelled", m)
	}
	time.Sleep(100 * time.Millisecond)
	if events := log.get(); !slices.Equal(events, []string{"arrived 1"}) {
		t.Fatalf("browser saw %q while call 1 was running", events)
	}
	close(release)
	got := r.recvByID(2)
	if !strings.Contains(fmt.Sprint(got["1"]), "done 1") || !strings.Contains(fmt.Sprint(got["3"]), "done 3") {
		t.Errorf("answers %v", got)
	}
	want := []string{"arrived 1", "answered 1", "arrived 3", "answered 3"}
	if events := log.get(); !slices.Equal(events, want) {
		t.Errorf("browser saw %q, want %q (call 2 never sent)", events, want)
	}
}

func TestMCPCancellation(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true)
	started := make(chan struct{}, 1)
	aborted := make(chan struct{}, 1)
	f.onMCP = func(w http.ResponseWriter, r *http.Request, msg rpcMessage) {
		if msg.Method != "tools/call" {
			f.defaultMCP(w, msg)
			return
		}
		started <- struct{}{}
		select {
		case <-r.Context().Done(): // lwb closed the request
			aborted <- struct{}{}
		case <-time.After(10 * time.Second):
			writeJSON(w, http.StatusOK, fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"content":[]}}`, msg.ID))
		}
	}
	r := startMCP(t, c, "--profile="+profile)
	r.send(initializeMsg)
	r.recv()
	r.send(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}`)
	waitFor(t, started, "the call to reach the browser")
	r.send(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7,"reason":"user pressed Esc"}}`)
	waitFor(t, aborted, "the HTTP request to be cancelled")
	r.send(`{"jsonrpc":"2.0","id":8,"method":"ping"}`)
	if m := r.recv(); jget(m, "id") != 8.0 {
		t.Fatalf("next answer = %v, want the ping's (none for the cancelled call)", m)
	}
	_, rest := r.finish()
	for _, raw := range rest {
		if strings.Contains(string(raw), `"id":7`) {
			t.Errorf("answer written for the cancelled request: %s", raw)
		}
	}
	if log := f.mcpLog(); !slices.Contains(log, "notifications/cancelled") {
		t.Errorf("the cancellation was not forwarded: %q", log)
	}
}

func TestMCPDeletesSessionOnEOF(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true)
	r := startMCP(t, c, "--profile="+profile, "--client=Harness")
	r.send(initializeMsg)
	r.recv()
	if code, _ := r.finish(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	reqs := f.requests()
	last := reqs[len(reqs)-1]
	if last.Method != http.MethodDelete || last.Path != "/mcp" {
		t.Fatalf("last request %s %s, want DELETE /mcp", last.Method, last.Path)
	}
	if last.Header.Get("X-Lwb-Session") != reqs[0].Header.Get("X-Lwb-Session") ||
		last.Header.Get("X-Lwb-Client") != "Harness" || last.Header.Get("Authorization") == "" {
		t.Errorf("DELETE headers %v", last.Header)
	}
}

func TestMCPRetriesAfterBrowserRestart(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	first := newFakeBrowser(t, profile, true)
	second := newFakeBrowser(t, profile, false)
	second.mu.Lock()
	second.token = strings.Repeat("cd", 32)
	second.mu.Unlock()
	var calls atomic.Int32
	first.onMCP = func(w http.ResponseWriter, r *http.Request, msg rpcMessage) {
		if msg.Method != "tools/call" {
			first.defaultMCP(w, msg)
			return
		}
		calls.Add(1)
		// The browser restarts in the middle of the call: a new server, port and token.
		second.publish()
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}
	r := startMCP(t, c, "--profile="+profile)
	r.send(initializeMsg)
	r.recv()
	r.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	time.Sleep(50 * time.Millisecond) // let the notification reach the first browser
	r.send(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser_snapshot","arguments":{}}}`)
	if m := r.recv(); jget(m, "id") != 5.0 || jget(m, "result", "from") != "browser" {
		t.Fatalf("tools/call answer = %v, want the restarted browser's", m)
	}
	r.finish()
	if calls.Load() != 1 {
		t.Errorf("first browser got %d calls", calls.Load())
	}
	want := []string{`initialize#"lwb-init-1"`, "notifications/initialized", "tools/call#5", "DELETE"}
	if log := second.mcpLog(); !slices.Equal(log, want) {
		t.Errorf("restarted browser saw %q, want %q", log, want)
	}
}

func TestMCPBatchWhileBrowserIsClosed(t *testing.T) {
	c, _, _ := newTestCLI(t, nil)
	r := startMCP(t, c, "--profile="+t.TempDir())
	r.send(`[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"tools/list"}]`)
	var answers []map[string]any
	if err := json.Unmarshal(r.recvRaw(), &answers); err != nil || len(answers) != 2 {
		t.Fatalf("batch answer %v (%v), want two answers in one array", answers, err)
	}
	r.send(`not json`)
	if m := r.recv(); jget(m, "error", "code") != -32700.0 || jget(m, "id") != nil {
		t.Errorf("parse error answer = %v", m)
	}
}
