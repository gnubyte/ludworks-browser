package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// callRequest is the body of POST /v1/call.
type callRequest struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"args"`
}

// toolResult is the answer of POST /v1/call, an MCP CallToolResult.
type toolResult struct {
	Content []contentPart `json:"content"`
	IsError bool          `json:"isError"`
}

type contentPart struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

const cutNote = "… [output cut at %d characters; ask for less, e.g. a ref subtree or filter=interactive, or page with offset]"

// runTool makes one tool call and prints its result. Messages go to stdout: harnesses such as
// Vision show the model stdout and the exit status, not stderr.
func (c *cli) runTool(o *options, name string, words []string) int {
	cat, err := builtinCatalog()
	if err != nil {
		fmt.Fprintln(c.stdout, "lwb:", err)
		return 1
	}
	t := cat.find(name)
	if t == nil {
		fmt.Fprint(c.stdout, unknownTool(cat, name))
		return 2
	}
	args, err := parseToolArgs(t, words, o, c.stdin)
	if errors.Is(err, errHelp) {
		fmt.Fprint(c.stdout, toolHelp(t))
		return 0
	}
	if err != nil {
		fmt.Fprintf(c.stdout, "lwb: %v\n%s", err, paramList(t))
		return 2
	}
	b, _, err := c.newBrowser(o, false)
	if err != nil {
		fmt.Fprintln(c.stdout, "lwb:", err)
		return 1
	}
	body, err := json.Marshal(callRequest{Tool: t.Name, Args: args})
	if err != nil {
		fmt.Fprintln(c.stdout, "lwb:", err)
		return 1
	}
	_, code, data, err := b.roundTrip(context.Background(), http.MethodPost, "/v1/call", body, !o.noLaunch, nil)
	if err == nil && code/100 != 2 {
		err = newStatusError(code, data)
	}
	if err != nil {
		fmt.Fprintln(c.stdout, explain(err, o.noLaunch))
		return 1
	}
	var res toolResult
	if err := json.Unmarshal(data, &res); err != nil {
		fmt.Fprintln(c.stdout, "lwb: Ludworks Browser sent an answer lwb cannot read:", err)
		return 1
	}
	dir, shared := c.imageDir(o)
	out, ok := render(&res, t.Name, o.maxOutput, func(seq *int, p contentPart) (string, error) {
		return saveImage(dir, shared, t.Name, c.now(), seq, p)
	})
	io.WriteString(c.stdout, out)
	if res.IsError || !ok {
		return 1
	}
	return 0
}

// imageDir is where images are saved; shared reports the default under the temp directory,
// which on Linux other users can write to as well.
func (c *cli) imageDir(o *options) (dir string, shared bool) {
	if o.outDir != "" {
		return absPath(o.outDir), false
	}
	return filepath.Join(c.tempDir(), "ludworks-browser-agent"), true
}

// render formats a result: text parts separated by blank lines, at most maxOutput characters of
// text (0: no limit), and a note for every image, which save writes to a file. It keeps the start
// of long text: Vision keeps only the end of long outputs, which would lose the top of a page
// snapshot. ok is false when an image could not be saved.
func render(res *toolResult, toolName string, maxOutput int, save func(seq *int, p contentPart) (string, error)) (out string, ok bool) {
	ok = true
	var parts []string
	left, cut, seq := maxOutput, false, 1
	for _, p := range res.Content {
		switch p.Type {
		case "text":
			if cut {
				continue
			}
			text := strings.TrimRight(p.Text, "\r\n")
			if maxOutput > 0 {
				if n := utf8.RuneCountInString(text); n > left {
					note := fmt.Sprintf(cutNote, maxOutput)
					if head := strings.TrimRight(headRunes(text, left), "\r\n"); head != "" {
						note = head + "\n" + note
					}
					text, cut = note, true
				} else {
					left -= n
				}
			}
			parts = append(parts, text)
		case "image":
			path, err := save(&seq, p)
			if err != nil {
				parts = append(parts, "The "+toolName+" image could not be saved: "+err.Error())
				ok = false
				continue
			}
			parts = append(parts, "Image saved: "+path+"\n"+
				"To look at it, open that file with your image viewing tool (Vision: view_image file_path="+path+").")
		default:
			parts = append(parts, fmt.Sprintf("[%s content not shown]", p.Type))
		}
	}
	if len(parts) == 0 {
		return "", ok
	}
	return strings.Join(parts, "\n\n") + "\n", ok
}

// headRunes returns the first n characters of s.
func headRunes(s string, n int) string {
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}

// saveImage writes an image part to <dir>/<tool>-<yyyymmdd-hhmmss>-<n>.<ext>, taking the next
// free n from *seq on, and returns the file's absolute path.
func saveImage(dir string, shared bool, toolName string, now time.Time, seq *int, p contentPart) (string, error) {
	data, err := decodeBase64(p.Data)
	if err != nil {
		return "", fmt.Errorf("bad image data: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if shared {
		// The default directory is in the temp directory: it must be ours, not something planted.
		fi, err := os.Lstat(dir)
		if err != nil {
			return "", err
		}
		if !fi.IsDir() {
			return "", fmt.Errorf("%s is not a directory", dir)
		}
		if err := checkOwner(fi); err != nil {
			return "", fmt.Errorf("%s: %w (use --out-dir)", dir, err)
		}
	}
	ext := imageExt(p.MimeType, data)
	stamp := now.Format("20060102-150405")
	for n := *seq; n < *seq+10000; n++ {
		path := filepath.Join(dir, fmt.Sprintf("%s-%s-%d.%s", fileSafe(toolName), stamp, n, ext))
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, fs.ErrExist) {
			continue // a call in the same second already used it
		}
		if err != nil {
			return "", err
		}
		_, err = f.Write(data)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(path)
			return "", err
		}
		*seq = n + 1
		return path, nil
	}
	return "", errors.New("no free file name in " + dir)
}

func decodeBase64(s string) ([]byte, error) {
	if strings.HasPrefix(s, "data:") {
		if _, rest, ok := strings.Cut(s, ","); ok {
			s = rest
		}
	}
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, s)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

// imageExt picks the file extension from the MIME type, or from the data when the type is unknown.
func imageExt(mime string, data []byte) string {
	byType := func(m string) string {
		m, _, _ = strings.Cut(m, ";")
		switch strings.ToLower(strings.TrimSpace(m)) {
		case "image/png":
			return "png"
		case "image/jpeg", "image/jpg":
			return "jpg"
		case "image/webp":
			return "webp"
		case "image/gif":
			return "gif"
		}
		return ""
	}
	if ext := byType(mime); ext != "" {
		return ext
	}
	if ext := byType(http.DetectContentType(data)); ext != "" {
		return ext
	}
	return "bin"
}

func fileSafe(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '_' || r == '-' || r == '.' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, s)
}

// unknownTool is the message for a tool name that is not in the catalog.
func unknownTool(cat *catalog, name string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "lwb: unknown tool %q.", name)
	if s := cat.suggest(name); len(s) > 0 {
		b.WriteString(" Did you mean " + strings.Join(s, ", ") + "?\n")
	} else {
		b.WriteString(" The tools are: " + strings.Join(cat.names(), ", ") + ".\n")
	}
	b.WriteString("Run lwb tools for the list, or lwb help <tool> for a tool's parameters.\n")
	return b.String()
}

// runTools lists the tools. The list is the embedded catalog, which is what tool calls are checked
// against; --json prints the browser's catalog if it answers (it is not started for this), else
// the embedded one.
func (c *cli) runTools(o *options, asJSON bool) int {
	data := embeddedCatalog
	if b, _, err := c.newBrowser(o, false); err == nil && asJSON {
		ctx, cancel := context.WithTimeout(context.Background(), statusTimeout)
		_, code, body, err := b.roundTrip(ctx, http.MethodGet, "/v1/tools", nil, false, nil)
		cancel()
		if err == nil && code == http.StatusOK {
			if _, perr := parseCatalog(body); perr == nil {
				data = body
			}
		}
	}
	if asJSON {
		var buf strings.Builder
		var v any
		if json.Unmarshal(data, &v) == nil {
			enc := json.NewEncoder(&buf)
			enc.SetEscapeHTML(false)
			enc.SetIndent("", "  ")
			enc.Encode(v)
		}
		io.WriteString(c.stdout, buf.String())
		return 0
	}
	cat, err := parseCatalog(data)
	if err != nil {
		fmt.Fprintln(c.stdout, "lwb:", err)
		return 1
	}
	width := 0
	for _, t := range cat.tools {
		width = max(width, len(t.Name))
	}
	for _, t := range cat.tools {
		fmt.Fprintf(c.stdout, "%-*s  %s\n", width, t.Name, firstSentence(t.Description))
	}
	return 0
}

// runStatus reports whether the browser answers; it never starts it.
func (c *cli) runStatus(o *options) int {
	b, _, err := c.newBrowser(o, false)
	if err != nil {
		fmt.Fprintln(c.stdout, "lwb:", err)
		return 1
	}
	fmt.Fprintf(c.stdout, "Profile:          %s\n", b.profile)
	fmt.Fprintf(c.stdout, "Discovery file:   %s\n", b.file)
	ep, st, err := b.probe(context.Background())
	var ue *unreachableError
	switch {
	case errors.As(err, &ue):
		fmt.Fprintf(c.stdout, "Browser:          not reachable: %s\n", ue.reason)
		fmt.Fprintf(c.stdout, "To use it, start Ludworks Browser and turn on AI agent access: %s.\n", accessHint)
		return 1
	case err != nil:
		fmt.Fprintf(c.stdout, "Browser:          answers on 127.0.0.1:%d, but: %v\n", ep.Port, err)
		return 1
	}
	fmt.Fprintf(c.stdout, "Browser:          reachable on 127.0.0.1:%d (process %d)\n", ep.Port, ep.PID)
	app := st.App
	if app == "" {
		app = ep.App
	}
	fmt.Fprintf(c.stdout, "App version:      %s\n", app)
	access := "on"
	if st.Access != nil && !*st.Access {
		access = "off (turn it on in " + accessHint + ")"
	}
	fmt.Fprintf(c.stdout, "AI agent access:  %s\n", access)
	return 0
}
