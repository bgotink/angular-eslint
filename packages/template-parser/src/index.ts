import type {
  ParseSourceSpan,
  Comment,
} from '@angular-eslint/bundled-angular-compiler';
import { parseTemplate } from '@angular-eslint/bundled-angular-compiler';
import type { TSESTree } from '@typescript-eslint/types';
import { Scope, ScopeManager } from 'eslint-scope';
import {
  convertElementSourceSpanToLoc,
  convertNodeSourceSpanToLoc,
} from './convert-source-span-to-loc';

interface Node {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  type: string;
}

interface VisitorKeys {
  [nodeName: string]: string[];
}

interface Token extends TSESTree.BaseNode {
  type: string;
  value: string;
}

interface AST extends Node, Token {
  comments: Token[];
  tokens: Token[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  templateNodes: any[];
}

const KEYS: VisitorKeys = {
  ASTWithSource: ['ast'],
  Binary: ['left', 'right'],
  BoundAttribute: ['value'],
  BoundEvent: ['handler'],
  BoundText: ['value'],
  Conditional: ['condition', 'trueExp', 'falseExp'],
  Element: ['children', 'inputs', 'outputs', 'attributes'],
  Interpolation: ['expressions'],
  PrefixNot: ['expression'],
  Program: ['templateNodes'],
  PropertyRead: ['receiver'],
  Template: ['templateAttrs', 'children', 'inputs'],
  BindingPipe: ['exp'],
};

function fallbackKeysFilter(this: Node, key: string) {
  let value = null;
  return (
    key !== 'comments' &&
    key !== 'leadingComments' &&
    key !== 'loc' &&
    key !== 'parent' &&
    key !== 'range' &&
    key !== 'tokens' &&
    key !== 'trailingComments' &&
    (value = this[key]) !== null &&
    typeof value === 'object' &&
    (typeof value.type === 'string' || Array.isArray(value))
  );
}

function getFallbackKeys(node: Node): string[] {
  return Object.keys(node).filter(fallbackKeysFilter, node);
}

function isNode(node: unknown): node is Node {
  return (
    node !== null &&
    typeof node === 'object' &&
    typeof (node as { type?: unknown }).type === 'string'
  );
}

/**
 * Need all Nodes to have a `type` property before we begin
 */
function preprocessNode(node: Node) {
  let i = 0;
  let j = 0;

  const keys = KEYS[node.type] || getFallbackKeys(node);

  for (i = 0; i < keys.length; ++i) {
    const child = node[keys[i]];
    const isArr = Array.isArray(child);
    if (child.type !== undefined) {
      // Angular sometimes uses a prop called type already
      child.__originalType = child.type;
    }
    if (!isArr && !child.type) {
      child.type = child.constructor.name;
    }

    if (isArr) {
      for (j = 0; j < child.length; ++j) {
        const c = child[j];
        if (c.type !== undefined) {
          // Angular sometimes uses a prop called type already
          c.__originalType = c.type;
        }
        // Pay attention to the condition `typeof c.type === number`,
        // Angular compiler sets `type` property for some AST nodes,
        // e.g. for the `BoundAttribute`, which is a `BindingType`.
        if (!c.type || typeof c.type === 'number') {
          c.type = c.constructor.name;
        }
        if (isNode(c)) {
          preprocessNode(c);
        }
      }
    } else if (isNode(child)) {
      preprocessNode(child);
    }
  }
}

function getStartSourceSpanFromAST(ast: AST): ParseSourceSpan | null {
  let startSourceSpan: ParseSourceSpan | null = null;
  ast.templateNodes.forEach((node) => {
    const nodeSourceSpan = node.startSourceSpan || node.sourceSpan;

    if (!startSourceSpan) {
      startSourceSpan = nodeSourceSpan;
      return;
    }

    if (
      nodeSourceSpan &&
      nodeSourceSpan.start.offset < startSourceSpan.start.offset
    ) {
      startSourceSpan = nodeSourceSpan;
      return;
    }
  });
  return startSourceSpan;
}

function getEndSourceSpanFromAST(ast: AST): ParseSourceSpan | null {
  let endSourceSpan: ParseSourceSpan | null = null;
  ast.templateNodes.forEach((node) => {
    const nodeSourceSpan = node.endSourceSpan || node.sourceSpan;

    if (!endSourceSpan) {
      endSourceSpan = nodeSourceSpan;
      return;
    }

    if (
      nodeSourceSpan &&
      nodeSourceSpan.end.offset > endSourceSpan.end.offset
    ) {
      endSourceSpan = nodeSourceSpan;
      return;
    }
  });
  return endSourceSpan;
}

function convertNgAstCommentsToTokens(comments: Comment[]) {
  const commentTokens = comments.map((comment) => {
    return {
      // In an HTML context, effectively all our comments are Block comments
      type: 'Block',
      value: comment.value,
      loc: convertNodeSourceSpanToLoc(comment.sourceSpan),
      range: [comment.sourceSpan.start.offset, comment.sourceSpan.end.offset],
    } as Token;
  });
  /**
   * ESLint requires this to be sorted by Token#range[0]
   * https://eslint.org/docs/developer-guide/working-with-custom-parsers
   */
  return commentTokens.sort((a, b) => a.range[0] - b.range[0]);
}

function parseForESLint(
  code: string,
  options: { filePath: string },
): {
  ast: AST;
  scopeManager: ScopeManager;
  visitorKeys: VisitorKeys;
  services: {
    convertElementSourceSpanToLoc: typeof convertElementSourceSpanToLoc;
    convertNodeSourceSpanToLoc: typeof convertNodeSourceSpanToLoc;
  };
} {
  const angularCompilerResult = parseTemplate(code, options.filePath, {
    preserveWhitespaces: true,
    preserveLineEndings: true,
    collectCommentNodes: true,
  });

  /**
   * Before v11.2.8 (and this PR https://github.com/angular/angular/pull/41251) the @angular/compiler did not
   * expose Comment nodes on its returned AST, so we need to check they exist before attempting to transform them.
   *
   * TODO: Remove this check once the minimum supported version of Angular is v12
   */
  let ngAstCommentNodes: Comment[] = [];
  if (Array.isArray(angularCompilerResult.commentNodes)) {
    ngAstCommentNodes = angularCompilerResult.commentNodes;
  }

  const ast: AST = {
    type: 'Program',
    comments: convertNgAstCommentsToTokens(ngAstCommentNodes),
    tokens: [],
    range: [0, 0],
    loc: {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 0 },
    },
    templateNodes: angularCompilerResult.nodes,
    value: code,
  };

  // @ts-expect-error The types for ScopeManager seem to be wrong, it requires a configuration object or it will throw at runtime
  const scopeManager = new ScopeManager({});

  // @ts-expect-error Create a global scope for the ScopeManager, the types for Scope also seem to be wrong
  new Scope(scopeManager, 'module', null, ast, false);

  preprocessNode(ast);

  const startSourceSpan = getStartSourceSpanFromAST(ast);
  const endSourceSpan = getEndSourceSpanFromAST(ast);

  if (startSourceSpan && endSourceSpan) {
    ast.range = [startSourceSpan.start.offset, endSourceSpan.end.offset];
    ast.loc = {
      start: convertNodeSourceSpanToLoc(startSourceSpan).start,
      end: convertNodeSourceSpanToLoc(endSourceSpan).end,
    };
  }

  return {
    ast,
    scopeManager,
    visitorKeys: KEYS,
    services: {
      convertNodeSourceSpanToLoc,
      convertElementSourceSpanToLoc,
    },
  };
}

export { parseForESLint };

export function parse(code: string, options: { filePath: string }): AST {
  return parseForESLint(code, options).ast;
}
