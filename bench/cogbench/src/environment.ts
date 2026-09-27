import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { BenchTask, BenchMutation } from "./types.js"

export interface CommandResult {
  exitCode: number
  stdout: string
  timedOut: boolean
}

/**
 * A real filesystem plus real subprocesses.
 *
 * Every task gets its own throwaway copy, so a task that mutates its files
 * cannot contaminate the next run. That isolation is what makes repeated
 * benchmark runs comparable.
 */
export class BenchEnvironment {
  readonly root: string
  private readonly task: BenchTask
  private readonly pristine: Record<string, string>

  constructor(task: BenchTask) {
    this.task = task
    this.pristine = { ...task.files }
    this.root = mkdtempSync(join(tmpdir(), `cogbench-${task.id}-`))
    for (const [path, contents] of Object.entries(task.files)) {
      this.write(path, contents)
    }
  }

  private write(path: string, contents: string): void {
    const full = join(this.root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, "utf8")
  }

  read(path: string): string | null {
    const full = join(this.root, path)
    if (!existsSync(full)) return null
    return readFileSync(full, "utf8")
  }

  /**
   * Applies a mutation as a discrete alternative, not as a layer.
   *
   * The repo is reset to its pristine state first, so each mutation is judged
   * on its own merits. Accumulating mutations instead would make the final
   * file state depend only on the last edit in the list, which silently turns
   * every policy into "apply everything in order" and destroys the only thing
   * the bench is trying to measure.
   */
  applyMutation(mutation: BenchMutation): void {
    for (const [path, contents] of Object.entries(this.pristine)) {
      this.write(path, contents)
    }
    for (const [path, contents] of Object.entries(mutation.changes)) {
      this.write(path, contents)
    }
  }

  /** Current contents of every declared file, for state fingerprinting. */
  snapshot(): string {
    return Object.keys(this.task.files)
      .sort()
      .map((p) => `${p}:${this.read(p) ?? ""}`)
      .join("\n")
  }

  /**
   * Runs a shell command in the sandbox and reports the real exit code.
   *
   * The exit code is the only success signal. The shadow phase has to guess
   * pass/fail from stdout prose, which is a documented weakness; here the
   * oracle is the process itself.
   */
  run(command: string, timeoutMs = 10_000): CommandResult {
    try {
      const stdout = execFileSync("/bin/sh", ["-c", command], {
        cwd: this.root,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      })
      return { exitCode: 0, stdout, timedOut: false }
    } catch (error) {
      const e = error as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string }
      // A timeout kills the process, which is not the same as a test failure.
      // Conflating them would let a hang look like a red test.
      if (e.signal === "SIGTERM" || e.signal === "SIGKILL") {
        return { exitCode: 124, stdout: e.stdout ?? "", timedOut: true }
      }
      return {
        exitCode: typeof e.status === "number" ? e.status : 1,
        stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`,
        timedOut: false,
      }
    }
  }

  verify(): CommandResult {
    return this.run(this.task.verifyCommand)
  }

  test(): CommandResult {
    return this.run(this.task.testCommand)
  }

  search(pattern: string): string[] {
    const found: string[] = []
    for (const spec of this.task.searchable) {
      if (spec.pattern === pattern) found.push(...spec.matches)
    }
    return found
  }

  cleanup(): void {
    // Scoped to the temp root this instance created, never a path from a task.
    const resolved = resolve(this.root)
    if (!resolved.startsWith(resolve(tmpdir()))) return
    rmSync(resolved, { recursive: true, force: true })
  }
}
