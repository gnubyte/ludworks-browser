package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"
)

// tools.json is the browser's tool catalog in the shape of GET /v1/tools. The browser build
// regenerates it from the browser's tool registry; embedding it lets lwb list, describe and check
// tools, and answer an MCP client's tools/list, while the browser is closed.
//
//go:embed tools.json
var embeddedCatalog []byte

var builtinCatalog = sync.OnceValues(func() (*catalog, error) { return parseCatalog(embeddedCatalog) })

// catalog is the shape of tools.json and of GET /v1/tools.
type catalog struct {
	ServerInfo   json.RawMessage   `json:"serverInfo"`
	Instructions string            `json:"instructions"`
	Tools        []json.RawMessage `json:"tools"` // handed to MCP clients unchanged
	tools        []*tool
}

type tool struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	InputSchema struct {
		Properties           properties      `json:"properties"`
		Required             []string        `json:"required"`
		AdditionalProperties json.RawMessage `json:"additionalProperties"`
	} `json:"inputSchema"`
	Annotations struct {
		ReadOnlyHint    *bool `json:"readOnlyHint"`
		DestructiveHint *bool `json:"destructiveHint"`
	} `json:"annotations"`
}

// property is the part of a parameter's JSON schema that lwb uses.
type property struct {
	Type        json.RawMessage   `json:"type"` // "string", or a list such as ["string", "null"]
	Description string            `json:"description"`
	Enum        []json.RawMessage `json:"enum"`
	Default     json.RawMessage   `json:"default"`
}

// properties keeps the schema's order, which is the order the help lists parameters in.
type properties struct {
	names  []string
	byName map[string]*property
}

func (p *properties) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil || tok == nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return errors.New("inputSchema.properties is not an object")
	}
	p.byName = map[string]*property{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		name, _ := tok.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		prop := new(property)
		_ = json.Unmarshal(raw, prop) // a boolean schema (true) has nothing to describe
		if _, dup := p.byName[name]; !dup {
			p.names = append(p.names, name)
		}
		p.byName[name] = prop
	}
	_, err = dec.Token()
	return err
}

func parseCatalog(data []byte) (*catalog, error) {
	var c catalog
	if err := json.Unmarshal(bytes.TrimPrefix(data, utf8BOM), &c); err != nil {
		return nil, fmt.Errorf("tool catalog: %w", err)
	}
	for _, raw := range c.Tools {
		t := new(tool)
		if err := json.Unmarshal(raw, t); err != nil {
			return nil, fmt.Errorf("tool catalog: %w", err)
		}
		if t.Name == "" {
			return nil, errors.New("tool catalog: a tool has no name")
		}
		c.tools = append(c.tools, t)
	}
	return &c, nil
}

// find looks a tool up by its name, with or without the "browser_" prefix ("navigate" is
// browser_navigate); dashes count as underscores.
func (c *catalog) find(name string) *tool {
	n := strings.ReplaceAll(strings.TrimSpace(name), "-", "_")
	if n == "" {
		return nil
	}
	for _, want := range []string{n, "browser_" + n} {
		for _, t := range c.tools {
			if strings.EqualFold(t.Name, want) {
				return t
			}
		}
	}
	return nil
}

// suggest returns up to five tool names close to a mistyped one.
func (c *catalog) suggest(name string) []string {
	q := strings.ToLower(strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(name), "-", "_"), "browser_"))
	if q == "" {
		return nil
	}
	type match struct {
		name string
		dist int
	}
	var ms []match
	for _, t := range c.tools {
		s := strings.ToLower(t.short())
		d := editDistance(q, s)
		if strings.Contains(s, q) || strings.Contains(q, s) {
			d = min(d, 1)
		}
		if d <= max(2, utf8.RuneCountInString(s)/3) {
			ms = append(ms, match{t.Name, d})
		}
	}
	slices.SortStableFunc(ms, func(a, b match) int { return a.dist - b.dist })
	var out []string
	for _, m := range ms[:min(len(ms), 5)] {
		out = append(out, m.name)
	}
	return out
}

func (c *catalog) names() []string {
	out := make([]string, len(c.tools))
	for i, t := range c.tools {
		out[i] = t.Name
	}
	return out
}

func (t *tool) short() string { return strings.TrimPrefix(t.Name, "browser_") }

// param resolves a flag name to a parameter name; --full-page finds full_page.
func (t *tool) param(name string) (string, *property) {
	props := t.InputSchema.Properties.byName
	if p := props[name]; p != nil {
		return name, p
	}
	if alt := strings.ReplaceAll(name, "-", "_"); props[alt] != nil {
		return alt, props[alt]
	}
	return "", nil
}

// openSchema reports whether the tool takes parameters beyond the listed ones. Only an explicit
// additionalProperties (true or a schema) says so: tool schemas list everything they take, and
// rejecting a misspelled parameter here tells the model at once.
func (t *tool) openSchema() bool {
	raw := bytes.TrimSpace(t.InputSchema.AdditionalProperties)
	return len(raw) > 0 && !bytes.Equal(raw, []byte("false"))
}

