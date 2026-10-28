// A Chrome-compatible User-Agent. Sites (Google sign-in, streaming services, banks) gate features on
// the UA; Electron's default adds "Electron/x" and the app name, which gets us treated as an
// embedded webview. Chrome itself reports a reduced UA: Chrome/<major>.0.0.0.

export function chromeUserAgent() {
  const major = String(process.versions.chrome || '0').split('.')[0];
  let platform;
  if (process.platform === 'win32') platform = 'Windows NT 10.0; Win64; x64';
  else if (process.platform === 'darwin') platform = 'Macintosh; Intel Mac OS X 10_15_7';
  else platform = process.arch === 'arm64' ? 'X11; Linux aarch64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
