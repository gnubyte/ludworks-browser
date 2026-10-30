//go:build !windows

package main

import "os"

// commandLineArgs: outside Windows the shell has split the arguments already.
func commandLineArgs() []string { return os.Args }
