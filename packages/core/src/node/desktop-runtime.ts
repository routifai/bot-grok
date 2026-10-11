import { createHash } from "node:crypto";
import path from "node:path";
// Each live Chrome needs a private debugger port. This is the TCP address-space
// boundary, not a product limit on bots or saved browser profiles.
export const MAX_DESKTOP_DISPLAY = 65535 - 9221;
export const BROWSER_APPLICATIONS = new Set([
  "browser",
  "chrome",
  "chromium",
  "chromium-browser",
  "firefox",
  "google-chrome",
  "google-chrome-stable",
  "superchat-browser",
]);
export interface DesktopEnvironment {
  homeDir: string;
  workspaceDir: string;
  browserProfilesDir: string;
  displayStart: number;
  preservePrimaryDisplay?: boolean;
}
export const DEFAULT_DESKTOP_ENV: DesktopEnvironment = {
  homeDir: "/home/superchat",
  workspaceDir: "/home/superchat",
  browserProfilesDir: "/home/superchat/.browser-profiles",
  displayStart: 1,
  preservePrimaryDisplay: true,
};
export function screenPorts(index: number, env = DEFAULT_DESKTOP_ENV) {
  if (!Number.isSafeInteger(index) || index < 0 || index + env.displayStart > MAX_DESKTOP_DISPLAY)
    throw new Error("invalid desktop index");
  const displayNumber = env.displayStart + index;
  return {
    display: `:${displayNumber}`,
    displayNumber,
    debugPort: 9221 + displayNumber,
  };
}

function commandLayout(index: number | undefined, env: DesktopEnvironment) {
  if (index !== undefined) return screenPorts(index, env);
  return {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    display: ":${desktop_display}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    displayNumber: "${desktop_display}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    debugPort: "${desktop_debug}",
  };
}

function layoutVariables(index: number | undefined, env: DesktopEnvironment) {
  if (index !== undefined) return [];
  return [
    'desktop_index="$1"',
    `case "$desktop_index" in ''|*[!0-9]*) exit 75 ;; esac`,
    `[[ "$desktop_index" =~ ^(0|[1-9][0-9]{0,4})$ ]] || exit 75`,
    `desktop_display=$((desktop_index + ${env.displayStart}))`,
    `[ "$desktop_display" -le ${MAX_DESKTOP_DISPLAY} ] || exit 75`,
    "desktop_debug=$((9221 + desktop_display))",
  ];
}

// Expand only generated layout variables.
function quoteLayout(value: string) {
  return value
    .split(/(\$\{desktop_[a-z_]+\})/)
    .map((part) => (/^\$\{desktop_[a-z_]+\}$/.test(part) ? `"${part}"` : shellQuote(part)))
    .join("");
}
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function browserKeyForScreen(screenId: string) {
  return createHash("sha256").update(screenId).digest("hex").slice(0, 32);
}

export function browserProfilePathForScreen(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return `${env.browserProfilesDir}/chromium-bot-${browserKeyForScreen(screenId)}`;
}

function browserPidPathForScreen(screenId: string) {
  return `/tmp/superchat/browser-pid-${browserKeyForScreen(screenId)}`;
}

