// Command winres manages the Windows resources of Ludworks Browser's executables in pure Go
// (adapted from ludworks-server/tools/winres; ico.go, rsrc.go and versioninfo.go are copies):
//
//	winres syso   -version 0.1.1 -icon icon.ico -out setup/rsrc_windows_amd64.syso [-arch amd64]
//	              [-description …] [-original-filename …]   (installer: icon, version, manifest)
//	winres set    -exe LudworksBrowser.exe -icon icon.ico -version 0.1.1 [string flags]
//	              (Windows only: replace the icon group and version info of a built executable —
//	               the renamed Electron binary — through BeginUpdateResource/UpdateResource)
//	winres verify -version 0.1.1 FILE.exe|FILE.syso
package main

import (
	"bytes"
	"debug/pe"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

const usage = `Usage:
  winres syso   -version X.Y.Z -icon FILE.ico -out FILE.syso [-arch amd64|arm64] [string flags]
  winres set    -exe FILE.exe -icon FILE.ico -version X.Y.Z [string flags]   (Windows only)
  winres verify -version X.Y.Z FILE.exe|FILE.syso
String flags: -company -product -description -copyright -internal-name -original-filename
`

const (
	defaultCompany     = "Ludworks"
	defaultProduct     = "Ludworks Browser"
	defaultDescription = "Ludworks Browser"
	defaultCopyright   = "Copyright (c) 2026 Ludworks. All rights reserved."
)

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "syso":
		err = cmdSyso(args[1:], stdout, stderr)
	case "set":
		err = cmdSet(args[1:], stdout, stderr)
	case "verify":
		err = cmdVerify(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "winres: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
	if err == errUsage {
		return 2
	}
	if err != nil {
		fmt.Fprintln(stderr, "winres:", err)
		return 1
	}
	return 0
}

var errUsage = fmt.Errorf("usage")

// Options configure the generated resources.
type Options struct {
	Version     string
	Arch        string
	ICO         []byte
	Company     string
	Product     string
	Description string
	Copyright   string
	Internal    string
	Original    string
	Comctl6     bool // the installer UI uses Common Controls v6 (themed progress bar)
}

func stringFlags(fs *flag.FlagSet, o *Options, internal, original string) {
	fs.StringVar(&o.Company, "company", defaultCompany, "CompanyName")
	fs.StringVar(&o.Product, "product", defaultProduct, "ProductName")
	fs.StringVar(&o.Description, "description", defaultDescription, "FileDescription")
	fs.StringVar(&o.Copyright, "copyright", defaultCopyright, "LegalCopyright")
	fs.StringVar(&o.Internal, "internal-name", internal, "InternalName")
	fs.StringVar(&o.Original, "original-filename", original, "OriginalFilename")
}

func cmdSyso(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("winres syso", flag.ContinueOnError)
	fs.SetOutput(stderr)
	o := Options{Comctl6: true}
	fs.StringVar(&o.Version, "version", "", "semantic version, e.g. 0.1.1")
	fs.StringVar(&o.Arch, "arch", "amd64", "target architecture: amd64 or arm64")
	icon := fs.String("icon", "", ".ico file to embed")
	out := fs.String("out", "", "output .syso (name it rsrc_windows_<arch>.syso)")
	stringFlags(fs, &o, "LudworksBrowserSetup", "LudworksBrowserSetup.exe")
	if err := fs.Parse(args); err != nil || o.Version == "" || *icon == "" || *out == "" || fs.NArg() != 0 {
		if err == nil {
			fmt.Fprint(stderr, usage)
		}
		return errUsage
	}
	ico, err := os.ReadFile(*icon)
	if err != nil {
		return err
	}
	o.ICO = ico
	res, err := BuildResources(o, true)
	if err != nil {
		return err
	}
	obj, err := WriteCOFF(o.Arch, res)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, obj, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "winres: wrote %s (%s, version %s, %d bytes)\n", *out, o.Arch, o.Version, len(obj))
	return nil
}

func cmdSet(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("winres set", flag.ContinueOnError)
	fs.SetOutput(stderr)
	o := Options{}
	exe := fs.String("exe", "", "executable to update in place")
	icon := fs.String("icon", "", ".ico file")
	fs.StringVar(&o.Version, "version", "", "semantic version")
	stringFlags(fs, &o, "LudworksBrowser", "LudworksBrowser.exe")
	if err := fs.Parse(args); err != nil || *exe == "" || *icon == "" || o.Version == "" || fs.NArg() != 0 {
		if err == nil {
			fmt.Fprint(stderr, usage)
		}
		return errUsage
	}
	ico, err := os.ReadFile(*icon)
	if err != nil {
		return err
	}
	o.ICO = ico
	res, err := BuildResources(o, false)
	if err != nil {
		return err
	}
	old, err := existingIconAndVersion(*exe)
	if err != nil {
		return err
	}
	if err := updateResources(*exe, old, res); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "winres: updated %s (%d resources replaced, %d removed)\n", *exe, len(res), len(old))
	return nil
}

