//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procBeginUpdateResource = kernel32.NewProc("BeginUpdateResourceW")
	procUpdateResource      = kernel32.NewProc("UpdateResourceW")
	procEndUpdateResource   = kernel32.NewProc("EndUpdateResourceW")
)

// updateResources deletes `remove` (their data is ignored), then writes `add` into the executable;
// Windows rebuilds the .rsrc section. Nothing is written unless every step succeeds.
func updateResources(exe string, remove, add []Resource) error {
	p, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	h, _, e := procBeginUpdateResource.Call(uintptr(unsafe.Pointer(p)), 0)
	if h == 0 {
		return fmt.Errorf("BeginUpdateResource: %v", e)
	}
	discard := func(err error) error {
		procEndUpdateResource.Call(h, 1)
		return err
	}
	// MAKEINTRESOURCEW: small integer ids travel in the pointer argument.
	for _, r := range remove {
		if ok, _, e := procUpdateResource.Call(h, uintptr(r.Type), uintptr(r.ID), uintptr(r.Lang), 0, 0); ok == 0 {
			return discard(fmt.Errorf("delete resource %d/%d/%d: %v", r.Type, r.ID, r.Lang, e))
		}
	}
	for _, r := range add {
		if len(r.Data) == 0 {
			continue
		}
		if ok, _, e := procUpdateResource.Call(h, uintptr(r.Type), uintptr(r.ID), uintptr(r.Lang), uintptr(unsafe.Pointer(&r.Data[0])), uintptr(len(r.Data))); ok == 0 {
			return discard(fmt.Errorf("update resource %d/%d: %v", r.Type, r.ID, e))
		}
	}
	if ok, _, e := procEndUpdateResource.Call(h, 0); ok == 0 {
		return fmt.Errorf("EndUpdateResource: %v", e)
	}
	return nil
}
