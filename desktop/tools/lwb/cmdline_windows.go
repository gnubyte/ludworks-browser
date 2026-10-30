//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// commandLineArgs re-reads the process command line with the C runtime's 2008+ rules (see
// splitCommandLine) instead of using os.Args.
func commandLineArgs() []string {
	p := syscall.GetCommandLine()
	if p == nil {
		return os.Args
	}
	n := 0
	for q := unsafe.Pointer(p); *(*uint16)(q) != 0; q = unsafe.Add(q, 2) {
		n++
	}
	return splitCommandLine(syscall.UTF16ToString(unsafe.Slice(p, n)))
}
