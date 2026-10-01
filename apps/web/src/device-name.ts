/** "Chrome on macOS": how this browser is named on the desktop's list of linked devices. */
export function deviceName(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return os ? `${browser} on ${os}` : browser;
}
