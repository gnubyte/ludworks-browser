//go:build !windows

// Command setup is the Windows installer; on other systems it only explains that.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "LudworksBrowserSetup is a Windows program. On Linux use the .deb or .tar.gz, on macOS the .dmg.")
	os.Exit(2)
}
