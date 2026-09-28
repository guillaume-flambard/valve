import type { BenchTask } from "./types.js"
import { familyTasks } from "./tasks-a-e.js"
import { familyTasksMore } from "./tasks-f-h.js"

/**
 * The M3 fixtures are kept as a separate group because they predate the
 * two-channel model: they have one command, and the cheap and complete checks
 * are the same thing. They remain useful as a regression on the original
 * negative result, but they cannot discriminate a verification policy, which
 * is why M5 added families A-H alongside rather than replacing them.
 */
export { familyTasks as legacyTasks } from "./tasks-a-e.js"

export const tasks: BenchTask[] = [...familyTasks, ...familyTasksMore]

export function tasksByFamily(): Map<string, BenchTask[]> {
  const map = new Map<string, BenchTask[]>()
  for (const task of tasks) {
    const list = map.get(task.family)
    if (list) list.push(task)
    else map.set(task.family, [task])
  }
  return map
}
