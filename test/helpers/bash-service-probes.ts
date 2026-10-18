/**
 * How a real host answers the READ-ONLY probes bin/bgos-agent runs before it acts on an
 * agent's service (board row d6198bb6), for the recording `launchctl` and `systemctl`
 * stand-ins of the bgos-agent tests (test/bgos-agent.commands.test.ts,
 * test/bgos-agent.install.test.ts).
 *
 * bin/hoai-agent-service.mjs probe (run on bun or node by bgos-agent) runs
 *   launchctl print gui/<uid>/<label>
 *   systemctl --user show --property=LoadState,ActiveState,FragmentPath,WorkingDirectory,Environment <unit>
 * and judges the answer with #237's reader (lib/watcher-service.mjs readProbe): an answer it
 * cannot read is 'unknown' and the act is REFUSED, which is the product's correct behaviour. A
 * recorder that answers every call with exit 0 and no output therefore makes every install,
 * stop and uninstall refused. Each snippet below handles its probe and exits; any other call
 * falls through to the rest of the stand-in. They read $HOME, which bgos-agent and the helper
 * hand down unchanged, so "this HOME's registration" is the one under the HOME the test set.
 *
 * Only the shapes test/helpers/fake-service-host.ts and test/helpers/fake-posix-services.mjs
 * print are used: launchd's 113 "Could not find service" for a label that is not loaded, a
 * loaded job's `path = <plist>` and its own `environment` block, systemd's
 * LoadState=not-found for a unit it does not know, and a loaded unit's FragmentPath under
 * <HOME>/.config/systemd/user (the reader then reads that fragment file itself).
 *
 * What these stand-ins can model, and what they cannot: they decide "loaded" from the file
 * system of the HOME that calls them (a service file under the caller's own $HOME), so they only
 * ever answer THIS HOME's own registration or none at all (absent). They can never answer a job or
 * unit another HOME installed under the same name in the account's one launchd domain or user
 * manager (foreign), nor one that is loaded with no file left in this HOME. So a test that uses
 * them proves only single-HOME behaviour, and only with the content the test wrote: write the
 * service file bin/bgos-agent itself writes (the plist's Label, ProgramArguments
 * `/bin/bash <HOME>/.bgos-agent/<id>/run.sh` and EnvironmentVariables HOME; the unit's
 * `ExecStart=/bin/bash "<HOME>/.bgos-agent/<id>/run.sh"` and `Environment=HOME=<HOME>`), never a
 * content-less stand-in that the reader would judge by its path alone. A cross-HOME case (another
 * HOME's job loaded under this HOME's name) uses test/helpers/fake-posix-services.mjs, whose
 * state is one domain and one manager per account, shared by every HOME.
 */

/** `launchctl print` of a label that is not loaded: exit 113, "Could not find service" on stderr. */
const PRINT_NOT_FOUND = String.raw`printf 'Bad request.\nCould not find service "%s" in domain for user gui: %s\n' "$(basename "$2")" "$(id -u)" >&2`

/**
 * `launchctl print gui/<uid>/<label>` answered "not loaded" for every label: for a test in which
 * no job is ever loaded (the stand-in's bootstrap and bootout do nothing), so the read-back finds
 * nothing under either name and launchd_reload never waits for a job that was never there.
 */
export const LAUNCHCTL_PRINT_NOT_LOADED = [
  'if [ "$1" = "print" ]; then',
  `  ${PRINT_NOT_FOUND}`,
  '  exit 113',
  'fi',
].join('\n')

/**
 * `launchctl print gui/<uid>/<label>` for a test in which a job is loaded exactly when its plist
 * is installed in this HOME (<HOME>/Library/LaunchAgents/<label>.plist): launchd prints the plist
 * it loaded the job from, the job's program arguments and its own environment, read here from that
 * plist. Not installed: exit 113, "Could not find service".
 */
export const LAUNCHCTL_PRINT_FROM_PLIST = [
  'if [ "$1" = "print" ]; then',
  '  label="$(basename "$2")"',
  '  plist="$HOME/Library/LaunchAgents/$label.plist"',
  '  if [ ! -f "$plist" ]; then',
  `    ${PRINT_NOT_FOUND}`,
  '    exit 113',
  '  fi',
  String.raw`  home="$(sed -n 's:.*<key>HOME</key><string>\([^<]*\)</string>.*:\1:p' "$plist" | head -n 1)"`,
  String.raw`  run="$(sed -n 's:.*<string>\([^<]*/run\.sh\)</string>.*:\1:p' "$plist" | head -n 1)"`,
  String.raw`  printf '%s = {\n\tactive count = 1\n\tpath = %s\n\ttype = LaunchAgent\n\tstate = running\n\n' "$2" "$plist"`,
  String.raw`  printf '\tprogram = /bin/bash\n\targuments = {\n\t\t/bin/bash\n'`,
  String.raw`  [ -n "$run" ] && printf '\t\t%s\n' "$run"`,
  String.raw`  printf '\t}\n\n\tenvironment = {\n'`,
  String.raw`  [ -n "$home" ] && printf '\t\tHOME => %s\n' "$home"`,
  String.raw`  printf '\t\tXPC_SERVICE_NAME => %s\n\t}\n\n\tdomain = gui/%s [100005]\n}\n' "$label" "$(id -u)"`,
  '  exit 0',
  'fi',
].join('\n')

/**
 * `systemctl --user show --property=... <unit>`: the user manager knows a unit exactly when its
 * file is installed in this HOME (<HOME>/.config/systemd/user/<unit>.service, the account's unit
 * dir), and then prints LoadState=loaded with that FragmentPath, the file's WorkingDirectory and
 * Environment; otherwise LoadState=not-found (exit 0, as systemctl does). `activeIf` is an sh
 * condition that makes a loaded unit ActiveState=active (default: never).
 */
export function systemctlShowFromUnitFile({ activeIf = 'false' }: { activeIf?: string } = {}): string {
  return [
    'if [ "$2" = "show" ]; then',
    '  for unit in "$@"; do :; done',
    '  unit="$(basename "$unit" .service)"',
    '  file="$HOME/.config/systemd/user/$unit.service"',
    '  if [ ! -f "$file" ]; then',
    String.raw`    printf 'LoadState=not-found\nActiveState=inactive\nFragmentPath=\nWorkingDirectory=\nEnvironment=\n'`,
    '    exit 0',
    '  fi',
    '  state=inactive',
    `  if ${activeIf}; then state=active; fi`,
    String.raw`  wd="$(sed -n 's/^WorkingDirectory=//p' "$file" | head -n 1)"`,
    String.raw`  environment="$(sed -n 's/^Environment=//p' "$file" | sed 's/^"\(.*\)"$/\1/' | tr '\n' ' ' | sed 's/ *$//')"`,
    String.raw`  printf 'LoadState=loaded\nActiveState=%s\nFragmentPath=%s\nWorkingDirectory=%s\nEnvironment=%s\n' "$state" "$file" "$wd" "$environment"`,
    '  exit 0',
    'fi',
  ].join('\n')
}
