package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestReadEndpoint(t *testing.T) {
	dir := t.TempDir()
	b := &browser{file: filepath.Join(dir, endpointFile), pidAlive: pidAlive}
	write := func(s string) {
		t.Helper()
		if err := os.WriteFile(b.file, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	unreachable := func(what string) {
		t.Helper()
		ep, err := b.readEndpoint()
		var ue *unreachableError
		if !errors.As(err, &ue) || !strings.Contains(err.Error(), what) {
			t.Errorf("%s: got %v, %v", what, ep, err)
		}
	}
	unreachable("it is not running, or AI agent access is off")
	write(`{"version":1,"port":47821,"tok`)
	unreachable("incomplete or damaged")
	write(`{"version":1,"port":47821}`)
	unreachable("incomplete or damaged")
	write(`{"version":1,"port":70000,"token":"x"}`)
	unreachable("incomplete or damaged")
	write(`{"version":1,"port":47821,"token":"a b"}`)
	unreachable("incomplete or damaged")
	write(`{"version":1,"port":47821,"token":"x","pid":1073741824}`)
	unreachable("is stale (process 1073741824 is not running)")

	write("\ufeff" + `{"version":1,"port":47821,"token":"` + strings.Repeat("0f", 32) + `","pid":` +
		strconv.Itoa(os.Getpid()) + `,"app":"0.1.2","started":"2026-10-28T10:00:00Z"}`)
	ep, err := b.readEndpoint()
	if err != nil || ep.Port != 47821 || ep.App != "0.1.2" || len(ep.Token) != 64 {
		t.Errorf("live endpoint: %+v, %v", ep, err)
	}
	write(`{"version":1,"port":47821,"token":"x"}`) // no pid: nothing to check
	if _, err := b.readEndpoint(); err != nil {
		t.Errorf("endpoint without pid: %v", err)
	}
}

func TestPIDAlive(t *testing.T) {
	if !pidAlive(os.Getpid()) {
		t.Error("this process is not alive")
	}
	for _, pid := range []int{0, -1, 1 << 30} {
		if pidAlive(pid) {
			t.Errorf("pid %d alive", pid)
		}
	}
}

func TestProfileDir(t *testing.T) {
	env := map[string]string{"LWB_PROFILE": "/env/profile", "HOME": "/home/u", "XDG_CONFIG_HOME": "/xdg"}
	c, _, _ := newTestCLI(t, env)
	dir, explicit, err := c.profileDir(&options{profile: "/flag/profile"})
	if dir != absPath("/flag/profile") || !explicit || err != nil {
		t.Errorf("flag: %s %v %v", dir, explicit, err)
	}
	if dir, explicit, _ = c.profileDir(&options{}); dir != absPath("/env/profile") || !explicit {
		t.Errorf("env: %s %v", dir, explicit)
	}
	delete(env, "LWB_PROFILE")
	if dir, explicit, _ = c.profileDir(&options{}); dir != filepath.Join("/xdg", "ludworks-browser") || explicit {
		t.Errorf("default: %s %v", dir, explicit)
	}
	// A relative profile is made absolute: the browser runs in another directory.
	if dir, _, _ = c.profileDir(&options{profile: "rel"}); !filepath.IsAbs(dir) {
		t.Errorf("relative: %s", dir)
	}

	cases := []struct {
		goos string
		env  map[string]string
		want string
	}{
		{"windows", map[string]string{"LOCALAPPDATA": `C:\Users\u\AppData\Local`}, filepath.Join(`C:\Users\u\AppData\Local`, "Ludworks Browser", "User Data")},
		{"windows", map[string]string{"USERPROFILE": `C:\Users\u`}, filepath.Join(`C:\Users\u`, "AppData", "Local", "Ludworks Browser", "User Data")},
		{"darwin", map[string]string{"HOME": "/Users/u"}, filepath.Join("/Users/u", "Library", "Application Support", "Ludworks Browser")},
		{"linux", map[string]string{"HOME": "/home/u"}, filepath.Join("/home/u", ".config", "ludworks-browser")},
		{"linux", map[string]string{"HOME": "/home/u", "XDG_CONFIG_HOME": "/cfg"}, filepath.Join("/cfg", "ludworks-browser")},
		{"linux", map[string]string{}, ""},
	}
	for _, tc := range cases {
		if got := defaultProfile(tc.goos, func(k string) string { return tc.env[k] }); got != tc.want {
			t.Errorf("defaultProfile(%s, %v) = %q, want %q", tc.goos, tc.env, got, tc.want)
		}
	}
}

func TestIdentity(t *testing.T) {
	sum := sha256.Sum256([]byte(testCwd))
	cwdHash := hex.EncodeToString(sum[:])[:12]
	cases := []struct {
		env                    map[string]string
		o                      options
		mcp                    bool
		client, session, label string
		fixed                  bool
	}{
		{nil, options{}, false, "lwb", "lwb:" + cwdHash, "demo-project", false},
		{map[string]string{"VISION_AGENT": "1"}, options{}, false, "Vision", "Vision:" + cwdHash, "demo-project", true},
		{map[string]string{"VISION_AGENT": "1", "LWB_CLIENT": "Env"}, options{}, false, "Env", "Env:" + cwdHash, "demo-project", true},
		{map[string]string{"LWB_CLIENT": "Env", "LWB_SESSION": "s-env"}, options{client: "Flag\r\nX", label: "L"}, false, "Flag  X", "s-env", "L", true},
		{nil, options{session: "s-flag"}, true, "lwb", "s-flag", "demo-project", false},
		{nil, options{session: "s-flag", label: "Mine"}, true, "lwb", "s-flag", "Mine", false},
	}
	for _, tc := range cases {
		c, _, _ := newTestCLI(t, tc.env)
		id, fixed := c.identity(&tc.o, tc.mcp)
		client, session, label := id.get()
		if client != tc.client || session != tc.session || label != tc.label || fixed != tc.fixed {
			t.Errorf("%v %+v: got %q %q %q %v", tc.env, tc.o, client, session, label, fixed)
		}
	}
	c, _, _ := newTestCLI(t, nil)
	a, _ := c.identity(&options{}, true)
	b, _ := c.identity(&options{}, true)
	_, sa, _ := a.get()
	_, sb, _ := b.get()
	if !uuidRe.MatchString(sa) || sa == sb {
		t.Errorf("mcp sessions %q, %q: want a fresh UUID per run", sa, sb)
	}
}

func TestStatusCommand(t *testing.T) {
	c, stdout, _ := newTestCLI(t, nil)
	profile := t.TempDir()
	if code := c.run([]string{"status", "--profile=" + profile}); code != 1 ||
		!strings.Contains(stdout.String(), filepath.Join(profile, endpointFile)) || !strings.Contains(stdout.String(), "not reachable") {
		t.Errorf("unreachable: exit %d\n%s", code, stdout)
	}

	c, stdout, _ = newTestCLI(t, nil)
	f := newFakeBrowser(t, profile, true)
	f.statusBody = `{"ok":true,"app":"0.1.2","access":false}`
	if code := c.run([]string{"--profile=" + profile, "status"}); code != 0 ||
		!strings.Contains(stdout.String(), "App version:      0.1.2") || !strings.Contains(stdout.String(), "AI agent access:  off") {
		t.Errorf("reachable: exit %d\n%s", code, stdout)
	}
}
