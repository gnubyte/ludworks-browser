package main

import (
	"slices"
	"testing"
)

func TestSplitCommandLine(t *testing.T) {
	cases := []struct {
		cmd  string
		want []string
	}{
		{`lwb.exe navigate https://example.com`, []string{"lwb.exe", "navigate", "https://example.com"}},
		{"lwb\tnavigate\t\t x  ", []string{"lwb", "navigate", "x"}},
		// cmd.exe quoting as Vision writes it: quotes doubled inside a quoted argument.
		{`lwb type --text="say ""hi"" now"`, []string{"lwb", "type", `--text=say "hi" now`}},
		{`lwb "say ""hi"" now"`, []string{"lwb", `say "hi" now`}},
		{`lwb --text="He said ""hi"""`, []string{"lwb", `--text=He said "hi"`}},
		{`lwb """"`, []string{"lwb", `"`}},
		{`lwb "50"%" off"`, []string{"lwb", "50% off"}},
		// Empty arguments.
		{`lwb a "" b`, []string{"lwb", "a", "", "b"}},
		{`lwb ""`, []string{"lwb", ""}},
		{`lwb --url=""`, []string{"lwb", "--url="}},
		// Backslashes: literal unless they precede a quote.
		{`lwb C:\dir\file a\\b`, []string{"lwb", `C:\dir\file`, `a\\b`}},
		{`lwb a\"b`, []string{"lwb", `a"b`}},
		{`lwb a\\\"b`, []string{"lwb", `a\"b`}},
		{`lwb a\\"b c"`, []string{"lwb", `a\b c`}},
		{`lwb "C:\dir\\" next`, []string{"lwb", `C:\dir\`, "next"}},
		{`lwb "a\\\\" b`, []string{"lwb", `a\\`, "b"}},
		{`lwb "a\\\\\"b"`, []string{"lwb", `a\\"b`}},
		{`lwb trailing\`, []string{"lwb", `trailing\`}},
		// The program path: quotes group, backslashes are plain.
		{`"C:\Program Files\Ludworks Browser\lwb.exe" status`, []string{`C:\Program Files\Ludworks Browser\lwb.exe`, "status"}},
		{`C:\"Program Files"\lwb.exe status`, []string{`C:\Program Files\lwb.exe`, "status"}},
		{`"C:\dir\\" next`, []string{`C:\dir\\`, "next"}},
		{``, []string{""}},
		// Multibyte text passes through.
		{`lwb "ünï ✓" ok`, []string{"lwb", "ünï ✓", "ok"}},
	}
	for _, tc := range cases {
		if got := splitCommandLine(tc.cmd); !slices.Equal(got, tc.want) {
			t.Errorf("splitCommandLine(%s) = %q, want %q", tc.cmd, got, tc.want)
		}
	}
}
