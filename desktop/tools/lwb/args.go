package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// usageError is a mistake on the command line (exit status 2).
type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usagef(format string, a ...any) error { return &usageError{fmt.Sprintf(format, a...)} }

// errHelp asks for help text instead of a call.
var errHelp = errors.New("help requested")

// options are the global flags.
type options struct {
	profile   string
	client    string
	session   string
	label     string
	wait      time.Duration
	noLaunch  bool
	outDir    string
	maxOutput int
	verbose   bool
	psQuoted  bool
	jsonArgs  []string // --json objects given before the tool name
	stdinArgs bool     // --stdin given before the tool name
}

const defaultWait = 120 * time.Second

// globalFlags maps flag names (dashes, lower case) to their setters. A flag given an empty value
// keeps its default: harness templates pass empty strings for "not set".
var globalFlags = map[string]struct {
	boolean bool
	set     func(o *options, v string) error
}{
	"profile":    {false, func(o *options, v string) error { o.profile = v; return nil }},
	"client":     {false, func(o *options, v string) error { o.client = v; return nil }},
	"session":    {false, func(o *options, v string) error { o.session = v; return nil }},
	"label":      {false, func(o *options, v string) error { o.label = v; return nil }},
	"wait":       {false, setWait},
	"out-dir":    {false, func(o *options, v string) error { o.outDir = v; return nil }},
	"max-output": {false, setMaxOutput},
	"no-launch":  {true, func(o *options, v string) error { o.noLaunch = v == "true"; return nil }},
	"verbose":    {true, func(o *options, v string) error { o.verbose = v == "true"; return nil }},
	"ps-quoted":  {true, func(o *options, v string) error { o.psQuoted = v == "true"; return nil }},
}

func setWait(o *options, v string) error {
	s, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || s < 0 || math.IsNaN(s) {
		return errors.New("expected a number of seconds")
	}
	o.wait = time.Duration(min(s, 1e6) * float64(time.Second))
	return nil
}

func setMaxOutput(o *options, v string) error {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return errors.New("expected a number of characters (0 for no limit)")
	}
	o.maxOutput = n
	return nil
}

// flagName normalises a flag name: --max_output is --max-output.
func flagName(name string) string { return strings.ReplaceAll(strings.ToLower(name), "_", "-") }

// flagBool reads a boolean flag: bare means true, and an empty value leaves it unset.
func flagBool(val string, hasVal bool) (value, set bool, err error) {
	if !hasVal {
		return true, true, nil
	}
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "":
		return false, false, nil
	case "true", "1", "yes", "on":
		return true, true, nil
	case "false", "0", "no", "off":
		return false, true, nil
	}
	return false, false, fmt.Errorf("expected true or false, got %q", val)
}

// applyGlobal sets global flag name; rest are the words after it, of which it consumes the value
// of "--name value" and returns how many it used.
func applyGlobal(o *options, name, val string, hasVal bool, rest []string) (int, error) {
	f := globalFlags[name]
	used := 0
	if f.boolean {
		b, set, err := flagBool(val, hasVal)
		if err != nil {
			return 0, usagef("--%s: %v", name, err)
		}
		if !set {
			return 0, nil
		}
		val = strconv.FormatBool(b)
	} else {
		if !hasVal {
			if len(rest) == 0 {
				return 0, usagef("--%s needs a value", name)
			}
			val, used = rest[0], 1
		}
		if val == "" {
			return used, nil
		}
	}
	if err := f.set(o, val); err != nil {
		return 0, usagef("--%s: %v", name, err)
	}
	return used, nil
}

// parseFlags reads the global flags before the tool name or subcommand and returns the words
// from there on.
func parseFlags(args []string, o *options) ([]string, error) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			return args[i+1:], nil
		}
		if len(a) < 2 || a[0] != '-' {
			return args[i:], nil
		}
		name, val, hasVal := strings.Cut(strings.TrimLeft(a, "-"), "=")
		name = flagName(name)
		switch name {
		case "h", "help":
			return nil, errHelp
		case "version":
			return []string{"version"}, nil
		case "json":
			if !hasVal {
				if i+1 == len(args) {
					return nil, usagef("--json needs a value")
				}
				i++
				val = args[i]
			}
			o.jsonArgs = append(o.jsonArgs, val)
			continue
		case "stdin":
			b, set, err := flagBool(val, hasVal)
			if err != nil {
				return nil, usagef("--stdin: %v", err)
			}
			if set {
				o.stdinArgs = b
			}
			continue
		}
		if _, ok := globalFlags[name]; !ok {
			return nil, usagef("unknown flag %s (see lwb help)", a)
		}
		used, err := applyGlobal(o, name, val, hasVal, args[i+1:])
		if err != nil {
			return nil, err
		}
		i += used
	}
	return nil, nil
}