function browserRunningFunction(profile: string, pidFile: string) {
  const flag = shellQuote(`--user-data-dir=${profile}`);
  const profileQuoted = shellQuote(profile);
  return [
    "browser_running() {",
    `  tracked=$(cat ${pidFile} 2>/dev/null || true)`,
    `  lock=$(readlink ${profileQuoted}/SingletonLock 2>/dev/null || true)`,
    // Match the configured flag in either NUL-separated argv or Chromium's one-line
    // setproctitle. Searching for the whole flag keeps spaces and " --" inside the path.
    "  cmdline_text() {",
    "    tr '\\0' '\\n' <\"/proc/$1/cmdline\" 2>/dev/null || true",
    "  }",
    "  has_arg() {",
    '    text=$(cmdline_text "$1")',
    '    if printf \'%s\\n\' "$text" | grep -Fx -- "$2" >/dev/null; then return 0; fi',
    '    if printf \' %s \' "$text" | grep -F -- " $2 " >/dev/null; then return 0; fi',
    "    return 1",
    "  }",
    "  has_prefix() {",
    '    text=$(cmdline_text "$1")',
    "    if [ $# -ge 3 ]; then",
    '      case "$text" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '        *"$3"*) text="${text%%"$3"*}${text#*"$3"}" ;;',
    "      esac",
    "    fi",
    '    if printf \'%s\\n\' "$text" | grep -e "^$2" >/dev/null; then return 0; fi',
    '    if printf \' %s \' "$text" | grep -F -- " $2" >/dev/null; then return 0; fi',
    "    return 1",
    "  }",
    "  browser_matches() {",
    "    case \"$1\" in ''|0|*[!0-9]*) return 1 ;; esac",
    '    kill -0 "$1" 2>/dev/null || return 1',
    `    if ! has_arg "$1" ${flag}; then return 1; fi`,
    // Browser.close reads --remote-debugging-port from this PID. Renderers inherit
    // --user-data-dir (and sometimes the port) but always carry --type=.
    // Drop the profile flag first so "--type=" or a port inside that path is not a flag.
    `    if ! has_prefix "$1" '--remote-debugging-port=' ${flag}; then return 1; fi`,
    `    if has_prefix "$1" '--type=' ${flag}; then return 1; fi`,
    `    mkdir -p "$(dirname ${pidFile})" 2>/dev/null || true`,
    `    printf %s "$1" >${pidFile} 2>/dev/null || true`,
    "    return 0",
    "  }",
    // Pid files and SingletonLock miss the browser after a supervisor restart or a wrapper
    // whose lock does not point at the process that still has --user-data-dir.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '  for pid in "$tracked" "${lock##*-}"; do',
    '    if browser_matches "$pid"; then return 0; fi',
    "  done",
    "  if [ -d /proc ]; then",
    "    for proc_dir in /proc/[0-9]*; do",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '      pid="${proc_dir#/proc/}"',
    '      if browser_matches "$pid"; then return 0; fi',
    "    done",
    "  fi",
    "  return 1",
    "}",
  ];
}

export function browserLauncherPath(displayNumber: number | string) {
  return `/tmp/superchat/browser-launch-${displayNumber}`;
}

function browserLauncherCommand(
  index: number | undefined,
  screenId: string,
  env: DesktopEnvironment,
) {
  const layout = commandLayout(index, env);
  return [
    "#!/bin/bash",
    "set -eu",
    ...(index === undefined
      ? // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
        ['desktop_display="${0##*-}"', "desktop_debug=$((9221 + desktop_display))"]
      : []),
    "browser=$(command -v superchat-browser || command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)",
    `export DISPLAY=${layout.display} HOME=${shellQuote(env.homeDir)}`,
    `exec "$browser" --no-sandbox --test-type --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=${layout.debugPort} --user-data-dir=${shellQuote(browserProfilePathForScreen(screenId, env))} "$@"`,
  ].join("\n");
}

// Browser.close flushes cookies and profile databases; SIGTERM alone can discard recent cookies.
const CLOSE_BROWSER = `import base64, json, os, socket, sys, urllib.request
pid = sys.argv[1]
profile = ''
print_port = False
for arg in sys.argv[2:]:
    if arg == '--print-port':
        print_port = True
    elif not profile:
        profile = arg
data = open('/proc/' + pid + '/cmdline', 'rb').read().replace(b'\\0', b' ')
if profile:
    data = data.replace(b'--user-data-dir=' + profile.encode(), b' ', 1)
key = b'--remote-debugging-port='
start = len(data)
port = None
while True:
    start = data.rfind(key, 0, start)
    if start < 0:
        break
    if start == 0 or data[start - 1:start] == b' ':
        digits = bytearray()
        index = start + len(key)
        while index < len(data) and 48 <= data[index] <= 57:
            digits.append(data[index])
            index += 1
        if digits:
            port = int(digits)
            break
if port is None:
    raise SystemExit(1)
if print_port:
    print(port)
    raise SystemExit(0)
with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/json/version', timeout=2) as response:
    endpoint = json.load(response)['webSocketDebuggerUrl']
path = '/' + endpoint.split('/', 3)[3]
with socket.create_connection(('127.0.0.1', port), timeout=2) as connection:
    key = base64.b64encode(os.urandom(16)).decode()
    connection.sendall(('GET ' + path + ' HTTP/1.1\\r\\nHost: 127.0.0.1:' + str(port) + '\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: ' + key + '\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n').encode())
    response = b''
    while b'\\r\\n\\r\\n' not in response:
        chunk = connection.recv(4096)
        if not chunk: raise RuntimeError('browser debugger disconnected')
        response += chunk
    if b' 101 ' not in response.split(b'\\r\\n')[0]: raise RuntimeError('browser debugger rejected connection')
    payload = b'{"id":1,"method":"Browser.close"}'
    mask = os.urandom(4)
    connection.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))
    connection.recv(4096)
`;

export function browserCloseProgram() {
  return CLOSE_BROWSER;
}

export function stopBrowserCommand(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return stopBrowserProfileCommand(
    browserProfilePathForScreen(screenId, env),
    browserPidPathForScreen(screenId),
  );
}

