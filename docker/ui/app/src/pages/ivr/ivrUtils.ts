/**
 * IVR Builder — utility functions
 *
 * These are pure functions with no React dependencies, making them easy to
 * test and reuse across the IVR builder components.
 */

import type { IvrVerbType } from '../../types/ivr';

// ---------------------------------------------------------------------------
// Extended node type used internally by the builder
// The API IvrNode has branches: Record<string, string> but we need nested nodes
// ---------------------------------------------------------------------------

export interface BuilderNode {
  id: string;
  type: IvrVerbType;
  config: Record<string, string>;
  /** Prompt verbs played inside a Gather (e.g. Say/Play while waiting for input) */
  prompt: BuilderNode[];
  /** Branch children keyed by digit / "timeout" / "default" */
  branches: Record<string, BuilderNode[]>;
  /** UI-only: which branch tab is active in the canvas */
  _activeBranch?: string | null;
}

// ---------------------------------------------------------------------------
// Node creation
// ---------------------------------------------------------------------------

export function defaultConfig(verb: IvrVerbType): Record<string, string> {
  switch (verb) {
    case 'say':    return { text: '', voice: 'woman' };
    case 'play':   return { url: '' };
    case 'gather': return { numDigits: '1', timeout: '5' };
    case 'dial':   return { number: '', callerId: '', timeout: '30' };
    case 'hangup': return {};
    case 'pause':  return { duration: '1' };
  }
}

export function makeNode(verb: IvrVerbType): BuilderNode {
  return {
    id: 'node_' + Math.random().toString(36).slice(2, 10),
    type: verb,
    config: defaultConfig(verb),
    prompt: [],
    branches: {},
    _activeBranch: null,
  };
}

// ---------------------------------------------------------------------------
// Tree traversal
// ---------------------------------------------------------------------------

/**
 * Parse a path string like "nodes", "nodes[2].branches.1", "nodes[0].prompt"
 * into a reference to the array at that path within the flow root.
 *
 * The root object passed in is: { nodes: BuilderNode[] }
 */
export function getNodeList(
  root: { nodes: BuilderNode[] },
  path: string,
): BuilderNode[] | null {
  // Split on dots, opening brackets, and closing brackets
  const parts = path.split(/[\.\[\]]+/).filter(Boolean);

  // Start traversal from the root object
  let ref: unknown = root;

  for (const part of parts) {
    if (ref == null) return null;

    if (Array.isArray(ref)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx)) return null;
      ref = ref[idx];
    } else if (typeof ref === 'object') {
      ref = (ref as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }

  return Array.isArray(ref) ? (ref as BuilderNode[]) : null;
}

/**
 * Recursively find a node by id. Returns { node, list, index } or null.
 */
