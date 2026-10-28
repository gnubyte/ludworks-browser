//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// A small native progress window (Common Controls v6 via the embedded manifest).

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")

	procRegisterClassEx      = user32.NewProc("RegisterClassExW")
	procCreateWindowEx       = user32.NewProc("CreateWindowExW")
	procDefWindowProc        = user32.NewProc("DefWindowProcW")
	procGetMessage           = user32.NewProc("GetMessageW")
	procTranslateMessage     = user32.NewProc("TranslateMessage")
	procDispatchMessage      = user32.NewProc("DispatchMessageW")
	procPostMessage          = user32.NewProc("PostMessageW")
	procSendMessage          = user32.NewProc("SendMessageW")
	procShowWindow           = user32.NewProc("ShowWindow")
	procUpdateWindow         = user32.NewProc("UpdateWindow")
	procPostQuitMessage      = user32.NewProc("PostQuitMessage")
	procDestroyWindow        = user32.NewProc("DestroyWindow")
	procSetWindowText        = user32.NewProc("SetWindowTextW")
	procMessageBox           = user32.NewProc("MessageBoxW")
	procLoadImage            = user32.NewProc("LoadImageW")
	procGetDpiForWindow      = user32.NewProc("GetDpiForWindow")
	procSystemParametersInfo = user32.NewProc("SystemParametersInfoW")
	procGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	procSetWindowPos         = user32.NewProc("SetWindowPos")
	procGetModuleHandle      = kernel32.NewProc("GetModuleHandleW")
	procInitCommonControlsEx = comctl32.NewProc("InitCommonControlsEx")
	procCreateFontIndirect   = gdi32.NewProc("CreateFontIndirectW")
)

const (
	wsOverlapped   = 0x00000000
	wsCaption      = 0x00C00000
	wsSysMenu      = 0x00080000
	wsMinimizeBox  = 0x00020000
	wsChild        = 0x40000000
	wsVisible      = 0x10000000
	wmDestroy      = 0x0002
	wmClose        = 0x0010
	wmSetFont      = 0x0030
	wmSetIcon      = 0x0080
	wmApp          = 0x8000
	pbmSetRange32  = 0x0406
	pbmSetPos      = 0x0402
	swShow         = 5
	mbOK           = 0x0
	mbRetryCancel  = 0x5
	mbIconWarning  = 0x30
	mbIconError    = 0x10
	idRetry        = 4
	imageIcon      = 1
	lrDefaultSize  = 0x40
	spiNonClient   = 0x0029
	swpNoZOrder    = 0x0004
	iccProgress    = 0x00000020
	appProgress    = wmApp + 1
	appDone        = wmApp + 2
	progressMaxPos = 1000
)

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      [2]int32
	private uint32
}

type logFont struct {
	height, width, escapement, orientation, weight      int32
	italic, underline, strikeOut, charSet, outPrecision byte
	clipPrecision, quality, pitchAndFamily              byte
	faceName                                            [32]uint16
}

type nonClientMetrics struct {
	cbSize                                 uint32
	borderWidth, scrollWidth, scrollHeight int32
	captionWidth, captionHeight            int32
	captionFont                            logFont
	smCaptionWidth, smCaptionHeight        int32
	smCaptionFont                          logFont
	menuWidth, menuHeight                  int32
	menuFont, statusFont, messageFont      logFont
	paddedBorderWidth                      int32
}

type window struct {
	hwnd, status, bar uintptr
	text              string
	frac              float64
	err               error
}

var current *window

