package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var pngBytes = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR fake")

func TestCallPrintsTextAndSavesImages(t *testing.T) {
	c, stdout, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true)
	f.onCall = func(w http.ResponseWriter, r *http.Request, req callRequest) {
		writeJSON(w, http.StatusOK, `{"content":[`+
			`{"type":"text","text":"Navigated to https://example.com\n"},`+
			`{"type":"image","data":"`+base64.StdEncoding.EncodeToString(pngBytes)+`","mimeType":"image/png"},`+
			`{"type":"text","text":"Title: Example"}],"isError":false}`)
	}
	code := c.run([]string{"--profile=" + profile, "navigate", "https://example.com", "--tab", "3"})
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stdout)
	}

	reqs := f.requests()
	if len(reqs) != 1 || reqs[0].Path != "/v1/call" {
		t.Fatalf("requests %v", reqs)
	}
	var body map[string]any
	json.Unmarshal(reqs[0].Body, &body)
	if want := `map[args:map[tab:3 url:https://example.com] tool:browser_navigate]`; fmt.Sprint(body) != want {
		t.Errorf("body %v, want %s", body, want)
	}
	sum := sha256.Sum256([]byte(testCwd))
	h := reqs[0].Header
	if h.Get("X-Lwb-Client") != "lwb" || h.Get("X-Lwb-Session") != "lwb:"+hex.EncodeToString(sum[:])[:12] ||
		h.Get("X-Lwb-Label") != "demo-project" || h.Get("Authorization") != "Bearer "+f.token || h.Get("Origin") != "" {
		t.Errorf("headers %v", h)
	}

	img := filepath.Join(c.tempDir(), "ludworks-browser-agent", "browser_navigate-20261028-100000-1.png")
	want := "Navigated to https://example.com\n\n" +
		"Image saved: " + img + "\n" +
		"To look at it, open that file with your image viewing tool (Vision: view_image file_path=" + img + ").\n\n" +
		"Title: Example\n"
	if stdout.String() != want {
		t.Errorf("stdout:\n%s\nwant:\n%s", stdout, want)
	}
	if data, err := os.ReadFile(img); err != nil || !bytes.Equal(data, pngBytes) {
		t.Errorf("saved image: %v %q", err, data)
	}
}

func TestCallFailures(t *testing.T) {
	cases := []struct {
		name   string
		args   []string
		answer func(w http.ResponseWriter)
		code   int
		out    string
	}{
		{"tool error", []string{"click", "e9"},
			func(w http.ResponseWriter) {
				writeJSON(w, 200, `{"content":[{"type":"text","text":"No element e9 on the page."}],"isError":true}`)
			}, 1, "No element e9 on the page.\n"},
		{"client denied", []string{"snapshot"},
			func(w http.ResponseWriter) {
				writeJSON(w, 403, `{"error":"the user denied lwb"}`)
			}, 1, "Ludworks Browser refused the request: the user denied lwb\n"},
		{"unknown to the browser", []string{"snapshot"},
			func(w http.ResponseWriter) { writeJSON(w, 404, `{"error":"unknown tool browser_snapshot"}`) },
			1, "Ludworks Browser: unknown tool browser_snapshot (HTTP 404)\n"},
		{"unknown tool", []string{"naviagte", "x"}, nil, 2, "Did you mean browser_navigate?"},
		{"missing parameter", []string{"navigate"}, nil, 2, "missing required parameter --url"},
		{"bad parameter", []string{"navigate", "--uri=x"}, nil, 2, "Parameters: --url=STRING (required), --tab=INTEGER"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, stdout, _ := newTestCLI(t, nil)
			profile := t.TempDir()
			f := newFakeBrowser(t, profile, true)
			f.onCall = func(w http.ResponseWriter, r *http.Request, req callRequest) { tc.answer(w) }
			code := c.run(append([]string{"--profile=" + profile}, tc.args...))
			if code != tc.code || !strings.Contains(stdout.String(), tc.out) {
				t.Errorf("exit %d, stdout %q; want %d and %q", code, stdout, tc.code, tc.out)
			}
			if tc.answer == nil && len(f.requests()) != 0 {
				t.Errorf("a usage error reached the browser")
			}
		})
	}
}

