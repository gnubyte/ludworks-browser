//go:build windows

package main

import (
	"errors"
	"io/fs"
	"os/exec"
	"syscall"
)

const (
	processQueryLimitedInformation = 0x1000
	stillActive                    = 259
	detachedProcess                = 0x00000008
	createNewProcessGroup          = 0x00000200
	createBreakawayFromJob         = 0x01000000
	asfwAny                        = 0xFFFFFFFF
)

var procAllowSetForegroundWindow = syscall.NewLazyDLL("user32.dll").NewProc("AllowSetForegroundWindow")

// pidAlive reports whether the process is still running.
func pidAlive(pid int) bool {
	if pid <= 0 || int64(pid) > 0xFFFFFFFF {
		return false
	}
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return errors.Is(err, syscall.ERROR_ACCESS_DENIED) // it exists, as another user's process
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if syscall.GetExitCodeProcess(h, &code) != nil {
		return true
	}
	return code == stillActive
}

// startDetached starts the browser without waiting for it: in its own process group, so Ctrl+C
// in the harness's console does not reach it, and outside lwb's job object where the job allows
// that, so a harness that kills its job on exit does not take the browser down.
func startDetached(exe string, args []string, dir string) error {
	// Let the browser come to the front: the user has to see its prompt to allow the client.
	if procAllowSetForegroundWindow.Find() == nil {
		procAllowSetForegroundWindow.Call(asfwAny)
	}
	err := spawn(exe, args, dir, createBreakawayFromJob)
	if errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		err = spawn(exe, args, dir, 0) // the job does not allow breaking away
	}
	return err
}

func spawn(exe string, args []string, dir string, flags uint32) error {
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir // not the harness's working directory, which the browser would keep in use
	cmd.Env = browserEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup | flags}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// checkOwner: the temp directory is per user on Windows.
func checkOwner(fs.FileInfo) error { return nil }