func utf16(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

func messageBox(text, caption string, flags uintptr) uintptr {
	var owner uintptr
	if current != nil {
		owner = current.hwnd
	}
	r, _, _ := procMessageBox.Call(owner, uintptr(unsafe.Pointer(utf16(text))), uintptr(unsafe.Pointer(utf16(caption))), flags)
	return r
}

func newWindow(title string) *window {
	w := &window{text: "Starting…"}
	current = w
	icc := [2]uint32{8, iccProgress}
	procInitCommonControlsEx.Call(uintptr(unsafe.Pointer(&icc)))
	inst, _, _ := procGetModuleHandle.Call(0)
	icon, _, _ := procLoadImage.Call(inst, 1, imageIcon, 0, 0, lrDefaultSize)
	cls := wndClassEx{
		lpfnWndProc:   syscall.NewCallback(wndProc),
		hInstance:     inst,
		hIcon:         icon,
		hbrBackground: 16, // COLOR_BTNFACE + 1
		lpszClassName: utf16("LudworksBrowserSetup"),
		hIconSm:       icon,
	}
	cls.cbSize = uint32(unsafe.Sizeof(cls))
	procRegisterClassEx.Call(uintptr(unsafe.Pointer(&cls)))
	w.hwnd, _, _ = procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(cls.lpszClassName)), uintptr(unsafe.Pointer(utf16(title))),
		wsOverlapped|wsCaption|wsSysMenu|wsMinimizeBox, 0, 0, 100, 100, 0, 0, inst, 0)
	dpi, _, _ := procGetDpiForWindow.Call(w.hwnd)
	if dpi == 0 {
		dpi = 96
	}
	sc := func(v int) uintptr { return uintptr(v * int(dpi) / 96) }
	sw, _, _ := procGetSystemMetrics.Call(0)
	shh, _, _ := procGetSystemMetrics.Call(1)
	width, height := sc(460), sc(170)
	procSetWindowPos.Call(w.hwnd, 0, (sw-width)/2, (shh-height)/2, width, height, swpNoZOrder)
	staticCls := utf16("STATIC")
	w.status, _, _ = procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(staticCls)), uintptr(unsafe.Pointer(utf16("Installing Ludworks Browser…"))), wsChild|wsVisible, sc(24), sc(22), sc(400), sc(24), w.hwnd, 0, inst, 0)
	barCls := utf16("msctls_progress32")
	w.bar, _, _ = procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(barCls)), 0, wsChild|wsVisible, sc(24), sc(58), sc(396), sc(18), w.hwnd, 0, inst, 0)
	procSendMessage.Call(w.bar, pbmSetRange32, 0, progressMaxPos)
	// Message font (Segoe UI) at this window's DPI.
	var ncm nonClientMetrics
	ncm.cbSize = uint32(unsafe.Sizeof(ncm))
	if ok, _, _ := procSystemParametersInfo.Call(spiNonClient, uintptr(ncm.cbSize), uintptr(unsafe.Pointer(&ncm)), 0); ok != 0 {
		lf := ncm.messageFont
		lf.height = lf.height * int32(dpi) / 96
		font, _, _ := procCreateFontIndirect.Call(uintptr(unsafe.Pointer(&lf)))
		procSendMessage.Call(w.status, wmSetFont, font, 1)
	}
	procShowWindow.Call(w.hwnd, swShow)
	procUpdateWindow.Call(w.hwnd)
	return w
}

func wndProc(hwnd uintptr, m uint32, wp, lp uintptr) uintptr {
	w := current
	switch m {
	case appProgress:
		procSendMessage.Call(w.bar, pbmSetPos, uintptr(w.frac*progressMaxPos), 0)
		procSetWindowText.Call(w.status, uintptr(unsafe.Pointer(utf16(w.text))))
		return 0
	case appDone:
		if w.err != nil && w.err.Error() != "cancelled" {
			messageBox("Ludworks Browser could not be installed:\n\n"+w.err.Error(), "Ludworks Browser Setup", mbOK|mbIconError)
		}
		procDestroyWindow.Call(hwnd)
		return 0
	case wmClose:
		return 0 // not while files are being copied
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProc.Call(hwnd, uintptr(m), wp, lp)
	return r
}

// progress is called from the worker goroutine; the UI thread repaints on its own message.
func (w *window) progress(frac float64, text string) {
	if int(frac*progressMaxPos) == int(w.frac*progressMaxPos) && text == w.text {
		return
	}
	w.frac, w.text = frac, text
	procPostMessage.Call(w.hwnd, appProgress, 0, 0)
}

func (w *window) finish(err error) {
	w.err = err
	procPostMessage.Call(w.hwnd, appDone, 0, 0)
}

func (w *window) loop() {
	var m msg
	for {
		r, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 || int32(r) == -1 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}
