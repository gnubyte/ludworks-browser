package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func mustTool(t *testing.T, name string) *tool {
	t.Helper()
	cat, err := builtinCatalog()
	if err != nil {
		t.Fatal(err)
	}
	tl := cat.find(name)
	if tl == nil {
		t.Fatalf("no tool %q", name)
	}
	return tl
}

func TestParseToolArgs(t *testing.T) {
	cases := []struct {
		tool  string
		words []string
		stdin string
		want  string // fmt.Sprint of the arguments, or "error: <part of the message>"
	}{
		{"navigate", []string{"--url=https://a.example/?q=1&r=2"}, "", "map[url:https://a.example/?q=1&r=2]"},
		{"navigate", []string{"--url", "https://a.example", "--tab", "3"}, "", "map[tab:3 url:https://a.example]"},
		{"navigate", []string{"https://a.example"}, "", "map[url:https://a.example]"},
		{"browser_navigate", []string{"--tab=2", "https://a.example"}, "", "map[tab:2 url:https://a.example]"},
		{"navigate", []string{`--json={"url":"https://j.example","tab":3}`}, "", "map[tab:3 url:https://j.example]"},
		{"navigate", []string{"--json", `{"url":"https://j.example"}`, "--tab=4"}, "", "map[tab:4 url:https://j.example]"},
		{"navigate", []string{`--json={"url":"https://j.example","tab":3}`, "--tab=5"}, "", "map[tab:5 url:https://j.example]"},
		// Empty values are dropped: templates pass '' for parameters the model left out.
		{"navigate", []string{"https://a.example", "--tab="}, "", "map[url:https://a.example]"},
		{"navigate", []string{"--tab", "", "--url=", "https://a.example"}, "", "map[url:https://a.example]"},
		{"navigate", []string{`--json={"url":"https://j.example","tab":""}`}, "", "map[url:https://j.example]"},
		// --stdin, with a UTF-8 BOM; flags win over it.
		{"navigate", []string{"--stdin"}, "\uFEFF{\"url\":\"https://s.example\",\"tab\":\"\"}\r\n", "map[url:https://s.example]"},
		{"navigate", []string{"--stdin", "--url=https://flag.example"}, `{"url":"https://s.example","tab":7}`, "map[tab:7 url:https://flag.example]"},
		{"navigate", []string{"--stdin", "https://pos.example"}, `{"url":"https://s.example"}`, "map[url:https://pos.example]"},
		{"snapshot", []string{"--stdin"}, "", "map[]"},
		// Booleans may stand alone; --full-page finds full_page.
		{"screenshot", []string{"--full_page"}, "", "map[full_page:true]"},
		{"screenshot", []string{"--full-page", "false", "--tab", "2"}, "", "map[full_page:false tab:2]"},
		{"click", []string{"--x", "-5", "--y=10"}, "", "map[x:-5 y:10]"},
		// No single required parameter: a lone value is the ref; without a ref there is no place for it.
		{"click", []string{"e12"}, "", "map[ref:e12]"},
		{"click", []string{"--tab=2", "e12"}, "", "map[ref:e12 tab:2]"},
		{"click", []string{"e12", "--ref=e13"}, "", "error: given twice"},
		{"click", []string{"--ref", "e12", "--", "--"}, "", "error: given twice"},
		{"screenshot", []string{"e3"}, "", "error: unexpected value"},
		// A ref-shaped value is the ref even when another parameter is the required one.
		{"type", []string{"e3", "--text=hi"}, "", "map[ref:e3 text:hi]"},
		{"type", []string{"hello"}, "", "map[text:hello]"},
		{"type", []string{"e3"}, "", "error: missing required parameter --text"},
		{"type", []string{"e3", "--ref=e4", "--text=x"}, "", "error: given twice"},
		{"navigate", []string{"--", "--odd-but-literal"}, "", "map[url:--odd-but-literal]"},
		// Mistakes.
		{"navigate", nil, "", "error: missing required parameter --url"},
		{"navigate", []string{"--tab=1", "--url="}, "", "error: missing required parameter --url"},
		{"navigate", []string{"a", "b"}, "", "error: too many values"},
		{"navigate", []string{"--bogus=1", "--url=x"}, "", "error: has no parameter --bogus"},
		{"navigate", []string{"--url"}, "", "error: --url needs a value"},
		{"navigate", []string{"--url", "--tab=1"}, "", "error: --url needs a value"},
		{"navigate", []string{"https://a", "--url=https://b"}, "", "error: given twice"},
		{"navigate", []string{"--json=[1]"}, "", "error: expected a JSON object"},
		{"navigate", []string{`--json={"url":"x"} {}`}, "", "error: unexpected text after the JSON object"},
		{"navigate", []string{`--json={"nope":1}`, "--url=x"}, "", `error: has no parameter "nope"`},
		{"navigate", []string{"--stdin"}, `{"url":`, "error: --stdin"},
	}
	for _, tc := range cases {
		t.Run(tc.tool+" "+strings.Join(tc.words, " "), func(t *testing.T) {
			var o options
			args, err := parseToolArgs(mustTool(t, tc.tool), tc.words, &o, strings.NewReader(tc.stdin))
			got := fmt.Sprint(args)
			if err != nil {
				got = "error: " + err.Error()
			}
			if strings.HasPrefix(tc.want, "error: ") {
				if err == nil || !strings.Contains(got, strings.TrimPrefix(tc.want, "error: ")) {
					t.Errorf("got %s, want %s", got, tc.want)
				}
			} else if got != tc.want {
				t.Errorf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestToolArgsKeepJSONNumbers(t *testing.T) {
	var o options
	args, err := parseToolArgs(mustTool(t, "click"), []string{`--json={"x":12.50,"y":1e2}`}, &o, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(callRequest{Tool: "browser_click", Args: args})
	if want := `{"tool":"browser_click","args":{"x":12.50,"y":1e2}}`; string(body) != want {
		t.Errorf("body %s, want %s", body, want)
	}
}

func TestToolArgsUTF16Stdin(t *testing.T) {
	u := utf16.Encode([]rune(`{"url":"https://ü.example"}`))
	b := []byte{0xFF, 0xFE}
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	var o options
	args, err := parseToolArgs(mustTool(t, "navigate"), []string{"--stdin"}, &o, strings.NewReader(string(b)))
	if err != nil || args["url"] != "https://ü.example" {
		t.Errorf("args %v, %v", args, err)
	}
}

func TestGlobalFlags(t *testing.T) {
	var o options
	o.wait = defaultWait
	rest, err := parseFlags([]string{"--profile", "/p", "--client=Vision", "-session=s1", "--label=L", "--wait=2.5",
		"--no-launch", "--out_dir=/o", "--max-output", "100", "--verbose=false", "--ps-quoted", "navigate", "--url=x"}, &o)
	if err != nil {
		t.Fatal(err)
	}
	if o.profile != "/p" || o.client != "Vision" || o.session != "s1" || o.label != "L" || o.wait != 2500*time.Millisecond ||
		!o.noLaunch || o.outDir != "/o" || o.maxOutput != 100 || o.verbose || !o.psQuoted {
		t.Errorf("options %+v", o)
	}
	if strings.Join(rest, " ") != "navigate --url=x" {
		t.Errorf("rest %q", rest)
	}
	// Empty values from templates leave the defaults alone.
	o = options{wait: defaultWait}
	if _, err := parseFlags([]string{"--wait=", "--max-output=", "--no-launch=", "--client=", "status"}, &o); err != nil {
		t.Fatal(err)
	}
	if o.wait != defaultWait || o.maxOutput != 0 || o.noLaunch || o.client != "" {
		t.Errorf("options %+v", o)
	}
	for _, bad := range [][]string{{"--bogus"}, {"--wait=soon"}, {"--max-output=-1"}, {"--profile"}, {"--no-launch=maybe"}} {
		if _, err := parseFlags(bad, &options{}); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}

	// After the tool name, a global flag is one unless the tool has a parameter of that name.
	o = options{}
	args, err := parseToolArgs(mustTool(t, "navigate"), []string{"--url=x", "--max-output=50", "--no-launch", "--wait", "3"}, &o, nil)
	if err != nil || fmt.Sprint(args) != "map[url:x]" || o.maxOutput != 50 || !o.noLaunch || o.wait != 3*time.Second {
		t.Errorf("args %v, err %v, options %+v", args, err, o)
	}
}

func TestPSUnquote(t *testing.T) {
	cases := []struct{ in, want string }{
		{"'hello world'", "hello world"},
		{"bare", "bare"},
		{"https://a.example/?x=1", "https://a.example/?x=1"},
		{"'it''s'", "it's"},
		{"'say \u2018\u2018hi\u2019\u2019'", "say \u2018hi\u2019"},
		{"'a\u201A\u201Ab\u201B\u201Bc'", "a\u201Ab\u201Bc"},
		{"'''quoted'''", "'quoted'"},
		{"'line 1\r\nline 2\r\n'", "line 1\nline 2\n"},
		{"plain\r\ntext", "plain\ntext"},
		{"''", ""},
		{"'", "'"},
		{"'a'b'", "a'b"},
		{"'ünïcode ✓'", "ünïcode ✓"},
	}
	for _, tc := range cases {
		if got := psUnquote(tc.in); got != tc.want {
			t.Errorf("psUnquote(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestPSQuotedArgs(t *testing.T) {
	o := options{psQuoted: true}
	// What a Vision PowerShell template pipes in: a BOM, literals, '' for a left-out parameter, CRLF.
	stdin := "\uFEFF{\"url\":\"'https://x.example/?a=1&b=''2'''\",\"tab\":\"''\"}\r\n"
	args, err := parseToolArgs(mustTool(t, "navigate"), []string{"--stdin"}, &o, strings.NewReader(stdin))
	if err != nil || fmt.Sprint(args) != "map[url:https://x.example/?a=1&b='2']" {
		t.Errorf("args %v, err %v", args, err)
	}
	// A key the tool does not have is refused rather than sent.
	stdin = `{"url":"'https://x.example'","filter":"interactive"}`
	if _, err := parseToolArgs(mustTool(t, "navigate"), []string{"--stdin"}, &o, strings.NewReader(stdin)); err == nil ||
		!strings.Contains(err.Error(), `"filter"`) {
		t.Errorf("err %v", err)
	}
	// The flag and positional values are unquoted too.
	args, err = parseToolArgs(mustTool(t, "navigate"), []string{"'https://p.example/it''s'", "--tab='3'"}, &o, nil)
	if err != nil || fmt.Sprint(args) != "map[tab:3 url:https://p.example/it's]" {
		t.Errorf("args %v, err %v", args, err)
	}
	// A value that is only '' is dropped like an empty one.
	if _, err := parseToolArgs(mustTool(t, "navigate"), []string{"''"}, &o, nil); err == nil ||
		!strings.Contains(err.Error(), "missing required parameter --url") {
		t.Errorf("err %v", err)
	}
}
