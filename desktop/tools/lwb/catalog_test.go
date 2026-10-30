package main

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// TestGeneratedCatalog checks the shape of tools.json, which builds embed. The browser build
// writes it from the browser's tool registry, so its wording is not tested here.
func TestGeneratedCatalog(t *testing.T) {
	data, err := os.ReadFile("tools.json")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := parseCatalog(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Tools) < 20 {
		t.Errorf("tools.json has %d tools, want at least 20", len(cat.Tools))
	}
	for i, raw := range cat.Tools {
		var tl struct {
			Name        string `json:"name"`
			InputSchema struct {
				Type string `json:"type"`
			} `json:"inputSchema"`
		}
		if err := json.Unmarshal(raw, &tl); err != nil || !strings.HasPrefix(tl.Name, "browser_") || tl.InputSchema.Type != "object" {
			t.Errorf("tool %d: name %q, inputSchema type %q, %v", i, tl.Name, tl.InputSchema.Type, err)
		}
	}
}

// TestFixtureCatalog checks testdata/catalog.json, which TestMain puts in place of tools.json.
func TestFixtureCatalog(t *testing.T) {
	cat, err := builtinCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.tools) == 0 || len(cat.tools) != len(cat.Tools) {
		t.Fatalf("%d tools", len(cat.tools))
	}
	var info struct{ Name, Version string }
	if json.Unmarshal(cat.ServerInfo, &info) != nil || info.Name == "" || info.Version == "" || cat.Instructions == "" {
		t.Errorf("serverInfo %s, instructions %q", cat.ServerInfo, cat.Instructions)
	}
	for _, tl := range cat.tools {
		if !strings.HasPrefix(tl.Name, "browser_") || tl.Description == "" {
			t.Errorf("tool %+v", tl)
		}
		for _, r := range tl.InputSchema.Required {
			if _, p := tl.param(r); p == nil {
				t.Errorf("%s requires undeclared %s", tl.Name, r)
			}
		}
	}
	if nav := cat.find("navigate"); nav == nil || !slices.Equal(nav.InputSchema.Properties.names, []string{"url", "tab"}) {
		t.Errorf("navigate parameters out of schema order")
	}
}