export function findNode(
  nodes: BuilderNode[],
  id: string,
): { node: BuilderNode; list: BuilderNode[]; index: number } | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === id) return { node, list: nodes, index: i };

    // Search gather prompt
    if (node.prompt && node.prompt.length > 0) {
      const found = findNode(node.prompt, id);
      if (found) return found;
    }

    // Search gather branches
    if (node.branches) {
      for (const branchNodes of Object.values(node.branches)) {
        const found = findNode(branchNodes, id);
        if (found) return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function nodeSummary(node: BuilderNode): string {
  switch (node.type) {
    case 'say':
      return node.config.text ? `"${node.config.text.slice(0, 50)}"` : '(no text)';
    case 'play':
      return node.config.url ? node.config.url.slice(0, 50) : '(no URL)';
    case 'gather': {
      const branchCount = Object.keys(node.branches ?? {}).length;
      const bStr = branchCount > 0
        ? ` — ${branchCount} branch${branchCount !== 1 ? 'es' : ''}`
        : '';
      return `Max ${node.config.numDigits || 1} digit${bStr}`;
    }
    case 'dial':
      return node.config.number || '(no number)';
    case 'hangup':
      return 'End call';
    case 'pause':
      return `${node.config.duration || 1}s`;
  }
}

export function verbIcon(verb: IvrVerbType): string {
  switch (verb) {
    case 'say':    return 'A';
    case 'play':   return '♪';
    case 'gather': return '#';
    case 'dial':   return '☎';
    case 'hangup': return '✕';
    case 'pause':  return '⏸';
  }
}

/** CSS left-border color per verb */
export function verbColor(verb: IvrVerbType): string {
  switch (verb) {
    case 'say':    return '#3b82f6'; // blue
    case 'play':   return '#8b5cf6'; // purple
    case 'gather': return '#22c55e'; // green
    case 'dial':   return '#f59e0b'; // amber
    case 'hangup': return '#ef4444'; // red
    case 'pause':  return '#64748b'; // slate
  }
}

/** Tailwind text-color class for verb badge */
export function verbTextClass(verb: IvrVerbType): string {
  switch (verb) {
    case 'say':    return 'text-blue-400';
    case 'play':   return 'text-purple-400';
    case 'gather': return 'text-green-400';
    case 'dial':   return 'text-amber-400';
    case 'hangup': return 'text-red-400';
    case 'pause':  return 'text-slate-400';
  }
}

// ---------------------------------------------------------------------------
// XML generation
// ---------------------------------------------------------------------------

export function escXml(str: unknown): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function nodesToXml(nodes: BuilderNode[], indent: string): string {
  if (!nodes || nodes.length === 0) return '';
  let xml = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'say': {
        const voice = node.config.voice ? ` voice="${escXml(node.config.voice)}"` : '';
        xml += `${indent}<Say${voice}>${escXml(node.config.text)}</Say>\n`;
        break;
      }
      case 'play':
        xml += `${indent}<Play>${escXml(node.config.url)}</Play>\n`;
        break;
      case 'gather': {
        const attrs: string[] = [];
        if (node.config.numDigits) attrs.push(`numDigits="${escXml(node.config.numDigits)}"`);
        if (node.config.timeout)   attrs.push(`timeout="${escXml(node.config.timeout)}"`);
        const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
        xml += `${indent}<Gather${attrStr}>\n`;
        xml += nodesToXml(node.prompt ?? [], indent + '  ');
        xml += `${indent}</Gather>\n`;
        // Emit branch routing as comments
        const branchKeys = Object.keys(node.branches ?? {});
        if (branchKeys.length > 0) {
          xml += `${indent}<!-- Branch routing (handled by webhook callbacks):\n`;
          for (const k of branchKeys) {
            xml += `${indent}     Digit "${k}":\n`;
            xml += nodesToXml(node.branches[k], indent + '       ');
          }
          xml += `${indent}-->\n`;
        }
        break;
      }
      case 'dial': {
        const dattrs: string[] = [];
        if (node.config.callerId) dattrs.push(`callerId="${escXml(node.config.callerId)}"`);
        if (node.config.timeout)  dattrs.push(`timeout="${escXml(node.config.timeout)}"`);
        const dAttrStr = dattrs.length > 0 ? ' ' + dattrs.join(' ') : '';
        xml += `${indent}<Dial${dAttrStr}>${escXml(node.config.number)}</Dial>\n`;
        break;
      }
      case 'hangup':
        xml += `${indent}<Hangup/>\n`;
        break;
      case 'pause':
        xml += `${indent}<Pause length="${escXml(node.config.duration || '1')}"/>\n`;
        break;
    }
  }

  return xml;
}

export function generateXml(nodes: BuilderNode[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n';
  xml += nodesToXml(nodes, '  ');
  xml += '</Response>';
  return xml;
}

// ---------------------------------------------------------------------------
// XML syntax highlighting (for preview modal)
// ---------------------------------------------------------------------------

export function highlightXml(xml: string): string {
  // Escape HTML entities first
  const escaped = xml
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    // Comments
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span style="color:#6a737d">$1</span>')
    // XML declaration
    .replace(/(&lt;\?xml[^?]*\?&gt;)/g, '<span style="color:#79c0ff">$1</span>')
    // Closing tags
    .replace(/(&lt;\/\w+&gt;)/g, '<span style="color:#7ee787">$1</span>')
    // Opening/self-closing tags with optional attributes
    .replace(/(&lt;\w+)([^&]*?)(\/?&gt;)/g, (_match, open, attrs, close) => {
      const coloredAttrs = attrs.replace(
        /(\w+)=(&quot;[^&]*&quot;)/g,
        '<span style="color:#79c0ff">$1</span>=<span style="color:#a5d6a7">$2</span>',
      );
      return `<span style="color:#7ee787">${open}</span>${coloredAttrs}<span style="color:#7ee787">${close}</span>`;
    });
}
