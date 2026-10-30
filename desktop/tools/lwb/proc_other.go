//go:build !windows

package main

import (
	"errors"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"syscall"
)

// pidAlive reports whether the process is still running.
func pidAlive(pid int) bool {
	if pid <= 0 || pid > math.MaxInt32 {
		return false // kill(2) would read a truncated pid as a process group
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// startDetached starts the browser in a session of its own, so it outlives lwb and the harness's
// terminal, without waiting for it.
func startDetached(exe string, args []string, dir string) error {
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	cmd.Env = browserEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait() // reaps it should it exit while lwb mcp still runs
	return nil
}

// checkOwner refuses a directory that another user created in the shared temp directory.
func checkOwner(fi fs.FileInfo) error {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return errors.New("it belongs to another user")
	}
	return nil
}
