/**
 * Parent-linked cancellation scopes owning effect lifetimes.
 *
 * Conceptual hierarchy: Process > Agent > Run > Effect. The agent constructs
 * an Agent-lifetime scope; each run forks a Run scope; each effect forks its
 * own scope (the handle a future per-effect cancel needs). Aborting a scope
 * aborts all descendants; dispose() ends a lifetime cleanly without
 * cancelling anything.
 */

export class Scope {
  private readonly controller = new AbortController()
  private readonly children = new Set<Scope>()
  private reason: string | null = null

  constructor(private readonly parent?: Scope) {
    parent?.attach(this)
  }

  private attach(child: Scope): void {
    this.children.add(child)
  }

  /** Signal handed to effects (fetch, execFile, ...); fires on abort. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get aborted(): boolean {
    return this.controller.signal.aborted
  }

  /** Reason passed to abort(), for error reporting up the chain. */
  get abortReason(): string {
    return this.reason ?? (this.aborted ? 'aborted' : '')
  }

  /** Create a child scope; aborting this scope propagates to it. */
  fork(): Scope {
    return new Scope(this)
  }

  /** Abort this scope and all descendants. Idempotent. */
  abort(reason = 'aborted'): void {
    if (this.aborted) return
    this.reason = reason
    // Abort without an argument so all effects reject with a standard
    // AbortError; the reason string is carried on the scope for mapping.
    this.controller.abort()
    for (const child of [...this.children]) child.abort(reason)
  }

  /** End this lifetime: detach from the parent and forget children. */
  dispose(): void {
    this.parent?.detach(this)
    this.children.clear()
  }

  private detach(child: Scope): void {
    this.children.delete(child)
  }
}
