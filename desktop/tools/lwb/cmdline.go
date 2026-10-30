package main

import "strings"

// splitCommandLine splits a Windows command line the way the Microsoft C runtime has since 2008.
// Vision runs plugin commands through cmd.exe and doubles quotes inside quoted arguments
// ("say ""hi"" now"); Go's own parsing follows the older rule, where "" also ends the quoted
// section, and splits such an argument in three.
//
//   - 2n backslashes and a quote give n backslashes and start or end a quoted section;
//     2n+1 backslashes and a quote give n backslashes and a literal quote;
//     backslashes not followed by a quote are literal.
//   - Inside a quoted section, "" is a literal quote and the section continues.
//   - Space or tab outside a quoted section ends an argument; "" alone is an empty argument.
//   - The program path (the first argument) has no escapes: quotes only group, up to the first
//     space or tab outside them.
func splitCommandLine(cmd string) []string {
	var b strings.Builder
	inQuotes := false
	i := 0
	for ; i < len(cmd); i++ {
		c := cmd[i]
		if c == '"' {
			inQuotes = !inQuotes
			continue
		}
		if !inQuotes && (c == ' ' || c == '\t') {
			break
		}
		b.WriteByte(c)
	}
	args := []string{b.String()}
	for {
		for i < len(cmd) && (cmd[i] == ' ' || cmd[i] == '\t') {
			i++
		}
		if i >= len(cmd) {
			return args
		}
		b.Reset()
		inQuotes = false
		for i < len(cmd) {
			slashes := 0
			for i < len(cmd) && cmd[i] == '\\' {
				slashes++
				i++
			}
			if i < len(cmd) && cmd[i] == '"' {
				b.WriteString(strings.Repeat(`\`, slashes/2))
				switch {
				case slashes%2 == 1:
					b.WriteByte('"')
					i++
				case inQuotes && i+1 < len(cmd) && cmd[i+1] == '"':
					b.WriteByte('"')
					i += 2
				default:
					inQuotes = !inQuotes
					i++
				}
				continue
			}
			b.WriteString(strings.Repeat(`\`, slashes))
			if i >= len(cmd) || !inQuotes && (cmd[i] == ' ' || cmd[i] == '\t') {
				break
			}
			b.WriteByte(cmd[i])
			i++
		}
		args = append(args, b.String())
	}
}