// parseToolArgs turns the words after the tool name into the tool's arguments:
//
//	--name=value | --name value | --bool-param | value | --json='{…}' | --stdin
//
// Values from flags stay strings (the browser converts them). Empty values are dropped, since
// harness templates pass an empty string for parameters the model left out. Global flags are
// accepted here too, unless the tool has a parameter of the same name.
func parseToolArgs(t *tool, words []string, o *options, stdin io.Reader) (map[string]any, error) {
	flags := map[string]any{}
	var positional []string
	jsonArgs := slices.Clone(o.jsonArgs)
	readStdin := o.stdinArgs
	for i := 0; i < len(words); i++ {
		w := words[i]
		if w == "--" {
			positional = append(positional, words[i+1:]...)
			break
		}
		if w == "-h" {
			return nil, errHelp
		}
		if !strings.HasPrefix(w, "--") {
			positional = append(positional, w)
			continue
		}
		name, val, hasVal := strings.Cut(w[2:], "=")
		if name == "" {
			return nil, usagef("%s: %q is not a parameter", t.Name, w)
		}
		// takeValue completes "--name value"; a boolean parameter may stand alone.
		takeValue := func(boolean bool) error {
			if hasVal {
				return nil
			}
			next := ""
			if i+1 < len(words) {
				next = words[i+1]
			}
			switch {
			case boolean:
				val = "true"
				if strings.EqualFold(next, "true") || strings.EqualFold(next, "false") {
					val = next
					i++
				}
			case i+1 >= len(words) || strings.HasPrefix(next, "--"):
				return usagef("%s: --%s needs a value (write --%s=VALUE for a value that starts with --)", t.Name, name, name)
			default:
				val = next
				i++
			}
			return nil
		}
		if key, p := t.param(name); p != nil {
			if err := takeValue(p.isBool()); err != nil {
				return nil, err
			}
			flags[key] = val
			continue
		}
		switch fn := flagName(name); fn {
		case "help":
			return nil, errHelp
		case "json":
			if err := takeValue(false); err != nil {
				return nil, err
			}
			jsonArgs = append(jsonArgs, val)
			continue
		case "stdin":
			b, set, err := flagBool(val, hasVal)
			if err != nil {
				return nil, usagef("--stdin: %v", err)
			}
			if set {
				readStdin = b
			}
			continue
		default:
			if _, ok := globalFlags[fn]; ok {
				used, err := applyGlobal(o, fn, val, hasVal, words[i+1:])
				if err != nil {
					return nil, err
				}
				i += used
				continue
			}
		}
		if !t.openSchema() {
			return nil, usagef("%s has no parameter --%s", t.Name, name)
		}
		if err := takeValue(false); err != nil {
			return nil, err
		}
		flags[name] = val
	}

	// Later sources win: --stdin, then each --json, then --name flags and the positional value.
	args := map[string]any{}
	fromFlags := map[string]bool{}
	merge := func(src map[string]any, from string) error {
		for _, k := range slices.Sorted(maps.Keys(src)) {
			v := src[k]
			if o.psQuoted {
				v = psUnquoteValue(v)
			}
			if s, ok := v.(string); ok && s == "" {
				continue
			}
			key, p := t.param(k)
			if p == nil {
				if !t.openSchema() {
					return usagef("%s has no parameter %q (from %s)", t.Name, k, from)
				}
				key = k
			}
			args[key] = v
			if from == "flags" {
				fromFlags[key] = true
			}
		}
		return nil
	}
	if readStdin {
		obj, err := readJSONObject(stdin)
		if err != nil {
			return nil, usagef("--stdin: %v", err)
		}
		if err := merge(obj, "--stdin"); err != nil {
			return nil, err
		}
	}
	for _, js := range jsonArgs {
		obj, err := parseJSONObject([]byte(js))
		if err != nil {
			return nil, usagef("--json: %v", err)
		}
		if err := merge(obj, "--json"); err != nil {
			return nil, err
		}
	}
	if err := merge(flags, "flags"); err != nil {
		return nil, err
	}
	switch target := t.positionalParam(); {
	case len(positional) > 1:
		return nil, usagef("%s: too many values (%s); use --name=value", t.Name, strings.Join(positional, " "))
	case len(positional) == 1 && target == "":
		return nil, usagef("%s: unexpected value %q; use --name=value", t.Name, positional[0])
	case len(positional) == 1:
		v := positional[0]
		if o.psQuoted {
			v = psUnquote(v)
		}
		// A value that looks like a ref names the element, whatever else the tool requires:
		// `lwb type e3 --text=hi`, while `lwb type hi` still types into the focused element.
		if isRef(v) && t.InputSchema.Properties.byName["ref"] != nil && !fromFlags["ref"] {
			target = "ref"
		}
		if v != "" {
			if fromFlags[target] {
				return nil, usagef("%s: %s is given twice (as a value and as --%s)", t.Name, target, target)
			}
			args[target] = v
		}
	}
	for _, r := range t.InputSchema.Required {
		if _, ok := args[r]; !ok {
			return nil, usagef("%s: missing required parameter --%s", t.Name, r)
		}
	}
	return args, nil
}

