//go:build windows

// Command setup is the Ludworks Browser installer for Windows: a single per-user executable (no
// administrator rights, no UAC prompt) that carries the browser as an embedded zip.
//
//	LudworksBrowserSetup.exe [--silent] [--dir=<folder>] [--no-desktop-shortcut] [--no-launch] [--wait-pid=<pid>]
//
// It extracts the files next to the target folder, swaps them in (the user's profile lives
// elsewhere, in %LOCALAPPDATA%\Ludworks Browser\User Data, and is never touched), then lets the
// browser register itself (Start menu + desktop shortcuts with the AppUserModelID, Default apps
// capabilities, uninstall entry) by running it with --ludworks-integrate. Uninstalling is done by
// the browser too (Settings → Apps → Ludworks Browser → Uninstall runs --ludworks-uninstall).
package main

import (
	"archive/zip"
	"bytes"
	"embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed payload
var payloadFS embed.FS

const (
	product = "Ludworks Browser"
	exeName = "LudworksBrowser.exe"
)

type options struct {
	silent      bool
	dir         string
	noDesktop   bool
	noLaunch    bool
	waitPid     int
	integration bool // run --ludworks-integrate (tests can disable)
}

func parseArgs(args []string) options {
	o := options{integration: true}
	for _, a := range args {
		switch {
		case a == "--silent" || a == "/S" || a == "/s" || a == "-s":
			o.silent = true
		case strings.HasPrefix(a, "--dir="):
			o.dir = strings.TrimPrefix(a, "--dir=")
		case a == "--no-desktop-shortcut":
			o.noDesktop = true
		case a == "--no-launch":
			o.noLaunch = true
		case a == "--no-integration":
			o.integration = false
		case strings.HasPrefix(a, "--wait-pid="):
			o.waitPid, _ = strconv.Atoi(strings.TrimPrefix(a, "--wait-pid="))
		}
	}
	if o.dir == "" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, "AppData", "Local")
		}
		o.dir = filepath.Join(base, "Programs", product)
	}
	return o
}

func main() {
	runtime.LockOSThread() // the UI message loop must stay on one OS thread
	o := parseArgs(os.Args[1:])
	if o.silent {
		if err := install(o, func(float64, string) {}); err != nil {
			os.Exit(1)
		}
		return
	}
	ui := newWindow(product + " Setup")
	go func() {
		err := install(o, ui.progress)
		ui.finish(err)
	}()
	ui.loop()
	if ui.err != nil {
		os.Exit(1)
	}
}

// install does the work; progress(fraction 0..1, status) is called from this goroutine.
func install(o options, progress func(float64, string)) error {
	payload, err := payloadFS.ReadFile("payload/payload.zip")
	if err != nil {
		return errors.New("this setup program was built without the browser files")
	}
	if o.waitPid > 0 {
		progress(0, "Waiting for "+product+" to close…")
		waitForProcess(o.waitPid, 60*time.Second)
	}
	target := filepath.Clean(o.dir)
	exe := filepath.Join(target, exeName)
	for inUse(exe) {
		if o.silent {
			return errors.New("the browser is running")
		}
		if messageBox(product+" is running. Close all its windows, then click Retry.", product+" Setup", mbRetryCancel|mbIconWarning) != idRetry {
			return errors.New("cancelled")
		}
	}
	progress(0.01, "Preparing…")
	zr, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return fmt.Errorf("damaged setup program: %w", err)
	}
	var total int64
	for _, f := range zr.File {
		total += int64(f.UncompressedSize64)
	}
	staging := target + ".new"
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return err
	}
	var done int64
	buf := make([]byte, 1<<20)
	for _, f := range zr.File {
		name := filepath.FromSlash(f.Name)
		dst := filepath.Join(staging, name)
		if !strings.HasPrefix(dst, staging+string(os.PathSeparator)) {
			return fmt.Errorf("bad path in payload: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(dst)
		if err != nil {
			rc.Close()
			return err
		}
		for {
			n, rerr := rc.Read(buf)
			if n > 0 {
				if _, werr := out.Write(buf[:n]); werr != nil {
					out.Close()
					rc.Close()
					return werr
				}
				done += int64(n)
				progress(0.02+0.85*float64(done)/float64(max(total, 1)), "Copying files…")
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				out.Close()
				rc.Close()
				return fmt.Errorf("damaged setup program (%s): %w", f.Name, rerr)
			}
		}
		out.Close()
		rc.Close()
	}
	progress(0.88, "Installing…")
	old := target + ".old"
	_ = os.RemoveAll(old)
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, old); err != nil {
			return fmt.Errorf("cannot replace the existing installation (is the browser still running?): %w", err)
		}
	}
	if err := os.Rename(staging, target); err != nil {
		_ = os.Rename(old, target)
		return err
	}
	_ = os.RemoveAll(old)
	if o.integration {
		progress(0.93, "Registering with Windows…")
		args := []string{"--ludworks-integrate"}
		if o.noDesktop {
			args = append(args, "--no-desktop-shortcut")
		}
		cmd := exec.Command(exe, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("registering the browser failed: %w", err)
		}
		shChangeNotify()
	}
	progress(1, "Done")
	if !o.noLaunch {
		cmd := exec.Command(exe)
		cmd.Dir = target
		_ = cmd.Start()
	}
	return nil
}

// inUse reports whether the installed browser is running (its executable cannot be opened for
// exclusive write access).
func inUse(exe string) bool {
	p, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return false
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		var errno syscall.Errno
		return errors.As(err, &errno) && errno == 32 // ERROR_SHARING_VIOLATION
	}
	syscall.CloseHandle(h)
	return false
}

func waitForProcess(pid int, timeout time.Duration) {
	const synchronize = 0x00100000
	h, err := syscall.OpenProcess(synchronize, false, uint32(pid))
	if err != nil {
		return
	}
	defer syscall.CloseHandle(h)
	syscall.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
}

var (
	shell32            = syscall.NewLazyDLL("shell32.dll")
	procSHChangeNotify = shell32.NewProc("SHChangeNotify")
)

// shChangeNotify tells Explorer that file/URL associations changed (Default apps, icons).
func shChangeNotify() {
	const shcneAssocChanged = 0x08000000
	procSHChangeNotify.Call(shcneAssocChanged, 0, 0, 0)
}