/** Close one Chromium profile with Browser.close, then SIGTERM, before a checkpoint copies it. */
export function stopBrowserProfileCommand(profile: string, pidFile: string) {
  return [
    ...browserRunningFunction(profile, pidFile),
    `if browser_running; then`,
    `  python3 -c ${shellQuote(CLOSE_BROWSER)} "$pid" ${shellQuote(profile)} >/dev/null 2>&1 || true`,
    `  for i in $(seq 1 40); do browser_running || break; sleep 0.25; done`,
    `  if browser_running; then kill "$pid" 2>/dev/null || true; for i in $(seq 1 40); do browser_running || break; sleep 0.25; done; fi`,
    `  browser_running && kill -KILL "$pid" 2>/dev/null || true`,
    `fi`,
    `if browser_running; then echo 'browser still running' >&2; exit 1; fi`,
    `rm -f ${pidFile}`,
    `rm -f ${shellQuote(profile)}/SingletonLock ${shellQuote(profile)}/SingletonCookie ${shellQuote(profile)}/SingletonSocket`,
  ].join("\n");
}

function stopProfileDirectoriesCommand(profileList: string) {
  const placeholder = "SUPERCHAT_INTERNAL_PROFILE";
  const stop = stopBrowserProfileCommand(placeholder, '"$pid_file"')
    .replaceAll(shellQuote(`--user-data-dir=${placeholder}`), '"--user-data-dir=$profile"')
    .replaceAll(shellQuote(placeholder), '"$profile"');
  return [
    "set -eu",
    "failed=0",
    "mkdir -p /tmp/superchat",
    `for profile in ${profileList}; do`,
    '  [ -d "$profile" ] || continue',
    '  case "$profile" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "    */chromium-bot-*) hash=${profile##*chromium-bot-} ;;",
    '    *) hash=$(basename -- "$profile") ;;',
    "  esac",
    '  pid_file="/tmp/superchat/browser-pid-$hash"',
    `  bash -eu -c ${shellQuote(`profile=$1; pid_file=$2;\n${stop}`)} desktop "$profile" "$pid_file" || failed=1`,
    "done",
    '[ "$failed" -eq 0 ] || exit 1',
  ].join("\n");
}

/** Quiesce managed profiles before a full workspace export; orchestration excludes active peers. */
export function stopAllDesktopBrowsersCommand(env = DEFAULT_DESKTOP_ENV) {
  return stopProfileDirectoriesCommand(`${shellQuote(env.browserProfilesDir)}/chromium-bot-*`);
}

/**
 * Close every durable Chromium profile before Docker stops the container.
 * Screen assignments live only in the supervisor process, and PID 1 exits as soon as Xvfb
 * dies, so a stop that skips Browser.close SIGKILLs Chrome before cookie databases flush.
 */
export function quiesceBrowserProfilesCommand(env = DEFAULT_DESKTOP_ENV) {
  const root = shellQuote(env.browserProfilesDir);
  return stopProfileDirectoriesCommand(
    `${root}/chromium ${root}/chromium-bot-* ${root}/chromium-screen-*`,
  );
}

/** Reset discovered runtime processes after a supervisor restart; profiles remain durable. */
export function resetDesktopRuntimeCommand(env = DEFAULT_DESKTOP_ENV) {
  const stop = [
    ...layoutVariables(undefined, env),
    ...(env.preservePrimaryDisplay
      ? [`if [ "$desktop_display" != "${env.displayStart}" ]; then`]
      : []),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    'pkill -f "[X]vfb :${desktop_display} -screen" || true',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    'pkill -f "[f]luxbox -rc /tmp/fluxbox-home-${desktop_display}/.fluxbox/init" || true',
    ...(env.preservePrimaryDisplay ? ["fi"] : []),
  ].join("\n");
  return [
    "set -eu",
    stopAllDesktopBrowsersCommand(env),
    "for marker in /tmp/superchat/browser-profile-*; do",
    '  [ -f "$marker" ] || continue',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
    "  display=${marker##*-}",
    '  [[ "$display" =~ ^(0|[1-9][0-9]{0,4})$ ]] || continue',
    `  [ "$display" -ge ${env.displayStart} ] && [ "$display" -le ${MAX_DESKTOP_DISPLAY} ] || continue`,
    `  index=$((display - ${env.displayStart}))`,
    `  bash -eu -c ${shellQuote(stop)} desktop "$index"`,
    "done",
    `rm -f /tmp/superchat/browser-pid-* /tmp/superchat/browser-profile-* /tmp/superchat/browser-launch-*`,
  ].join("\n");
}

