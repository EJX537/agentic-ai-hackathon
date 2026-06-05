/**
 * AX — DOM annotation layer for agent interfaces
 *
 * ax provides a tree-based DAG over annotated DOM elements.
 * ax-autobindgen auto-generates bindings from DOM patterns.
 *
 * This module bridges ax into the agent pipeline — scan the page,
 * bind auto-generated actions, and invoke them from agent logic.
 *
 * Source: ../ax  (local workspace dependency)
 * Docs:   https://github.com/ejx/ax
 */
import ax from "ax";
import axAutobindgen from "ax-autobindgen";

export interface DomAction {
  /** Element identifier in the ax DAG */
  nodeId: string;
  /** Action kind (click, edit, view, nav) */
  kind: string;
  /** Human-readable label */
  label: string;
}

export class DomInterface {
  private observer: MutationObserver | null = null;

  /**
   * Initialise ax-autobindgen with default rules and start observing.
   * Call this once when the agent connects to a page.
   */
  init(options?: { root?: Element; prefix?: string }): void {
    axAutobindgen.configure({
      builtins: true,
      prefix: options?.prefix,
    });

    // Register any custom primitives needed by the agent
    ax.defineExtension("hub-agent", {
      onNode({ node, element }) {
        // Attach agent-specific metadata to scanned nodes
        const role = element.getAttribute("data-agent-role");
        if (role) {
          // The fn entry is already created by autobindgen;
          // we just tag it for the orchestrator
          (node as any).agentRole = role;
        }
      },
    });

    // Bind auto-generated bindings to the given root (or document)
    axAutobindgen.bind(options?.root);
    console.log("[AX] Autobindgen active — DOM bindings ready");
  }

  /**
   * Scan the current DOM and return all actionable elements.
   */
  scan(root?: Element): DomAction[] {
    const scan = ax.scan(root);
    const actions: DomAction[] = [];

    for (const node of scan.nodes) {
      for (const fn of node.fn) {
        actions.push({
          nodeId: node.id,
          kind: fn.on,
          label: fn.name,
        });
      }
    }

    return actions;
  }

  /**
   * Invoke an action on a DOM element.
   *
   * @param el   The target DOM element
   * @param action  Action name (matches an ax annotation)
   * @param args    Optional arguments for the action
   */
  invoke(el: Element, action: string, args?: Record<string, unknown>) {
    return ax.invoke(el, action, args);
  }

  /**
   * Watch for DOM changes and re-process annotations.
   */
  watch(callback?: (mutations: MutationRecord[]) => void): void {
    this.observer = ax.watch(callback);
  }

  /**
   * Stop watching DOM changes.
   */
  unwatch(): void {
    if (this.observer) {
      ax.unwatch();
      this.observer = null;
    }
  }

  /**
   * Get a stable node id for a DOM element.
   */
  getNodeId(el: Element): string | null {
    return ax.getNodeId(el);
  }

  /**
   * Clean up — unbind and unwatch.
   */
  shutdown(): void {
    this.unwatch();
    axAutobindgen.unbind();
  }
}
