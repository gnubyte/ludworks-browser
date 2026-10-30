// Command lwb, the Ludworks Browser agent CLI, lets AI coding harnesses drive Ludworks Browser
// through the agent server the browser runs on 127.0.0.1 while AI agent access is on
// (Settings → AI agents):
//
//	lwb mcp                       stdio MCP server bridge, for Claude Code and other MCP clients
//	lwb [flags] <tool> [args…]    one tool call from a shell (the Vision harness, people)
//	lwb tools [--json] | status | help [tool] | version
//
// The browser publishes its port and a bearer token in <profile>/agent-endpoint.json. When that
// file is missing or stale, lwb starts the browser installed next to it with
// --agent-request=<client>, so the user can allow the client, and waits for the server to answer.
// tools.json, the browser's tool catalog, is embedded, so tools can be listed, described and
// offered to MCP clients while the browser is closed.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const usageText = `lwb — Ludworks Browser agent CLI

Usage:
  lwb [flags] <tool> [--name=value | --name value]... [value]
  lwb [flags] mcp               stdio MCP server (claude mcp add ludworks-browser -- lwb mcp)
  lwb [flags] tools [--json]    list the browser's tools
  lwb [flags] status            show whether the browser answers
  lwb help [tool]               this text, or a tool's parameters
  lwb version