export function stopExtraScreenCommand(index: number, screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return renderStopExtraScreenCommand(index, screenId, env);
}

export function ensureScreenCommand(index: number, screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return renderEnsureScreenCommand(index, screenId, env);
}

function renderStopExtraScreenCommand(
  index: number | undefined,
  screenId: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  const layout = commandLayout(index, env);
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  return [
    "set -eu",
    stopBrowserCommand(screenId, env),
    `rm -f /tmp/superchat/browser-profile-${layout.displayNumber} ${browserLauncherPath(layout.displayNumber)}`,
    ...(index === 0 && env.preservePrimaryDisplay
      ? []
      : [
          ...(env.preservePrimaryDisplay
            ? [`if [ "${layout.displayNumber}" != "${env.displayStart}" ]; then`]
            : []),
          `pkill -f ${quoteLayout(`[X]vfb ${layout.display} -screen`)} || true`,
          `pkill -f ${quoteLayout(`[f]luxbox -rc ${fluxHome}/.fluxbox/init`)} || true`,
          `for i in $(seq 1 20); do if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then break; fi; sleep 0.1; done`,
          `if xdpyinfo -display ${layout.display} >/dev/null 2>&1; then echo 'computer screen failed to stop' >&2; exit 1; fi`,
          `rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber}`,
          ...(env.preservePrimaryDisplay ? ["fi"] : []),
        ]),
  ].join("\n");
}

/** Create only this bot's profile; its contents survive every desktop release. */
export function prepareBrowserProfileCommand(screenId: string, env = DEFAULT_DESKTOP_ENV) {
  return `mkdir -p ${shellQuote(browserProfilePathForScreen(screenId, env))}`;
}

function renderEnsureScreenCommand(
  index: number | undefined,
  screenId: string,
  env = DEFAULT_DESKTOP_ENV,
) {
  const layout = commandLayout(index, env);
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  const log = `/tmp/superchat/screen-${layout.displayNumber}`;
  const profile = browserProfilePathForScreen(screenId, env);
  const pidFile = browserPidPathForScreen(screenId);
  const setupDisplay =
    index === 0 && env.preservePrimaryDisplay
      ? [
          `for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
        ]
      : [
          `if ! xdpyinfo -display ${layout.display} >/dev/null 2>&1; then`,
          `  mkdir -p /tmp/superchat ${fluxHome}/.fluxbox /tmp/.X11-unix`,
          `  rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber}`,
          `  nohup Xvfb ${layout.display} -screen 0 1280x800x24 -ac +extension RANDR +render -noreset -nolisten tcp 8>&- 9>&- </dev/null >${log}-xvfb.log 2>&1 &`,
          `  for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
          `  xdpyinfo -display ${layout.display} >/dev/null 2>&1 || exit 1`,
          `  if [ -f /etc/superchat/fluxbox/init ]; then cp /etc/superchat/fluxbox/init ${fluxHome}/.fluxbox/init; else printf "session.screen0.toolbar.visible: false\\n" >${fluxHome}/.fluxbox/init; fi`,
          `  cp /etc/superchat/fluxbox/apps ${fluxHome}/.fluxbox/apps 2>/dev/null || true`,
          `  printf '[begin] (Desktop)\\n[exec] (Browser) {%s}\\n[end]\\n' ${browserLauncherPath(layout.displayNumber)} >${fluxHome}/.fluxbox/menu`,
          `  printf '\\nsession.menuFile: %s\\n' ${fluxHome}/.fluxbox/menu >>${fluxHome}/.fluxbox/init`,
          `  HOME=${shellQuote(env.homeDir)} CHROME_USER_DATA_DIR=${shellQuote(profile)} BROWSER=${browserLauncherPath(layout.displayNumber)} DISPLAY=${layout.display} nohup fluxbox -rc ${fluxHome}/.fluxbox/init 8>&- 9>&- </dev/null >${log}-fluxbox.log 2>&1 &`,
          "fi",
        ];
  return [
    "set -eu",
    ...layoutVariables(index, env),
    `mkdir -p /tmp/superchat`,
    `printf %s ${shellQuote(browserLauncherCommand(index, screenId, env))} >${browserLauncherPath(layout.displayNumber)}`,
    `chmod 700 ${browserLauncherPath(layout.displayNumber)}`,
    ...setupDisplay,
    `xdpyinfo -display ${layout.display} >/dev/null 2>&1 || exit 1`,
    `mkdir -p /tmp/superchat ${shellQuote(path.posix.dirname(profile))}`,
    ...browserRunningFunction(profile, pidFile),
    `printf %s ${shellQuote(profile)} >/tmp/superchat/browser-profile-${layout.displayNumber}`,
    "if ! browser_running; then",
    prepareBrowserProfileCommand(screenId, env),
    `  rm -f ${shellQuote(profile)}/SingletonLock ${shellQuote(profile)}/SingletonCookie ${shellQuote(profile)}/SingletonSocket`,
    `  nohup ${browserLauncherPath(layout.displayNumber)} 8>&- 9>&- </dev/null >${log}-browser.log 2>&1 & printf %s "$!" >${pidFile}`,
    "fi",
    `for i in $(seq 1 80); do browser_running && (echo >/dev/tcp/127.0.0.1/${layout.debugPort}) >/dev/null 2>&1 && break; sleep 0.25; done`,
    `browser_running && (echo >/dev/tcp/127.0.0.1/${layout.debugPort}) >/dev/null 2>&1 || exit 1`,
  ].join("\n");
}

