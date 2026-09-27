// Guards against shell commands that would kill or interfere with the run's own
// computer/browser lifecycle (kill, pkill, systemctl stop, eval/source obfuscation, ...).
import { parse as parseShellCommand } from "shell-quote";

const SHELL_INTERPRETER_NAMES = /^(?:bash|sh|dash|zsh|ksh|fish)$/;
const STATIC_SHELL_EXPANSIONS: Readonly<Record<string, string>> = {
  HOME: "/home/rakazo",
  LOGNAME: "rakazo",
  PATH: "/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  PWD: "/home/rakazo",
  TMPDIR: "/tmp",
  USER: "rakazo",
  WORKSPACE: "/home/rakazo/workspace",
  XDG_CONFIG_HOME: "/home/rakazo/.config",
};
const SAFE_SHELL_CONTROL_OPS = new Set([
  "&&",
  "||",
  ";",
  "|",
  "&",
  ">",
  "<",
  ">>",
  ">&",
  "<&",
  "&>",
]);

function shellCFlagProgram(words: string[], interpreterIndex: number): string | undefined {
  for (let index = interpreterIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.startsWith("--command=")) return word.slice("--command=".length);
    // bash -c / -lc / -ce and fish --command: the next argument is the program string.
    if (word === "--command" || /^-[^-]*c/.test(word)) return words[index + 1];
  }
  return undefined;
}

function preserveShellCommandBoundaries(command: string): string {
  let quote: "'" | '"' | undefined;
  let result = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    if (character === "\\" && quote !== "'") {
      if (next === "\n") {
        index += 1;
        continue;
      }
      // Keep escaped characters intact; an escaped quote is not a boundary.
      result += character;
      if (next !== undefined) {
        result += next;
        index += 1;
      }
      continue;
    }
    if (character === quote) quote = undefined;
    else if (!quote && (character === "'" || character === '"')) quote = character;
    result += character === "\n" && !quote ? "\n;" : character;
  }
  return result;
}

function tokenizeProtectedShellCommand(command: string): string[] | "dynamic" {
  try {
    // shell-quote treats newlines as whitespace. Preserve command boundaries for
    // the dot builtin, after folding shell line continuations. Retaining the
    // newline also preserves comment handling (comments remain fail-closed).
    const separated = preserveShellCommandBoundaries(command);
    const parsed = parseShellCommand<{ expansion: string }>(
      separated,
      (name) => STATIC_SHELL_EXPANSIONS[name] ?? { expansion: name },
      { splitUnquoted: true },
    );
    const words: string[] = [];
    let commandPosition = true;
    let redirectTarget = false;
    for (const [index, entry] of parsed.entries()) {
      if (typeof entry === "string") {
        // Backtick fragments are not fully tokenized; treat them as dynamic.
        if (entry.includes("`")) return "dynamic";
        const word = entry.toLowerCase();
        // `find .`, `git add .`, and `git -C .` use a path, not the
        // executable `. script` builtin. Keep the path out of the builtin scan.
        words.push(word === "." && (!commandPosition || redirectTarget) ? "./" : word);
        if (redirectTarget) {
          redirectTarget = false;
          continue;
        }
        const next = parsed[index + 1];
        if (
          commandPosition &&
          /^\d+$/.test(word) &&
          typeof next === "object" &&
          "op" in next &&
          /^[<>]/.test(next.op)
        ) {
          // A leading file descriptor belongs to a redirect, not the command.
        } else if (commandPosition && /^(?:then|do|else)$/.test(word)) {
          commandPosition = true;
        } else if (commandPosition && (word === "coproc" || word === "function")) return "dynamic";
        else if (
          commandPosition &&
          (/^(?:command|builtin|exec|time|if|elif|while|until|!|\{)$/.test(word) ||
            word.startsWith("-") ||
            /^[a-z_][a-z0-9_]*=/.test(word))
        ) {
          // Shell prefixes and assignments leave the command word pending.
        } else commandPosition = false;
        continue;
      }
      if ("expansion" in entry) {
        // Unknown expansions and command substitutions are resolved by bash
        // after this guard runs, so their eventual value cannot be inspected.
        return "dynamic";
      }
      if ("op" in entry && entry.op === "glob") {
        words.push(entry.pattern.toLowerCase());
        continue;
      }
      if ("op" in entry && SAFE_SHELL_CONTROL_OPS.has(entry.op)) {
        if (["&&", "||", ";", "|", "&"].includes(entry.op)) {
          commandPosition = true;
          redirectTarget = false;
        } else redirectTarget = true;
        continue;
      }
      return "dynamic";
    }
    return words;
  } catch {
    return "dynamic";
  }
}

export function isProtectedComputerLifecycleCommand(command: string): boolean {
  const words = tokenizeProtectedShellCommand(command);
  if (words === "dynamic") return true;

  const commandNames = words.map((word) => word.split("/").at(-1));
  if (commandNames.some((word) => /^(?:kill|pkill|killall|xkill)$/.test(word ?? ""))) {
    return true;
  }
  // eval/source/. can hide protected commands inside an expansion string that the
  // outer tokenizer keeps as a single word (e.g. eval "pkill chromium").
  if (words.includes(".") || commandNames.some((word) => /^(?:eval|source)$/.test(word ?? ""))) {
    return true;
  }
  if (
    commandNames.some((word) => word === "systemctl" || word === "service") &&
    words.some((word) => /^(?:stop|restart|kill)$/.test(word))
  ) {
    return true;
  }
  if (
    words.some((word) =>
      /(?:\.browser-profiles|--user-data-dir|\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock)/.test(word),
    )
  ) {
    return true;
  }

  for (let index = 0; index < words.length; index += 1) {
    const name = words[index]?.split("/").at(-1) ?? "";
    if (!SHELL_INTERPRETER_NAMES.test(name)) continue;
    const program = shellCFlagProgram(words, index);
    if (program && isProtectedComputerLifecycleCommand(program)) return true;
  }
  return false;
}
