package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

// The MCP bridge. An MCP client (Claude Code, …) starts `lwb mcp` and speaks newline-delimited
// JSON-RPC on stdin and stdout; lwb hands every message to the browser's POST /mcp unchanged and
// writes back what the browser answers. Clients start their MCP servers eagerly, usually while the
// browser is closed, so initialize, tools/list and ping are then answered from the embedded
// catalog, and the browser is started only when a tool is actually called.

const (
	defaultProtocolVersion = "2025-06-18"
	// exitGrace is how long answers in progress may still take after stdin closes, so that a
	// client piping a few requests and closing stdin still gets them.
	exitGrace = 2 * time.Second
)

// rpcMessage is a JSON-RPC 2.0 message from the client, as far as the bridge looks into it.
type rpcMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func (m *rpcMessage) isRequest() bool { return m.Method != "" && len(m.ID) > 0 }

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func resultResponse(id json.RawMessage, result any) []byte {
	b, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", ID: idOrNull(id), Result: result})
	return b
}

func errorResponse(id json.RawMessage, code int, msg string) []byte {
	b, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", ID: idOrNull(id), Error: &rpcError{code, msg}})
	return b
}

func idOrNull(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

// idKey identifies a request id: 1 and "1" are different ids.
func idKey(id json.RawMessage) string { return string(bytes.TrimSpace(id)) }

type textContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// toolError is a tools/call result explaining a failure. It is a result, not a JSON-RPC error,
// so the model reads the explanation.
func toolError(text string) any {
	return struct {
		Content []textContent `json:"content"`
		IsError bool          `json:"isError"`
	}{[]textContent{{"text", text}}, true}
}

// lineWriter writes one JSON message per line. In mcp mode nothing else goes to stdout.
type lineWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (lw *lineWriter) write(msg []byte) {
	var buf bytes.Buffer
	if json.Compact(&buf, msg) != nil {
		return
	}
	buf.WriteByte('\n')
	lw.mu.Lock()
	defer lw.mu.Unlock()
	lw.w.Write(buf.Bytes())
}

type bridge struct {
	b      *browser
	out    *lineWriter
	log    *log.Logger
	launch bool // start the browser for tools/call
	fixed  bool // the client name came from a flag or the environment, not from initialize

	mu       sync.Mutex
	inflight map[string]*inflightCall // requests in progress, by id
	lastCall chan struct{}            // closed when the latest tool call in the queue is over
	reached  bool                     // the browser has seen this session: end it on exit

	initMu         sync.Mutex
	initParams     json.RawMessage // the client's initialize params
	sawInitialized bool            // the client sent notifications/initialized
	initedKey      string          // endpoint key of the browser run that has seen initialize

	replayMu sync.Mutex
	replays  int
}

type inflightCall struct {
	cancel context.CancelFunc
	// cancelled by notifications/cancelled: a call already sent gets no answer, one still in
	// the queue is answered as cancelled.
	cancelled bool
}

func (c *cli) runMCP(ctx context.Context, o *options) int {
	b, fixed, err := c.newBrowser(o, true)
	if err != nil {
		fmt.Fprintln(c.stderr, "lwb:", err)
		return 1
	}
	br := &bridge{
		b:        b,
		out:      &lineWriter{w: c.stdout},
		log:      b.log,
		launch:   !o.noLaunch,
		fixed:    fixed,
		inflight: map[string]*inflightCall{},
		lastCall: make(chan struct{}),
	}
	close(br.lastCall) // the first tool call does not wait
	br.serve(ctx, c.stdin)
	return 0
}

// serve reads messages until stdin closes or ctx ends (a signal), then ends the browser session.
func (br *bridge) serve(ctx context.Context, in io.Reader) {
	lines := make(chan []byte)
	go func() {
		defer close(lines)
		r := bufio.NewReaderSize(in, 64<<10)
		for {
			line, err := r.ReadBytes('\n') // no line length limit: arguments can be large
			if len(bytes.TrimSpace(line)) > 0 {
				select {
				case lines <- line:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	reqCtx, cancelAll := context.WithCancel(ctx)
	defer cancelAll()
	var wg sync.WaitGroup
read:
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				break read
			}
			br.dispatch(reqCtx, &wg, line)
		case <-ctx.Done():
			break read
		}
	}
	if ctx.Err() == nil {
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(exitGrace):
		case <-ctx.Done(): // a signal: stop waiting
		}
	}
	cancelAll()
	br.endSession()
}

func (br *bridge) dispatch(ctx context.Context, wg *sync.WaitGroup, line []byte) {
	line = bytes.TrimSpace(line)
	if line[0] != '[' {
		br.dispatchOne(ctx, wg, line, br.out.write)
		return
	}
	// A batch: each message is handled on its own, and the answers go back as one array.
	var items []json.RawMessage
	if err := json.Unmarshal(line, &items); err != nil {
		br.out.write(errorResponse(nil, -32700, "Parse error: "+err.Error()))
		return
	}
	if len(items) == 0 {
		br.out.write(errorResponse(nil, -32600, "Invalid Request: empty batch"))
		return
	}
	var mu sync.Mutex
	var answers []json.RawMessage
	collect := func(r []byte) {
		mu.Lock()
		answers = append(answers, r)
		mu.Unlock()
	}
	var bwg sync.WaitGroup
	for _, raw := range items {
		br.dispatchOne(ctx, &bwg, raw, collect)
	}
	wg.Go(func() {
		bwg.Wait()
		if len(answers) > 0 {
			if b, err := json.Marshal(answers); err == nil {
				br.out.write(b)
			}
		}
	})
}

// dispatchOne handles one message. What depends on arrival order (the client name, cancellation,
// registering the request, a tool call's place in the queue) happens here; the exchange with the
// browser runs concurrently, except that tool calls reach it one at a time, in arrival order:
// browser actions build on each other (navigate, then find), and a client may send several at once.
func (br *bridge) dispatchOne(ctx context.Context, wg *sync.WaitGroup, raw []byte, emit func([]byte)) {
	var m rpcMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		if json.Valid(raw) {
			emit(errorResponse(nil, -32600, "Invalid Request"))
		} else {
			emit(errorResponse(nil, -32700, "Parse error: "+err.Error()))
		}
		return
	}
	br.observe(&m)
	if !m.isRequest() {
		wg.Go(func() { br.notify(ctx, &m, raw) })
		return
	}
	key := idKey(m.ID)
	rctx, cancel := context.WithCancel(ctx)
	call := &inflightCall{cancel: cancel}
	var turn, done chan struct{} // the previous tool call is over; this one is
	br.mu.Lock()
	br.inflight[key] = call
	if m.Method == "tools/call" {
		turn, done = br.lastCall, make(chan struct{})
		br.lastCall = done
	}
	br.mu.Unlock()
	wg.Go(func() {
		defer cancel()
		queued := false // cancelled before its turn came
		if turn != nil {
			select {
			case <-turn:
			case <-rctx.Done():
			}
			queued = rctx.Err() != nil
		}
		var resp []byte
		if !queued {
			resp = br.request(rctx, &m, raw)
		}
		if done != nil {
			if queued {
				// Never sent: the calls behind it still wait for the one before it.
				go func() { <-turn; close(done) }()
			} else {
				close(done)
			}
		}
		br.mu.Lock()
		if br.inflight[key] == call {
			delete(br.inflight, key)
		}
		cancelled := call.cancelled
		br.mu.Unlock()
		switch {
		case queued && cancelled:
			emit(resultResponse(m.ID, toolError("Cancelled before it was sent to Ludworks Browser.")))
		case resp != nil && !cancelled:
			emit(resp)
		}
	})
}

