//go:build !windows

package main

import "errors"

// updateResources needs the Windows resource-update API.
func updateResources(exe string, remove, add []Resource) error {
	return errors.New("winres set only runs on Windows")
}