// readJSONObject reads the --stdin object; empty input is an empty object.
func readJSONObject(r io.Reader) (map[string]any, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	data = decodeText(data)
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]any{}, nil
	}
	return parseJSONObject(data)
}

func parseJSONObject(data []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber() // numbers reach the browser exactly as written
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) {
			return nil, errors.New("expected a JSON object")
		}
		return nil, err
	}
	if obj == nil {
		return nil, errors.New("expected a JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected text after the JSON object")
	}
	return obj, nil
}

// decodeText removes a byte order mark: PowerShell writes UTF-8 with one, and may write UTF-16.
func decodeText(b []byte) []byte {
	var order binary.ByteOrder
	switch {
	case bytes.HasPrefix(b, utf8BOM):
		return b[len(utf8BOM):]
	case bytes.HasPrefix(b, []byte{0xFF, 0xFE}):
		order = binary.LittleEndian
	case bytes.HasPrefix(b, []byte{0xFE, 0xFF}):
		order = binary.BigEndian
	default:
		return b
	}
	b = b[2:]
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = order.Uint16(b[2*i:])
	}
	return []byte(string(utf16.Decode(u)))
}

// isPSQuote reports whether r is one of the characters PowerShell treats as a single quote.
func isPSQuote(r rune) bool {
	switch r {
	case '\'', '\u2018', '\u2019', '\u201A', '\u201B':
		return true
	}
	return false
}

// psUnquote undoes PowerShell single-quoted literal syntax: outer quotes, and every quote
// character doubled inside. Windows PowerShell 5.1 mangles quotes in native command arguments, so
// Vision's PowerShell templates pass values on stdin as such literals, or as bare words that need
// no quoting.
func psUnquote(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	if len(s) < 2 || s[0] != '\'' || s[len(s)-1] != '\'' {
		return s
	}
	rs := []rune(s[1 : len(s)-1])
	var b strings.Builder
	for i := 0; i < len(rs); i++ {
		// Inside the literal every quote character is doubled; like PowerShell, keep the second.
		if isPSQuote(rs[i]) && i+1 < len(rs) && isPSQuote(rs[i+1]) {
			i++
		}
		b.WriteRune(rs[i])
	}
	return b.String()
}

// psUnquoteValue applies psUnquote to every string in a JSON value.
func psUnquoteValue(v any) any {
	switch x := v.(type) {
	case string:
		return psUnquote(x)
	case []any:
		for i := range x {
			x[i] = psUnquoteValue(x[i])
		}
	case map[string]any:
		for k, e := range x {
			x[k] = psUnquoteValue(e)
		}
	}
	return v
}