Tool calls:
  <tool>                  a tool name; the "browser_" prefix is optional (lwb navigate)
  --name=value            a parameter; values are sent as text and the browser converts them.
  --name value            A boolean parameter alone means true. Empty values are left out.
  value                   fills the tool's only required parameter, else its ref
                          (lwb navigate https://example.com, lwb click e12)
  --json='{"name": …}'    parameters as a JSON object
  --stdin                 read a JSON object of parameters from stdin
  Text results are printed; images are saved to files and their paths printed.

Flags (before the tool name, or after it where the tool has no parameter of that name):
  --profile=DIR           browser profile (default: $LWB_PROFILE, else the browser's default profile)
  --client=NAME           the name the browser shows for this client (default: $LWB_CLIENT;
                          "Vision" if VISION_AGENT=1; for mcp the MCP client's name; else "lwb")
  --session=KEY           calls with the same key share one agent session in the browser (default:
                          $LWB_SESSION, else one per client and working directory; mcp: one per run)
  --label=TEXT            short label for the session (default: the working directory's name)
  --wait=SECONDS          how long to wait for the browser to start and answer (default 120)
  --no-launch             never start the browser
  --out-dir=DIR           where images are saved (default: <temp>/ludworks-browser-agent)
  --max-output=N          print at most N characters of text, keeping the start (default 0: all)
  --ps-quoted             values are PowerShell single-quoted literals (Vision on PowerShell)
  --verbose               log to stderr

Environment: LWB_PROFILE, LWB_CLIENT, LWB_SESSION, VISION_AGENT, LWB_BROWSER (the browser
executable to start), LWB_BROWSER_APP (an app directory passed to it, for unpackaged runs).
Exit status: 0 done, 1 the tool reported an error or the call failed, 2 usage error.
AI agent access must be on in the browser: Ludworks Browser → Settings → AI agents.
`

// version is stamped by the browser build (-ldflags "-X main.version=…"); without it lwb reports
// the version of the embedded catalog, which that build regenerates.
var version string

var lwbVersion = sync.OnceValue(func() string {
	if version != "" {
		return version
	}
	if cat, err := builtinCatalog(); err == nil {
		var info struct {
			Version string `json:"version"`
		}
		if json.Unmarshal(cat.ServerInfo, &info) == nil && info.Version != "" {
			return info.Version
		}
	}
	return "dev"
})

// cli is the process environment; tests replace parts of it.
type cli struct {
	stdin      io.Reader
	stdout     io.Writer
	stderr     io.Writer
	getenv     func(string) string
	getwd      func() (string, error)
	executable func() (string, error)
	start      func(exe string, args []string, dir string) error // starts the browser, detached
	pidAlive   func(pid int) bool
	now        func() time.Time
	tempDir    func() string
	goos       string
	poll       time.Duration // how often to look for a starting browser
	signals    bool          // mcp: SIGINT/SIGTERM end the session like a closed stdin
}

func main() {
	c := &cli{
		stdin:      os.Stdin,
		stdout:     os.Stdout,
		stderr:     os.Stderr,
		getenv:     os.Getenv,
		getwd:      os.Getwd,
		executable: os.Executable,
		start:      startDetached,
		pidAlive:   pidAlive,
		now:        time.Now,
		tempDir:    os.TempDir,
		goos:       runtime.GOOS,
		poll:       250 * time.Millisecond,
		signals:    true,
	}
	args := commandLineArgs()
	os.Exit(c.run(args[min(1, len(args)):]))
}

func (c *cli) run(args []string) int {
	o := options{wait: defaultWait}
	// In mcp mode stdout carries protocol messages only, even for a usage error.
	errOut := c.stdout
	if slices.Contains(args, "mcp") {
		errOut = c.stderr
	}
	rest, err := parseFlags(args, &o)
	if errors.Is(err, errHelp) {
		fmt.Fprint(c.stdout, usageText)
		return 0
	}
	if err != nil {
		fmt.Fprintf(errOut, "lwb: %v\n", err)
		return 2
	}
	if len(rest) == 0 {
		fmt.Fprint(errOut, usageText)
		return 2
	}
	cmd, rest := rest[0], rest[1:]
	switch cmd {
	case "mcp":
		if err := parseOnlyFlags(rest, &o); err != nil {
			fmt.Fprintf(c.stderr, "lwb mcp: %v\n", err)
			return 2
		}
		ctx := context.Background()
		if c.signals {
			var stop context.CancelFunc
			ctx, stop = signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
			defer stop()
		}
		return c.runMCP(ctx, &o)
	case "tools":
		asJSON := false
		rest = slices.DeleteFunc(slices.Clone(rest), func(a string) bool {
			if a == "--json" || a == "-json" {
				asJSON = true
				return true
			}
			return false
		})
		if err := parseOnlyFlags(rest, &o); err != nil {
			fmt.Fprintf(c.stdout, "lwb tools: %v\n", err)
			return 2
		}
		return c.runTools(&o, asJSON)
	case "status":
		if err := parseOnlyFlags(rest, &o); err != nil {
			fmt.Fprintf(c.stdout, "lwb status: %v\n", err)
			return 2
		}
		return c.runStatus(&o)
	case "help":
		if len(rest) == 0 || slices.Contains([]string{"mcp", "tools", "status", "help", "version"}, rest[0]) {
			fmt.Fprint(c.stdout, usageText)
			return 0
		}
		return c.runHelp(rest[0])
	case "version":
		fmt.Fprintf(c.stdout, "lwb %s (%s %s/%s)\n", lwbVersion(), runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return 0
	}
	return c.runTool(&o, cmd, rest)
}

// parseOnlyFlags reads global flags after a subcommand, which takes no other arguments.
func parseOnlyFlags(args []string, o *options) error {
	rest, err := parseFlags(args, o)
	if err != nil {
		if errors.Is(err, errHelp) {
			return usagef("see lwb help")
		}
		return err
	}
	if len(rest) > 0 {
		return usagef("unexpected argument %q", rest[0])
	}
	if len(o.jsonArgs) > 0 || o.stdinArgs {
		return usagef("--json and --stdin are for tool calls")
	}
	return nil
}

func (c *cli) runHelp(name string) int {
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
	fmt.Fprint(c.stdout, toolHelp(t))
	return 0
}

// identity is how the browser names and groups this client's calls (X-Lwb-Client, -Session,
// -Label). The MCP bridge learns the client's name from initialize.
type identity struct {
	mu                     sync.Mutex
	client, session, label string
}

func (id *identity) get() (client, session, label string) {
	id.mu.Lock()
	defer id.mu.Unlock()
	return id.client, id.session, id.label
}

func (id *identity) setClient(name string) {
	if name = headerText(name, 64); name != "" {
		id.mu.Lock()
		id.client = name
		id.mu.Unlock()
	}
}

// identity resolves client, session and label; fixed reports a client name the MCP client's own
// name must not replace.
func (c *cli) identity(o *options, mcp bool) (id *identity, fixed bool) {
	client, fixed := o.client, true
	switch {
	case client != "":
	case c.getenv("LWB_CLIENT") != "":
		client = c.getenv("LWB_CLIENT")
	case c.getenv("VISION_AGENT") == "1":
		client = "Vision"
	default:
		client, fixed = "lwb", false
	}
	if client = headerText(client, 64); client == "" {
		client = "lwb"
	}
	cwd, _ := c.getwd()
	session := o.session
	if session == "" {
		session = c.getenv("LWB_SESSION")
	}
	if session == "" {
		if mcp {
			session = randomUUID()
		} else {
			sum := sha256.Sum256([]byte(cwd))
			session = client + ":" + hex.EncodeToString(sum[:])[:12]
		}
	}
	// The working directory's name, for mcp too: clients start MCP servers in the project folder,
	// and the browser shows the label next to the client ("Claude Code · myproject").
	label := o.label
	if label == "" {
		label = filepath.Base(cwd)
	}
	if label = headerText(label, 80); strings.Trim(label, `/\.`) == "" { // no cwd, or a root
		label = client
	}
	return &identity{client: client, session: headerText(session, 200), label: label}, fixed
}

// headerText makes s fit for a header value: control characters become spaces and it is cut to
// limit characters. Non-ASCII text goes out as UTF-8.
func headerText(s string, limit int) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s))
	if utf8.RuneCountInString(s) > limit {
		s = string([]rune(s)[:limit])
	}
	return s
}

func randomUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40 // version 4
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// profileDir resolves the browser profile; explicit reports one given by --profile or LWB_PROFILE.
func (c *cli) profileDir(o *options) (dir string, explicit bool, err error) {
	dir = o.profile
	if dir == "" {
		dir = c.getenv("LWB_PROFILE")
	}
	if dir != "" {
		dir, err = filepath.Abs(dir)
		return dir, true, err
	}
	if dir = defaultProfile(c.goos, c.getenv); dir == "" {
		return "", false, errors.New("cannot tell where the browser profile is: set LWB_PROFILE or use --profile")
	}
	return dir, false, nil
}

// defaultProfile is where the browser keeps its default profile (desktop/src/main/paths.js).
func defaultProfile(goos string, getenv func(string) string) string {
	switch goos {
	case "windows":
		base := getenv("LOCALAPPDATA")
		if base == "" {
			if home := getenv("USERPROFILE"); home != "" {
				base = filepath.Join(home, "AppData", "Local")
			}
		}
		if base == "" {
			return ""
		}
		return filepath.Join(base, "Ludworks Browser", "User Data")
	case "darwin":
		if home := getenv("HOME"); home != "" {
			return filepath.Join(home, "Library", "Application Support", "Ludworks Browser")
		}
		return ""
	default:
		base := getenv("XDG_CONFIG_HOME")
		if base == "" {
			home := getenv("HOME")
			if home == "" {
				return ""
			}
			base = filepath.Join(home, ".config")
		}
		return filepath.Join(base, "ludworks-browser")
	}
}

// newBrowser sets up the connection for this run; fixed is as for identity.
func (c *cli) newBrowser(o *options, mcp bool) (b *browser, fixed bool, err error) {
	profile, explicit, err := c.profileDir(o)
	if err != nil {
		return nil, false, err
	}
	id, fixed := c.identity(o, mcp)
	logger := log.New(io.Discard, "", 0)
	if o.verbose {
		logger = log.New(c.stderr, "lwb: ", log.Ltime|log.Lmicroseconds)
	}
	return &browser{
		profile:    profile,
		explicit:   explicit,
		file:       filepath.Join(profile, endpointFile),
		id:         id,
		httpc:      newHTTPClient(),
		log:        logger,
		stderr:     c.stderr,
		wait:       o.wait,
		poll:       c.poll,
		getenv:     c.getenv,
		executable: c.executable,
		start:      c.start,
		pidAlive:   c.pidAlive,
		goos:       c.goos,
	}, fixed, nil
}