func (t *tool) required(name string) bool { return slices.Contains(t.InputSchema.Required, name) }

// positionalParam is the parameter a lone value on the command line fills: the tool's only
// required parameter, else its ref (lwb click e12), else none.
// isRef reports whether v has the shape of a snapshot ref ("e12").
func isRef(v string) bool {
	if len(v) < 2 || v[0] != 'e' {
		return false
	}
	for _, c := range v[1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (t *tool) positionalParam() string {
	if req := t.InputSchema.Required; len(req) == 1 {
		return req[0]
	}
	if t.InputSchema.Properties.byName["ref"] != nil {
		return "ref"
	}
	return ""
}

// typeName is the parameter's JSON type: the first one that is not "null" when it lists several.
func (p *property) typeName() string {
	var s string
	if json.Unmarshal(p.Type, &s) == nil {
		return s
	}
	var list []string
	_ = json.Unmarshal(p.Type, &list)
	for _, s := range list {
		if s != "null" {
			return s
		}
	}
	return ""
}

func (p *property) isBool() bool { return p.typeName() == "boolean" }

// placeholder is the value shown in help: the choices of an enum, else the type.
func (p *property) placeholder() string {
	if len(p.Enum) > 0 {
		vals := make([]string, len(p.Enum))
		for i, e := range p.Enum {
			vals[i] = jsonText(e)
		}
		return strings.Join(vals, "|")
	}
	switch t := p.typeName(); t {
	case "boolean":
		return "true|false"
	case "":
		return "VALUE"
	default:
		return strings.ToUpper(t)
	}
}

// jsonText shows a JSON value as a user would type it: strings without their quotes.
func jsonText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(bytes.TrimSpace(raw))
}

// toolHelp is the text of `lwb help <tool>`.
func toolHelp(t *tool) string {
	var b strings.Builder
	b.WriteString(t.Name)
	if t.Title != "" {
		b.WriteString(" — " + t.Title)
	}
	b.WriteString("\n")
	if d := strings.TrimSpace(t.Description); d != "" {
		b.WriteString("\n" + d + "\n")
	}
	b.WriteString("\nUsage: lwb " + t.short())
	props := t.InputSchema.Properties
	positional := t.positionalParam()
	for _, name := range props.names {
		arg := "--" + name + "=" + props.byName[name].placeholder()
		if name == positional {
			arg = "<" + name + ">"
		}
		if !t.required(name) {
			arg = "[" + arg + "]"
		}
		b.WriteString(" " + arg)
	}
	b.WriteString("\n")
	if len(props.names) == 0 {
		b.WriteString("\nThis tool takes no parameters.\n")
	} else {
		b.WriteString("\nParameters:\n")
		for _, name := range props.names {
			p := props.byName[name]
			line := "  --" + name + "=" + p.placeholder()
			if t.required(name) {
				line += "  (required)"
			}
			b.WriteString(line + "\n")
			if d := strings.TrimSpace(p.Description); d != "" {
				b.WriteString("      " + strings.ReplaceAll(d, "\n", "\n      ") + "\n")
			}
			if len(p.Default) > 0 {
				b.WriteString("      Default: " + jsonText(p.Default) + "\n")
			}
		}
		if positional != "" {
			fmt.Fprintf(&b, "\nThe value of --%s can also be given on its own: lwb %s <%s>.\n", positional, t.short(), positional)
		}
	}
	if ro := t.Annotations.ReadOnlyHint; ro != nil && *ro {
		b.WriteString("\nRead-only: it does not change the page.\n")
	}
	return b.String()
}

// paramList is the one-line parameter summary added to argument errors.
func paramList(t *tool) string {
	names := t.InputSchema.Properties.names
	if len(names) == 0 {
		return t.Name + " takes no parameters.\n"
	}
	parts := make([]string, len(names))
	for i, n := range names {
		parts[i] = "--" + n + "=" + t.InputSchema.Properties.byName[n].placeholder()
		if t.required(n) {
			parts[i] += " (required)"
		}
	}
	return "Parameters: " + strings.Join(parts, ", ") + "\n"
}

// abbreviations end in a period that does not end a sentence.
var abbreviations = []string{"e.g", "i.e", "etc", "vs", "cf", "incl", "approx"}

// firstSentence is the description up to the first ".", "!" or "?" that is followed by a space,
// except after an abbreviation such as "e.g.".
func firstSentence(s string) string {
	if i := strings.Index(s, "\n\n"); i >= 0 {
		s = s[:i]
	}
	s = strings.Join(strings.Fields(s), " ")
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '.' && c != '!' && c != '?' || i+1 < len(s) && s[i+1] != ' ' {
			continue
		}
		if c == '.' {
			word := strings.TrimLeft(s[strings.LastIndexByte(s[:i], ' ')+1:i], `("'[`)
			if slices.Contains(abbreviations, strings.ToLower(word)) {
				continue
			}
		}
		return s[:i+1]
	}
	return s
}

// editDistance is the Levenshtein distance between a and b.
func editDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}