// observe records what later messages depend on, in arrival order.
func (br *bridge) observe(m *rpcMessage) {
	switch m.Method {
	case "initialize":
		if !m.isRequest() {
			return
		}
		var p struct {
			ClientInfo struct {
				Name string `json:"name"`
			} `json:"clientInfo"`
		}
		_ = json.Unmarshal(m.Params, &p)
		if !br.fixed {
			br.b.id.setClient(p.ClientInfo.Name)
		}
		br.initMu.Lock()
		br.initParams = m.Params
		if len(br.initParams) == 0 {
			br.initParams = json.RawMessage("{}")
		}
		br.initedKey = ""
		br.initMu.Unlock()
	case "notifications/initialized":
		br.initMu.Lock()
		br.sawInitialized = true
		br.initMu.Unlock()
	case "notifications/cancelled":
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		if json.Unmarshal(m.Params, &p) == nil && len(p.RequestID) > 0 {
			br.mu.Lock()
			if call := br.inflight[idKey(p.RequestID)]; call != nil {
				call.cancelled = true
				call.cancel() // closes the HTTP request; the notification is forwarded as well
			}
			br.mu.Unlock()
		}
	}
}

// request forwards a request and returns the answer to write, or nil when the client cancelled it.
func (br *bridge) request(ctx context.Context, m *rpcMessage, raw []byte) []byte {
	launch := br.launch && m.Method == "tools/call"
	var prepare func(context.Context, *endpoint) error
	if m.Method != "initialize" {
		prepare = br.replayInit(false)
	}
	ep, code, body, err := br.b.roundTrip(ctx, http.MethodPost, "/mcp", raw, launch, prepare)
	if ctx.Err() != nil {
		return nil
	}
	if err == nil {
		br.markReached()
		switch {
		case code == http.StatusOK && json.Valid(body):
			if m.Method == "initialize" {
				br.initMu.Lock()
				br.initedKey = ep.key()
				br.initMu.Unlock()
			}
			br.log.Printf("%s %s: forwarded", m.Method, m.ID)
			return body
		case code/100 == 2:
			err = fmt.Errorf("Ludworks Browser sent no usable answer (HTTP %d)", code)
		default:
			err = newStatusError(code, body)
		}
	}
	br.log.Printf("%s %s: %v", m.Method, m.ID, err)
	if m.Method == "tools/call" {
		return resultResponse(m.ID, toolError(explain(err, !br.launch)))
	}
	if r := br.local(m); r != nil {
		return r
	}
	var ue *unreachableError
	if errors.As(err, &ue) {
		return errorResponse(m.ID, -32601, "Method not found: "+m.Method)
	}
	return errorResponse(m.ID, -32603, explain(err, !br.launch))
}

