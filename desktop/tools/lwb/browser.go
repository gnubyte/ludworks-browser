package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	endpointFile   = "agent-endpoint.json"
	connectTimeout = 3 * time.Second
	statusTimeout  = 5 * time.Second
	maxResponse    = 256 << 20 // a full-page screenshot arrives base64-encoded in one answer
	accessHint     = "Ludworks Browser → Settings → AI agents"
)

// endpoint is <profile>/agent-endpoint.json, which the browser writes while its agent server
// runs and deletes when it stops.
type endpoint struct {
	Version int    `json:"version"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
	App     string `json:"app"`
	Started string `json:"started"`
}

// key identifies one run of the agent server: a restart writes a new token.
func (e *endpoint) key() string { return strconv.Itoa(e.Port) + "/" + e.Token }

// unreachableError: nothing answers for the profile (no endpoint file, a stale one, or a refused
// connection). Starting the browser may help.
type unreachableError struct{ reason string }

func (e *unreachableError) Error() string { return "Ludworks Browser is not reachable: " + e.reason }

// transportError is a failed exchange with the agent server.
type transportError struct {
	err  error
	dial bool // the connection could not be opened
}

func (e *transportError) Error() string { return e.err.Error() }
func (e *transportError) Unwrap() error { return e.err }

// statusError is an answer other than 2xx; the browser explains it in {"error": "…"}.
type statusError struct {
	code int
	msg  string
}

func (e *statusError) Error() string {
	switch e.code {
	case http.StatusUnauthorized:
		return "Ludworks Browser did not accept lwb's access token: " + e.msg
	case http.StatusForbidden:
		return "Ludworks Browser refused the request: " + e.msg
	}
	return fmt.Sprintf("Ludworks Browser: %s (HTTP %d)", e.msg, e.code)
}

func newStatusError(code int, body []byte) *statusError {
	var e struct {
		Error string `json:"error"`
	}
	msg := ""
	if json.Unmarshal(body, &e) == nil {
		msg = e.Error
	}
	if msg == "" {
		msg = strings.TrimSpace(string(body))
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
	}
	if msg == "" {
		msg = http.StatusText(code)
	}
	return &statusError{code, msg}
}

// launchError: the browser could not be started, or did not come up in time. The message says
// what the user can do.
type launchError struct{ msg string }

func (e *launchError) Error() string { return e.msg }

var errAccessOff = errors.New("AI agent access is off")

// statusInfo is the answer of GET /v1/status.
type statusInfo struct {
	OK     bool   `json:"ok"`
	App    string `json:"app"`
	Access *bool  `json:"access"`
}

// browser talks to the agent server of one profile.
type browser struct {
	profile    string
	explicit   bool // the profile came from --profile or LWB_PROFILE: a started browser must use it too
	file       string
	id         *identity
	httpc      *http.Client
	log        *log.Logger
	stderr     io.Writer
	wait       time.Duration
	poll       time.Duration
	getenv     func(string) string
	executable func() (string, error)
	start      func(exe string, args []string, dir string) error
	pidAlive   func(int) bool
	goos       string

	mu   sync.Mutex
	ep   *endpoint // endpoint in use
	dead string    // key of an endpoint whose port refused the connection

	launchMu    sync.Mutex
	launchErr   error // the last failed start, not retried for a moment (concurrent tool calls)
	launchErrAt time.Time
}

func newHTTPClient() *http.Client {
	return &http.Client{
		// No overall timeout: a call may wait minutes for a page, or for the user to allow the client.
		Transport: &http.Transport{
			Proxy:               nil, // 127.0.0.1 only, never through a proxy
			DialContext:         (&net.Dialer{Timeout: connectTimeout}).DialContext,
			MaxIdleConnsPerHost: 16,
			// Below the agent server's 30 s keep-alive, so lwb never sends on a connection the
			// server is closing.
			IdleConnTimeout:    20 * time.Second,
			DisableCompression: true,
		},
		// The bearer token must not follow a redirect anywhere else.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// readEndpoint reads the endpoint file and checks that its process is still alive.
func (b *browser) readEndpoint() (*endpoint, error) {
	data, err := os.ReadFile(b.file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, &unreachableError{"it is not running, or AI agent access is off (there is no " + b.file + ")"}
	}
	if err != nil {
		return nil, &unreachableError{fmt.Sprintf("cannot read %s: %v", b.file, err)}
	}
	var ep endpoint
	if json.Unmarshal(bytes.TrimPrefix(data, utf8BOM), &ep) != nil || ep.Port <= 0 || ep.Port > math.MaxUint16 ||
		ep.Token == "" || strings.ContainsFunc(ep.Token, func(r rune) bool { return r <= ' ' || r >= 0x7f }) {
		return nil, &unreachableError{b.file + " is incomplete or damaged"}
	}
	if ep.PID > 0 && !b.pidAlive(ep.PID) {
		return nil, &unreachableError{fmt.Sprintf("%s is stale (process %d is not running)", b.file, ep.PID)}
	}
	return &ep, nil
}

// current returns the endpoint to use, reading the endpoint file if needed. When the browser is
// not reachable and launch is set, it starts the browser and waits for it.
func (b *browser) current(ctx context.Context, launch bool) (*endpoint, error) {
	b.mu.Lock()
	ep := b.ep
	b.mu.Unlock()
	if ep != nil {
		return ep, nil
	}
	ep, err := b.readEndpoint()
	if err == nil {
		b.mu.Lock()
		if ep.key() == b.dead {
			err = &unreachableError{fmt.Sprintf("nothing answers on 127.0.0.1:%d", ep.Port)}
		} else {
			b.ep = ep
		}
		b.mu.Unlock()
	}
	if err == nil {
		return ep, nil
	}
	var ue *unreachableError
	if !launch || !errors.As(err, &ue) {
		return nil, err
	}
	return b.launchAndWait(ctx)
}

// use makes ep the endpoint in use.
func (b *browser) use(ep *endpoint) {
	b.mu.Lock()
	b.ep = ep
	if b.dead == ep.key() {
		b.dead = ""
	}
	b.mu.Unlock()
}

// forget drops ep after a failed exchange; refused marks it as dead until a fresh one appears.
func (b *browser) forget(ep *endpoint, refused bool) {
	b.mu.Lock()
	if b.ep != nil && b.ep.key() == ep.key() {
		b.ep = nil
	}
	if refused {
		b.dead = ep.key()
	}
	b.mu.Unlock()
}

// send makes one request to the agent server.
func (b *browser) send(ctx context.Context, ep *endpoint, method, path string, body []byte) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://127.0.0.1:"+strconv.Itoa(ep.Port)+path, rd)
	if err != nil {
		return 0, nil, err
	}
	client, session, label := b.id.get()
	h := req.Header
	h.Set("Authorization", "Bearer "+ep.Token)
	h.Set("X-Lwb-Client", client)
	h.Set("X-Lwb-Session", session)
	h.Set("X-Lwb-Label", label)
	h.Set("User-Agent", "lwb/"+lwbVersion())
	h.Set("Accept", "application/json")
	if body != nil {
		h.Set("Content-Type", "application/json")
	}
	resp, err := b.httpc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, nil, ctx.Err()
		}
		var oe *net.OpError
		return 0, nil, &transportError{err: err, dial: errors.As(err, &oe) && oe.Op == "dial"}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		if ctx.Err() != nil {
			return 0, nil, ctx.Err()
		}
		return 0, nil, &transportError{err: err}
	}
	if len(data) > maxResponse {
		return 0, nil, fmt.Errorf("the answer of Ludworks Browser is larger than %d MB", maxResponse>>20)
	}
	return resp.StatusCode, data, nil
}

// roundTrip sends a request, starting the browser first when it is not reachable and launch is
// set. When the exchange breaks (the browser quit or restarted), or a restarted browser refuses
// the old token, it looks the browser up again and retries once. prepare, if set, runs before
// each attempt with the endpoint about to be used.
func (b *browser) roundTrip(ctx context.Context, method, path string, body []byte, launch bool,
	prepare func(context.Context, *endpoint) error) (*endpoint, int, []byte, error) {
	for attempt := 0; ; attempt++ {
		ep, err := b.current(ctx, launch)
		if err != nil {
			return nil, 0, nil, err
		}
		code, data := 0, []byte(nil)
		if prepare != nil {
			err = prepare(ctx, ep)
		}
		if err == nil {
			code, data, err = b.send(ctx, ep, method, path, body)
		}
		var te *transportError
		if errors.As(err, &te) {
			b.forget(ep, te.dial)
			if attempt == 0 {
				b.log.Printf("%s %s: %v; looking for the browser again", method, path, err)
				continue
			}
			if te.dial {
				err = &unreachableError{fmt.Sprintf("nothing answers on 127.0.0.1:%d", ep.Port)}
			}
			return ep, 0, nil, err
		}
		if err == nil && code == http.StatusUnauthorized && attempt == 0 {
			// A restarted browser has a new token, possibly on the same port.
			if fresh, ferr := b.readEndpoint(); ferr == nil && fresh.Token != ep.Token {
				b.forget(ep, false)
				continue
			}
		}
		return ep, code, data, err
	}
}

// probe reads the endpoint file and asks GET /v1/status, which answers at once.
func (b *browser) probe(ctx context.Context) (*endpoint, *statusInfo, error) {
	ep, err := b.readEndpoint()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	code, data, err := b.send(ctx, ep, http.MethodGet, "/v1/status", nil)
	var te *transportError
	if errors.As(err, &te) && te.dial {
		return ep, nil, &unreachableError{fmt.Sprintf("nothing answers on 127.0.0.1:%d", ep.Port)}
	}
	if err != nil {
		return ep, nil, err
	}
	if code != http.StatusOK {
		return ep, nil, newStatusError(code, data)
	}
	var st statusInfo
	if json.Unmarshal(data, &st) != nil || !st.OK {
		return ep, nil, fmt.Errorf("unexpected status answer: %.200s", data)
	}
	return ep, &st, nil
}

// launchAndWait starts the browser (a running one gets the arguments from its second instance)
// and waits until the agent server answers and AI agent access is on.
func (b *browser) launchAndWait(ctx context.Context) (*endpoint, error) {
	b.launchMu.Lock()
	defer b.launchMu.Unlock()
	// A concurrent call may have brought it up while this one waited for the lock.
	if ep, st, err := b.probe(ctx); err == nil && (st.Access == nil || *st.Access) {
		b.use(ep)
		return ep, nil
	}
	if b.launchErr != nil && time.Since(b.launchErrAt) < 2*time.Second {
		return nil, b.launchErr
	}
	ep, err := b.launch(ctx)
	if err != nil && ctx.Err() == nil {
		b.launchErr, b.launchErrAt = err, time.Now()
	}
	return ep, err
}

func (b *browser) launch(ctx context.Context) (*endpoint, error) {
	exe, args, err := b.command()
	if err != nil {
		return nil, err
	}
	b.log.Printf("starting %s %q", exe, args)
	if err := b.start(exe, args, filepath.Dir(exe)); err != nil {
		return nil, &launchError{fmt.Sprintf("Ludworks Browser is not reachable and could not be started (%s: %v). Start it yourself and turn on AI agent access: %s.", exe, err, accessHint)}
	}
	deadline := time.Now().Add(b.wait)
	warned := false
	for {
		ep, st, err := b.probe(ctx)
		if err == nil {
			if st.Access == nil || *st.Access {
				b.use(ep)
				return ep, nil
			}
			err = errAccessOff
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var se *statusError
		if errors.As(err, &se) && se.code == http.StatusForbidden {
			return nil, err // the user turned this client down
		}
		b.log.Printf("waiting for the browser: %v", err)
		if !warned {
			client, _, _ := b.id.get()
			fmt.Fprintf(b.stderr, "Waiting for Ludworks Browser — allow \"%s\" in the browser window…\n", client)
			warned = true
		}
		if !time.Now().Before(deadline) {
			if errors.Is(err, errAccessOff) {
				return nil, &launchError{"Ludworks Browser is running, but AI agent access is off. Turn it on in " + accessHint + ", then try again."}
			}
			client, _, _ := b.id.get()
			return nil, &launchError{fmt.Sprintf("Ludworks Browser did not answer within %g s. Turn on AI agent access in %s (and allow \"%s\" when the browser asks), then try again.",
				b.wait.Seconds(), accessHint, client)}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(b.poll):
		}
	}
}

// command finds the browser executable and its arguments: $LWB_BROWSER (plus $LWB_BROWSER_APP,
// an app directory for unpackaged runs), else the executable installed next to lwb.
func (b *browser) command() (string, []string, error) {
	var exe string
	var args []string
	if p := b.getenv("LWB_BROWSER"); p != "" {
		exe = absPath(p)
		if app := b.getenv("LWB_BROWSER_APP"); app != "" {
			args = append(args, absPath(app)) // the browser runs in its own directory
		}
	} else {
		self, err := b.executable()
		if err != nil {
			return "", nil, &launchError{fmt.Sprintf("Ludworks Browser is not reachable, and lwb cannot tell where it is installed (%v). Start it yourself, or set LWB_BROWSER to its executable.", err)}
		}
		if real, err := filepath.EvalSymlinks(self); err == nil {
			self = real // /usr/bin/lwb links into the installation
		}
		exe = filepath.Join(filepath.Dir(self), browserExecutable(b.goos))
	}
	if fi, err := os.Stat(exe); err != nil || fi.IsDir() {
		return "", nil, &launchError{fmt.Sprintf("Ludworks Browser is not reachable, and lwb cannot start it: %s does not exist. Start the browser yourself (or set LWB_BROWSER to its executable) and turn on AI agent access: %s.", exe, accessHint)}
	}
	client, _, _ := b.id.get()
	args = append(args, "--agent-request="+client)
	if b.explicit {
		args = append(args, "--user-data-dir="+b.profile)
	}
	return exe, args, nil
}

// browserExecutable is the name of the browser executable that sits next to lwb.
func browserExecutable(goos string) string {
	switch goos {
	case "windows":
		return "LudworksBrowser.exe"
	case "darwin":
		return "Ludworks Browser" // lwb is in Ludworks Browser.app/Contents/MacOS too
	}
	return "ludworks-browser"
}

func absPath(p string) string {
	if a, err := filepath.Abs(p); err == nil {
		return a
	}
	return p
}

// browserEnv is lwb's environment without ELECTRON_RUN_AS_NODE: a harness built on Electron may
// set it for its children, and it would turn an unpackaged browser into plain Node.
func browserEnv() []string {
	return slices.DeleteFunc(os.Environ(), func(kv string) bool {
		k, _, _ := strings.Cut(kv, "=")
		return strings.EqualFold(k, "ELECTRON_RUN_AS_NODE")
	})
}

// explain is the text shown for a failed call.
func explain(err error, noLaunch bool) string {
	var ue *unreachableError
	var te *transportError
	switch {
	case errors.As(err, &ue):
		msg := ue.Error() + ". Start Ludworks Browser and turn on AI agent access: " + accessHint + "."
		if noLaunch {
			msg += " (lwb runs with --no-launch, so it does not start the browser.)"
		}
		return msg
	case errors.As(err, &te):
		return "Lost the connection to Ludworks Browser: " + te.err.Error()
	case errors.Is(err, context.Canceled):
		return "Cancelled."
	}
	return err.Error()
}