func TestCallUnreachable(t *testing.T) {
	// A port nothing listens on.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadPort := l.Addr().(*net.TCPAddr).Port
	l.Close()

	cases := []struct {
		name  string
		setup func(profile string)
		out   string
	}{
		{"no endpoint file", func(string) {}, "it is not running, or AI agent access is off"},
		{"stale pid", func(p string) {
			writeEndpointFile(t, p, endpoint{Version: 1, Port: deadPort, Token: "t", PID: 1 << 30})
		}, "is stale (process 1073741824 is not running)"},
		{"connection refused", func(p string) {
			writeEndpointFile(t, p, endpoint{Version: 1, Port: deadPort, Token: "t", PID: os.Getpid()})
		}, fmt.Sprintf("nothing answers on 127.0.0.1:%d", deadPort)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, stdout, _ := newTestCLI(t, nil)
			profile := t.TempDir()
			tc.setup(profile)
			code := c.run([]string{"--profile=" + profile, "--no-launch", "snapshot"})
			out := stdout.String()
			if code != 1 || !strings.Contains(out, tc.out) || !strings.Contains(out, "Settings → AI agents") {
				t.Errorf("exit %d, stdout %q", code, out)
			}
		})
	}
}

func TestCallStartsBrowserNextToLwb(t *testing.T) {
	home := t.TempDir()
	c, stdout, stderr := newTestCLI(t, map[string]string{"HOME": home})
	// lwb is reached through a symlink, as /usr/bin/lwb is; the browser sits next to the real file.
	install := t.TempDir()
	for _, name := range []string{"lwb", "ludworks-browser"} {
		if err := os.WriteFile(filepath.Join(install, name), nil, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(t.TempDir(), "lwb")
	if err := os.Symlink(filepath.Join(install, "lwb"), link); err != nil {
		t.Skip("no symlinks here:", err)
	}
	c.executable = func() (string, error) { return link, nil }
	profile := filepath.Join(home, ".config", "ludworks-browser") // the default profile
	f := newFakeBrowser(t, profile, false)
	var started []string
	c.start = func(exe string, args []string, dir string) error {
		started = append([]string{exe, dir}, args...)
		f.publish()
		return nil
	}
	if code := c.run([]string{"--client=Vision", "snapshot", "--filter=interactive"}); code != 0 {
		t.Fatalf("exit %d: %s", code, stdout)
	}
	// The default profile is not passed on: the browser finds it itself.
	if real, err := filepath.EvalSymlinks(install); err == nil {
		install = real
	}
	want := []string{filepath.Join(install, "ludworks-browser"), install, "--agent-request=Vision"}
	if !slices.Equal(started, want) {
		t.Errorf("started %q, want %q", started, want)
	}
	if stdout.String() != "ok\n" || stderr.String() != "" {
		t.Errorf("stdout %q, stderr %q", stdout, stderr)
	}
}

func TestCallStartFailsClearly(t *testing.T) {
	c, stdout, _ := newTestCLI(t, nil) // no browser next to lwb
	code := c.run([]string{"--profile=" + t.TempDir(), "snapshot"})
	if out := stdout.String(); code != 1 || !strings.Contains(out, "does not exist") || !strings.Contains(out, "Settings → AI agents") {
		t.Errorf("exit %d, stdout %q", code, out)
	}

	exe := filepath.Join(t.TempDir(), "browser")
	os.WriteFile(exe, nil, 0o755)
	c, stdout, stderr := newTestCLI(t, map[string]string{"LWB_BROWSER": exe})
	c.start = func(string, []string, string) error { return nil } // starts, but never answers
	start := time.Now()
	code = c.run([]string{"--profile=" + t.TempDir(), "--wait=0.2", "--client=Vision", "snapshot"})
	if out := stdout.String(); code != 1 || !strings.Contains(out, "did not answer within") || !strings.Contains(out, "Settings → AI agents") {
		t.Errorf("exit %d, stdout %q", code, out)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("--wait=0.2 waited %s", time.Since(start))
	}
	if !strings.Contains(stderr.String(), `allow "Vision" in the browser window`) {
		t.Errorf("stderr %q", stderr)
	}
}

func TestCallRetriesWithNewToken(t *testing.T) {
	c, stdout, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	f := newFakeBrowser(t, profile, true) // the file has the old token
	f.mu.Lock()
	f.token = strings.Repeat("ef", 32) // the restarted browser has a new one…
	f.onBadToken = f.publish           // …and publishes it
	f.mu.Unlock()
	if code := c.run([]string{"--profile=" + profile, "snapshot"}); code != 0 || stdout.String() != "ok\n" {
		t.Fatalf("exit %d: %s", code, stdout)
	}
	if n := len(f.requests()); n != 2 {
		t.Errorf("%d requests, want the refused one and the retry", n)
	}
}

func TestRenderCapsOutput(t *testing.T) {
	text := func(s ...string) *toolResult {
		r := &toolResult{}
		for _, x := range s {
			r.Content = append(r.Content, contentPart{Type: "text", Text: x})
		}
		return r
	}
	note := func(n int) string { return fmt.Sprintf(cutNote, n) }
	cases := []struct {
		res  *toolResult
		max  int
		want string
	}{
		{text("abcdefghij"), 0, "abcdefghij\n"},
		{text("abcdefghij"), 10, "abcdefghij\n"},
		{text("abcdefghij"), 4, "abcd\n" + note(4) + "\n"},
		{text("äöüßxyz"), 3, "äöü\n" + note(3) + "\n"},
		{text("abc", "defgh", "ijk"), 5, "abc\n\nde\n" + note(5) + "\n"},
		{text("abc", "defgh"), 3, "abc\n\n" + note(3) + "\n"},
		{text("line 1\nline 2\n"), 7, "line 1\n" + note(7) + "\n"},
	}
	for _, tc := range cases {
		out, ok := render(tc.res, "browser_snapshot", tc.max, nil)
		if out != tc.want || !ok {
			t.Errorf("render(max %d) = %q, want %q", tc.max, out, tc.want)
		}
	}
	// Images are still reported after the text was cut.
	res := text("abcdef")
	res.Content = append(res.Content, contentPart{Type: "image", Data: "eA==", MimeType: "image/png"})
	out, _ := render(res, "browser_screenshot", 2, func(seq *int, p contentPart) (string, error) { return "/tmp/x.png", nil })
	if !strings.HasPrefix(out, "ab\n"+note(2)+"\n\nImage saved: /tmp/x.png\n") {
		t.Errorf("render = %q", out)
	}
}

func TestSaveImage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "images")
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	b64 := func(b []byte) string { return base64.StdEncoding.EncodeToString(b) }
	jpeg := []byte("\xff\xd8\xff\xe0 fake jpeg")
	// Another call already saved image 1 in this second.
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "browser_screenshot-20260102-030405-1.png"), nil, 0o600)

	seq := 1
	cases := []struct {
		part contentPart
		name string
		data []byte
	}{
		{contentPart{Type: "image", Data: b64(pngBytes), MimeType: "image/png"}, "browser_screenshot-20260102-030405-2.png", pngBytes},
		{contentPart{Type: "image", Data: b64(jpeg), MimeType: "image/jpeg"}, "browser_screenshot-20260102-030405-3.jpg", jpeg},
		{contentPart{Type: "image", Data: b64(pngBytes)}, "browser_screenshot-20260102-030405-4.png", pngBytes}, // type sniffed
		{contentPart{Type: "image", Data: "data:image/webp;base64," + b64([]byte("RIFFxxxxWEBPVP8 ")), MimeType: "image/webp"},
			"browser_screenshot-20260102-030405-5.webp", []byte("RIFFxxxxWEBPVP8 ")},
	}
	for _, tc := range cases {
		p, err := saveImage(dir, true, "browser_screenshot", now, &seq, tc.part)
		if err != nil || p != filepath.Join(dir, tc.name) {
			t.Errorf("saveImage = %q, %v; want %s", p, err, tc.name)
			continue
		}
		if data, _ := os.ReadFile(p); !bytes.Equal(data, tc.data) {
			t.Errorf("%s holds %q", tc.name, data)
		}
	}
	if _, err := saveImage(dir, true, "browser_screenshot", now, &seq, contentPart{Data: "%%%"}); err == nil {
		t.Error("bad base64 was accepted")
	}
	// The default directory under the shared temp directory must not be a link someone planted.
	link := filepath.Join(t.TempDir(), "planted")
	if os.Symlink(dir, link) == nil {
		if _, err := saveImage(link, true, "browser_screenshot", now, &seq, cases[0].part); err == nil {
			t.Error("saved through a symlinked default directory")
		}
		if _, err := saveImage(link, false, "browser_screenshot", now, &seq, cases[0].part); err != nil {
			t.Errorf("an --out-dir given by the user may be a link: %v", err)
		}
	}
}