func TestFindAndSuggest(t *testing.T) {
	cat, _ := builtinCatalog()
	for _, name := range []string{"navigate", "browser_navigate", "Navigate", " navigate "} {
		if tl := cat.find(name); tl == nil || tl.Name != "browser_navigate" {
			t.Errorf("find(%q) = %v", name, tl)
		}
	}
	if tl := cat.find("full-page"); tl != nil {
		t.Errorf("find(full-page) = %s", tl.Name)
	}
	cases := []struct {
		name string
		want []string
	}{
		{"naviagte", []string{"browser_navigate"}},
		{"browser_scrennshot", []string{"browser_screenshot"}},
		{"snap", []string{"browser_snapshot"}},
		{"xyzzy-plugh", nil},
	}
	for _, tc := range cases {
		if got := cat.suggest(tc.name); !slices.Equal(got, tc.want) {
			t.Errorf("suggest(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestFirstSentence(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Open a URL. Then wait.", "Open a URL."},
		{"Click an element, e.g. a button. More.", "Click an element, e.g. a button."},
		{"Version 1.2 is here! Yes.", "Version 1.2 is here!"},
		{"Take a\nscreenshot of the tab. More", "Take a screenshot of the tab."},
		{"First paragraph without a stop\n\nSecond paragraph.", "First paragraph without a stop"},
		{"No stop at all", "No stop at all"},
		{"Ends here.", "Ends here."},
		{"Use `tab`. `ref` wins.", "Use `tab`."},
		{"Close one or all of them. action=share asks the user.", "Close one or all of them."},
		{"Choose options (i.e. values). More.", "Choose options (i.e. values)."},
	}
	for _, tc := range cases {
		if got := firstSentence(tc.in); got != tc.want {
			t.Errorf("firstSentence(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestHelpAndToolsCommands(t *testing.T) {
	c, stdout, _ := newTestCLI(t, nil)
	if code := c.run([]string{"help", "navigate"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	for _, want := range []string{"browser_navigate — Navigate", "Usage: lwb navigate <url> [--tab=INTEGER]",
		"--url=STRING  (required)", "The address to open", "lwb navigate <url>."} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("help lacks %q:\n%s", want, stdout)
		}
	}
	c, stdout, _ = newTestCLI(t, nil)
	if code := c.run([]string{"snapshot", "--help"}); code != 0 || !strings.Contains(stdout.String(), "--filter=interactive|all") ||
		!strings.Contains(stdout.String(), "Default: all") || !strings.Contains(stdout.String(), "Read-only") {
		t.Errorf("snapshot --help: exit %d\n%s", code, stdout)
	}
	// No single required parameter: a lone value is the ref.
	c, stdout, _ = newTestCLI(t, nil)
	if code := c.run([]string{"help", "click"}); code != 0 ||
		!strings.Contains(stdout.String(), "Usage: lwb click [<ref>] [--x=NUMBER] [--y=NUMBER] [--tab=INTEGER]") ||
		!strings.Contains(stdout.String(), "The value of --ref can also be given on its own: lwb click <ref>.") {
		t.Errorf("help click: exit %d\n%s", code, stdout)
	}

	// tools: from the embedded catalog while the browser is closed.
	c, stdout, _ = newTestCLI(t, nil)
	profile := t.TempDir()
	if code := c.run([]string{"--profile=" + profile, "tools"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	lines := strings.Split(strings.TrimSuffix(stdout.String(), "\n"), "\n")
	cat, _ := builtinCatalog()
	if len(lines) != len(cat.tools) || lines[0] != "browser_navigate    Open a URL in a tab and wait for the page to load." {
		t.Errorf("tools:\n%s", stdout)
	}

	// tools --json: the browser's catalog when it answers.
	f := newFakeBrowser(t, profile, true)
	f.toolsBody = `{"serverInfo":{"name":"ludworks-browser","version":"9.9.9"},"tools":[{"name":"browser_only_live","description":"Live. Tool.","inputSchema":{"type":"object"}}]}`
	c, stdout, _ = newTestCLI(t, nil)
	if code := c.run([]string{"tools", "--json", "--profile=" + profile}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var live catalog
	if err := json.Unmarshal([]byte(stdout.String()), &live); err != nil || len(live.Tools) != 1 || !strings.Contains(stdout.String(), "9.9.9") {
		t.Errorf("tools --json:\n%s", stdout)
	}
	// The plain list stays the embedded catalog, which tool calls are checked against.
	c, stdout, _ = newTestCLI(t, nil)
	if code := c.run([]string{"tools", "--profile=" + profile}); code != 0 || strings.Contains(stdout.String(), "browser_only_live") ||
		!strings.HasPrefix(stdout.String(), "browser_navigate ") {
		t.Errorf("tools with the browser up:\n%s", stdout)
	}

	c, stdout, _ = newTestCLI(t, nil)
	if code := c.run([]string{"version"}); code != 0 || !strings.HasPrefix(stdout.String(), "lwb 0.0.0 (go") {
		t.Errorf("version: %q", stdout)
	}
	c, stdout, _ = newTestCLI(t, nil)
	if code := c.run(nil); code != 2 || !strings.Contains(stdout.String(), "Usage:") {
		t.Errorf("no arguments: exit %d", code)
	}
	c, _, stderr := newTestCLI(t, nil)
	if code := c.run([]string{"mcp", "--bogus"}); code != 2 || !strings.Contains(stderr.String(), "unknown flag --bogus") {
		t.Errorf("mcp usage error: exit %d, stderr %q", code, stderr)
	}
}