// existingIconAndVersion lists the icon, icon-group and version resources currently in exe (all
// are deleted before the new ones are written, so no stale icon of another size survives).
func existingIconAndVersion(path string) ([]Resource, error) {
	f, err := pe.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	all, err := ReadResources(f)
	if err != nil {
		return nil, err
	}
	var out []Resource
	for _, r := range all {
		if r.Type == rtIcon || r.Type == rtGroupIcon || r.Type == rtVersion {
			out = append(out, Resource{Type: r.Type, ID: r.ID, Lang: r.Lang})
		}
	}
	return out, nil
}

// BuildResources assembles the icon group, version info and (optionally) the manifest.
func BuildResources(o Options, withManifest bool) ([]Resource, error) {
	quad, pre, err := ParseSemver(o.Version)
	if err != nil {
		return nil, err
	}
	icons, err := DecodeICO(o.ICO)
	if err != nil {
		return nil, err
	}
	for _, s := range []string{o.Company, o.Product, o.Description, o.Copyright, o.Internal, o.Original} {
		if s == "" || len(s) > 256 || strings.ContainsAny(s, "\x00\r\n") {
			return nil, fmt.Errorf("invalid version string %q", s)
		}
	}
	var res []Resource
	var group bytes.Buffer
	le := littleEndian{&group}
	le.u16(0)
	le.u16(1)
	le.u16(uint16(len(icons)))
	for i, ic := range icons {
		id := uint16(i + 1)
		res = append(res, Resource{Type: rtIcon, ID: id, Lang: langEnUS, Data: ic.Data})
		group.WriteByte(dim(ic.Width))
		group.WriteByte(dim(ic.Height))
		group.WriteByte(0)
		group.WriteByte(0)
		le.u16(1)
		le.u16(ic.BitCount)
		le.u32(uint32(len(ic.Data)))
		le.u16(id)
	}
	res = append(res, Resource{Type: rtGroupIcon, ID: 1, Lang: langEnUS, Data: group.Bytes()})
	vi := VersionInfo{Version: quad, Prerelease: pre, Strings: []KeyValue{
		{"CompanyName", o.Company},
		{"FileDescription", o.Description},
		{"FileVersion", o.Version},
		{"InternalName", o.Internal},
		{"LegalCopyright", o.Copyright},
		{"OriginalFilename", o.Original},
		{"ProductName", o.Product},
		{"ProductVersion", o.Version},
	}}
	ver, err := vi.Encode()
	if err != nil {
		return nil, err
	}
	res = append(res, Resource{Type: rtVersion, ID: 1, Lang: langEnUS, Data: ver})
	if withManifest {
		res = append(res, Resource{Type: rtManifest, ID: 1, Lang: langEnUS, Data: manifest(quad, o.Arch, o.Description, o.Comctl6)})
	}
	return res, nil
}

// manifest: asInvoker (per-user install, no UAC), Windows 10/11, long paths, per-monitor DPI
// awareness and (installer UI) Common Controls v6.
func manifest(q [4]uint16, arch, description string, comctl6 bool) []byte {
	procArch := map[string]string{"amd64": "amd64", "386": "x86", "arm64": "arm64"}[arch]
	deps := ""
	if comctl6 {
		deps = `
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>`
	}
	return []byte(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="Ludworks.BrowserSetup" version="` + quadString(q) + `" processorArchitecture="` + procArch + `"/>
  <description>` + xmlEscape(description) + `</description>` + deps + `
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
`)
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(s)
}

type littleEndian struct{ b *bytes.Buffer }

func (l littleEndian) u16(v uint16) { l.b.Write([]byte{byte(v), byte(v >> 8)}) }
func (l littleEndian) u32(v uint32) { l.u16(uint16(v)); l.u16(uint16(v >> 16)) }

func cmdVerify(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("winres verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	version := fs.String("version", "", "expected semantic version")
	if err := fs.Parse(args); err != nil || *version == "" || fs.NArg() != 1 {
		if err == nil {
			fmt.Fprint(stderr, usage)
		}
		return errUsage
	}
	f, err := pe.Open(fs.Arg(0))
	if err != nil {
		return err
	}
	defer f.Close()
	res, err := ReadResources(f)
	if err != nil {
		return err
	}
	var ver *ParsedVersion
	icons, groups := 0, 0
	for _, r := range res {
		switch r.Type {
		case rtIcon:
			icons++
		case rtGroupIcon:
			groups++
		case rtVersion:
			if ver, err = ParseVersionInfo(r.Data); err != nil {
				return err
			}
		}
	}
	quad, _, err := ParseSemver(*version)
	if err != nil {
		return err
	}
	if ver == nil || ver.FileVersion != quad {
		return fmt.Errorf("%s: version resource missing or not %s", fs.Arg(0), *version)
	}
	if groups != 1 || icons == 0 {
		return fmt.Errorf("%s: expected one icon group, found %d (%d icons)", fs.Arg(0), groups, icons)
	}
	fmt.Fprintf(stdout, "%s: OK, version %s, %d icon images\n", fs.Arg(0), quadString(ver.FileVersion), icons)
	return nil
}