var errSkip = errors.New("not forwarded: this browser run has not seen the session's initialize")

// notify forwards a notification (or a response to a server request) if the browser is reachable;
// it never starts the browser, and otherwise drops the message.
func (br *bridge) notify(ctx context.Context, m *rpcMessage, raw []byte) {
	prepare := br.onlyInitialized
	if m.Method == "notifications/initialized" {
		prepare = br.replayInit(true)
	}
	_, code, body, err := br.b.roundTrip(ctx, http.MethodPost, "/mcp", raw, false, prepare)
	switch {
	case err != nil:
		br.log.Printf("%s: not forwarded: %v", m.Method, err)
	case code/100 != 2:
		br.markReached()
		br.log.Printf("%s: %v", m.Method, newStatusError(code, body))
	default:
		br.markReached()
	}
}

// onlyInitialized holds back notifications from a browser run that has not seen initialize:
// they would refer to nothing there.
func (br *bridge) onlyInitialized(_ context.Context, ep *endpoint) error {
	br.initMu.Lock()
	defer br.initMu.Unlock()
	if br.initParams != nil && br.initedKey != ep.key() {
		return errSkip
	}
	return nil
}

// replayInit returns a roundTrip prepare hook. A browser run that has not seen this session's
// initialize (it was answered locally while the browser was closed, or the browser restarted)
// gets the client's initialize first, then notifications/initialized if the client sent it and
// the message being forwarded is not that notification itself.
func (br *bridge) replayInit(isInitialized bool) func(context.Context, *endpoint) error {
	return func(ctx context.Context, ep *endpoint) error {
		br.replayMu.Lock() // one replay at a time; the reader goroutine never waits for this lock
		defer br.replayMu.Unlock()
		br.initMu.Lock()
		params, saw, done := br.initParams, br.sawInitialized, br.initedKey == ep.key()
		br.initMu.Unlock()
		if params == nil || done {
			return nil
		}
		br.replays++
		req, err := json.Marshal(struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      string          `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}{"2.0", fmt.Sprintf("lwb-init-%d", br.replays), "initialize", params})
		if err != nil {
			return err
		}
		code, body, err := br.b.send(ctx, ep, http.MethodPost, "/mcp", req)
		if err != nil {
			return err
		}
		br.markReached()
		if code != http.StatusOK {
			return newStatusError(code, body)
		}
		var answer struct {
			Error *rpcError `json:"error"`
		}
		if json.Unmarshal(body, &answer) == nil && answer.Error != nil {
			return fmt.Errorf("Ludworks Browser did not accept the session: %s", answer.Error.Message)
		}
		if saw && !isInitialized {
			code, body, err = br.b.send(ctx, ep, http.MethodPost, "/mcp", []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
			if err != nil {
				return err
			}
			if code/100 != 2 {
				return newStatusError(code, body)
			}
		}
		br.log.Printf("sent the client's initialize to the browser on port %d", ep.Port)
		br.initMu.Lock()
		br.initedKey = ep.key()
		br.initMu.Unlock()
		return nil
	}
}

type initializeResult struct {
	ProtocolVersion string          `json:"protocolVersion"`
	Capabilities    json.RawMessage `json:"capabilities"`
	ServerInfo      json.RawMessage `json:"serverInfo"`
	Instructions    string          `json:"instructions,omitempty"`
}

// local answers what the bridge can answer without the browser, from the embedded catalog.
func (br *bridge) local(m *rpcMessage) []byte {
	switch m.Method {
	case "initialize", "tools/list":
		cat, err := builtinCatalog()
		if err != nil {
			return errorResponse(m.ID, -32603, err.Error())
		}
		if m.Method == "tools/list" {
			tools := cat.Tools
			if tools == nil {
				tools = []json.RawMessage{}
			}
			return resultResponse(m.ID, struct {
				Tools []json.RawMessage `json:"tools"`
			}{tools})
		}
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(m.Params, &p)
		res := initializeResult{
			ProtocolVersion: p.ProtocolVersion,
			Capabilities:    json.RawMessage(`{"tools":{"listChanged":false}}`),
			ServerInfo:      cat.ServerInfo,
			Instructions:    cat.Instructions,
		}
		if res.ProtocolVersion == "" {
			res.ProtocolVersion = defaultProtocolVersion
		}
		if len(res.ServerInfo) == 0 {
			res.ServerInfo = json.RawMessage(`{"name":"ludworks-browser","version":"0.0.0"}`)
		}
		return resultResponse(m.ID, res)
	case "ping":
		return resultResponse(m.ID, struct{}{})
	case "resources/list":
		return resultResponse(m.ID, struct {
			Resources []struct{} `json:"resources"`
		}{[]struct{}{}})
	case "prompts/list":
		return resultResponse(m.ID, struct {
			Prompts []struct{} `json:"prompts"`
		}{[]struct{}{}})
	}
	return nil
}

func (br *bridge) markReached() {
	br.mu.Lock()
	br.reached = true
	br.mu.Unlock()
}

// endSession tells the browser the client has gone (DELETE /mcp): best effort, for a second.
func (br *bridge) endSession() {
	br.mu.Lock()
	reached := br.reached
	br.mu.Unlock()
	if !reached {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ep, err := br.b.current(ctx, false)
	if err != nil {
		return
	}
	code, _, err := br.b.send(ctx, ep, http.MethodDelete, "/mcp", nil)
	br.log.Printf("DELETE /mcp: %d %v", code, err)
}
