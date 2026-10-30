package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestMain runs the tests against testdata/catalog.json, a fixed catalog, instead of tools.json,
// which the browser build regenerates from the browser's tool registry (TestGeneratedCatalog
// checks that one).
func TestMain(m *testing.M) {
	data, err := os.ReadFile(filepath.Join("testdata", "catalog.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "lwb tests:", err)
		os.Exit(1)
	}
	embeddedCatalog = data
	builtinCatalog = sync.OnceValues(func() (*catalog, error) { return parseCatalog(embeddedCatalog) })
	m.Run()
}

// lockedBuffer is a bytes.Buffer that goroutines may write to concurrently.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

const testCwd = "/work/demo-project"

// newTestCLI returns a cli with a fake environment. Starting a browser fails the test unless the
// test replaces start.
func newTestCLI(t *testing.T, env map[string]string) (*cli, *lockedBuffer, *lockedBuffer) {
	t.Helper()
	stdout, stderr := new(lockedBuffer), new(lockedBuffer)
	tmp := t.TempDir()
	c := &cli{
		stdin:      strings.NewReader(""),
		stdout:     stdout,
		stderr:     stderr,
		getenv:     func(k string) string { return env[k] },
		getwd:      func() (string, error) { return testCwd, nil },
		executable: func() (string, error) { return filepath.Join(tmp, "bin", "lwb"), nil },
		start: func(exe string, args []string, dir string) error {
			t.Errorf("unexpected browser start: %s %q", exe, args)
			return errors.New("tests start no browsers")
		},
		pidAlive: pidAlive,
		now:      func() time.Time { return time.Date(2026, 10, 28, 10, 0, 0, 0, time.Local) },
		tempDir:  func() string { return tmp },
		goos:     "linux",
		poll:     10 * time.Millisecond,
	}
	return c, stdout, stderr
}

// seenRequest is a request the fake browser received.
type seenRequest struct {
	Method, Path string
	Header       http.Header
	Body         []byte
}

// fakeBrowser is an agent server in the shape of the browser's, on 127.0.0.1, for one profile.
type fakeBrowser struct {
	t       *testing.T
	srv     *httptest.Server
	profile string

	mu         sync.Mutex
	token      string
	seen       []seenRequest
	onBadToken func() // called before answering 401

	statusBody string
	toolsBody  string
	onCall     func(w http.ResponseWriter, r *http.Request, req callRequest)
	onMCP      func(w http.ResponseWriter, r *http.Request, msg rpcMessage)
}

// newFakeBrowser starts the server; publish writes its endpoint file right away.
func newFakeBrowser(t *testing.T, profile string, publish bool) *fakeBrowser {
	t.Helper()
	f := &fakeBrowser{
		t:          t,
		profile:    profile,
		token:      strings.Repeat("ab", 32),
		statusBody: `{"ok":true,"app":"0.1.2","access":true}`,
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	if publish {
		f.publish()
	}
	return f
}

func (f *fakeBrowser) port() int {
	u, _ := url.Parse(f.srv.URL)
	p, _ := strconv.Atoi(u.Port())
	return p
}

// publish writes the endpoint file, as the browser does when its agent server starts.
func (f *fakeBrowser) publish() {
	f.mu.Lock()
	token := f.token
	f.mu.Unlock()
	writeEndpointFile(f.t, f.profile, endpoint{Version: 1, Port: f.port(), Token: token, PID: os.Getpid(),
		App: "0.1.2", Started: "2026-10-28T10:00:00Z"})
}

func writeEndpointFile(t *testing.T, profile string, ep endpoint) {
	t.Helper()
	data, _ := json.Marshal(ep)
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, endpointFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	io.WriteString(w, body)
}

func (f *fakeBrowser) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.seen = append(f.seen, seenRequest{r.Method, r.URL.Path, r.Header.Clone(), body})
	token, onBad := f.token, f.onBadToken
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+token {
		if onBad != nil {
			onBad()
		}
		writeJSON(w, http.StatusUnauthorized, `{"error":"bad token"}`)
		return
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /v1/status":
		writeJSON(w, http.StatusOK, f.statusBody)
	case "GET /v1/tools":
		if f.toolsBody == "" {
			writeJSON(w, http.StatusOK, string(embeddedCatalog))
		} else {
			writeJSON(w, http.StatusOK, f.toolsBody)
		}
	case "POST /v1/call":
		var req callRequest
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, `{"error":"bad body"}`)
			return
		}
		if f.onCall != nil {
			f.onCall(w, r, req)
			return
		}
		writeJSON(w, http.StatusOK, `{"content":[{"type":"text","text":"ok"}],"isError":false}`)
	case "POST /mcp":
		var msg rpcMessage
		if err := json.Unmarshal(body, &msg); err != nil {
			writeJSON(w, http.StatusBadRequest, `{"error":"bad body"}`)
			return
		}
		if f.onMCP != nil {
			f.onMCP(w, r, msg)
			return
		}
		f.defaultMCP(w, msg)
	case "DELETE /mcp":
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSON(w, http.StatusNotFound, `{"error":"not found"}`)
	}
}