const REGISTRY = "/tmp/superchat/desktop-assignments";

function registryLockCommand(screenId: string) {
  return [
    "set -eu",
    `dir=${shellQuote(REGISTRY)}`,
    'mkdir -p "$dir"',
    `exec 8>"$dir/${browserKeyForScreen(screenId)}.lifecycle-lock"`,
    "flock -w 120 8",
    'exec 9>"$dir/.lock"',
    "flock -w 120 9",
    `slot="$dir/${browserKeyForScreen(screenId)}.slot"`,
  ];
}

function acceptLeaseCommand(leaseId?: string, release = false) {
  return [
    `incoming=${shellQuote(leaseId ?? "")}`,
    'current=$(sed -n "2p" "$slot" 2>/dev/null || true)',
    'if [ -n "$incoming" ] && [ -n "$current" ] && [ "$incoming" != "$current" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    "  incoming_fence=${incoming##*:}; current_fence=${current##*:}",
    '  case "$incoming_fence:$current_fence" in *[!0-9:]*|:*|*:) exit 75 ;; esac',
    release
      ? // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        '  [ "${incoming%:*}" = "${current%:*}" ] && [ "$incoming_fence" -ge "$current_fence" ] || exit 75'
      : '  [ "$incoming_fence" -gt "$current_fence" ] || exit 75',
    "fi",
  ];
}

/** Allocate a live slot while keeping the durable profile keyed by bot identity. */
export function managedDesktopCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
) {
  return [
    ...registryLockCommand(screenId),
    ...acceptLeaseCommand(leaseId),
    'index=$(sed -n "1p" "$slot" 2>/dev/null || true)',
    'if [ -z "$index" ]; then',
    `  index=$(python3 -c ${shellQuote(`import pathlib, sys
used = set()
for slot in pathlib.Path(sys.argv[1]).glob("*.slot"):
    try:
        with slot.open() as source: used.add(int(source.readline()))
    except ValueError: pass
# A damaged assignment must not make a live display available to another bot.
for marker in pathlib.Path("/tmp/superchat").glob("browser-profile-*"):
    display = marker.name.rsplit("-", 1)[-1]
    if display.isascii() and display.isdigit(): used.add(int(display) - ${env.displayStart})
index = 0
while index in used: index += 1
if index > ${MAX_DESKTOP_DISPLAY - env.displayStart}: sys.exit(75)
print(index)
`)} "$dir")`,
    '  [ -n "$index" ] || exit 75',
    "fi",
    '[ -n "$incoming" ] || incoming="$current"',
    'printf "%s\\n%s\\n" "$index" "$incoming" >"$slot.next"',
    'mv "$slot.next" "$slot"',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote(renderEnsureScreenCommand(undefined, screenId, env))} desktop "$index"`,
    'printf "SUPERCHAT_DESKTOP=%s\\n" "$index"',
  ].join("\n");
}

/** Tear down before freeing a slot; failed teardown leaves it reserved for retry. */
export function releaseDesktopCommand(
  screenId: string,
  leaseId: string | undefined,
  env: DesktopEnvironment,
) {
  return [
    ...registryLockCommand(screenId),
    '[ -f "$slot" ] || exit 0',
    ...acceptLeaseCommand(leaseId, true),
    'index=$(sed -n "1p" "$slot")',
    "flock -u 9; exec 9>&-",
    `bash -eu -c ${shellQuote(renderStopExtraScreenCommand(undefined, screenId, env))} desktop "$index"`,
    'exec 9>"$dir/.lock"; flock -w 120 9',
    'rm -f "$slot"',
    'printf "SUPERCHAT_DESKTOP_RELEASED=%s\\n" "$index"',
  ].join("\n");
}