// defaultMCP answers requests with a result naming the method, and accepts notifications.
func (f *fakeBrowser) defaultMCP(w http.ResponseWriter, msg rpcMessage) {
	if !msg.isRequest() {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeJSON(w, http.StatusOK, fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"from":"browser","method":%q}}`, msg.ID, msg.Method))
}

func (f *fakeBrowser) requests() []seenRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]seenRequest(nil), f.seen...)
}

// mcpLog lists the POST /mcp messages as "method" or "method#id", and DELETE /mcp.
func (f *fakeBrowser) mcpLog() []string {
	var out []string
	for _, r := range f.requests() {
		switch {
		case r.Method == http.MethodDelete && r.Path == "/mcp":
			out = append(out, "DELETE")
		case r.Method == http.MethodPost && r.Path == "/mcp":
			var m rpcMessage
			json.Unmarshal(r.Body, &m)
			if len(m.ID) > 0 {
				out = append(out, m.Method+"#"+string(m.ID))
			} else {
				out = append(out, m.Method)
			}
		}
	}
	return out
}

// mcpRun is `lwb mcp` running in a goroutine with piped stdin and stdout.
type mcpRun struct {
	t     *testing.T
	in    *io.PipeWriter
	lines chan json.RawMessage
	code  chan int
	once  sync.Once
	exit  int
}

func startMCP(t *testing.T, c *cli, flags ...string) *mcpRun {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	c.stdin, c.stdout = inR, outW
	r := &mcpRun{t: t, in: inW, lines: make(chan json.RawMessage, 64), code: make(chan int, 1)}
	go func() {
		code := c.run(append([]string{"mcp"}, flags...))
		outW.Close()
		r.code <- code
	}()
	go func() {
		defer close(r.lines)
		sc := bufio.NewScanner(outR)
		sc.Buffer(nil, 64<<20)
		for sc.Scan() {
			r.lines <- json.RawMessage(append([]byte(nil), sc.Bytes()...))
		}
	}()
	t.Cleanup(func() { r.finish() })
	return r
}

func (r *mcpRun) send(line string) {
	r.t.Helper()
	if _, err := io.WriteString(r.in, line+"\n"); err != nil {
		r.t.Fatalf("writing to lwb mcp: %v", err)
	}
}

// recvRaw returns the next stdout line, which must be JSON.
func (r *mcpRun) recvRaw() json.RawMessage {
	r.t.Helper()
	select {
	case raw, ok := <-r.lines:
		if !ok {
			r.t.Fatal("lwb mcp closed stdout")
		}
		if !json.Valid(raw) {
			r.t.Fatalf("stdout line is not JSON: %q", raw)
		}
		return raw
	case <-time.After(10 * time.Second):
		r.t.Fatal("no message from lwb mcp")
	}
	return nil
}

func (r *mcpRun) recv() map[string]any {
	r.t.Helper()
	raw := r.recvRaw()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		r.t.Fatalf("not a JSON object: %s", raw)
	}
	return m
}

// recvByID collects n answers, which may come in any order, by their id's JSON text.
func (r *mcpRun) recvByID(n int) map[string]map[string]any {
	r.t.Helper()
	out := map[string]map[string]any{}
	for range n {
		m := r.recv()
		id, _ := json.Marshal(m["id"])
		out[string(id)] = m
	}
	return out
}

// finish closes stdin and returns the exit status and the lines written after the last recv.
func (r *mcpRun) finish() (int, []json.RawMessage) {
	var rest []json.RawMessage
	r.once.Do(func() {
		r.in.Close()
		select {
		case r.exit = <-r.code:
		case <-time.After(10 * time.Second):
			r.t.Error("lwb mcp did not exit after stdin closed")
			r.exit = -1
			return
		}
		for raw := range r.lines {
			rest = append(rest, raw)
		}
	})
	return r.exit, rest
}

// jget walks a decoded JSON value: jget(m, "result", "tools").
func jget(v any, keys ...string) any {
	for _, k := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

func waitFor(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}
