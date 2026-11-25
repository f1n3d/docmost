import {
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { diffWordsWithSpace } from 'diff';
import { isDeepStrictEqual } from 'node:util';
import { Document } from '@hocuspocus/server';
import { getSchema } from '@tiptap/core';
import { tiptapExtensions } from './collaboration.util';

export type YjsSelection = {
  anchor: any;
  head: any;
};

export type YjsTextReplaceResult = {
  // places where the text was found
  matches: number;
  // places that were changed: 0 when the text is missing, ambiguous or refused
  replacements: number;
  // refused: the new text would put a line break into a block that is not a code block
  addsLineBreak?: boolean;
};

type YjsTextAttributes = Record<string, any>;

// Stands in for a non-text insert, so string offsets stay equal to Yjs offsets.
const EMBED_PLACEHOLDER = '\uFFFC';

export function setYjsMark(
  doc: Document,
  fragment: Y.XmlFragment,
  yjsSelection: YjsSelection,
  markName: string,
  markAttributes: Record<string, any>,
) {
  const schema = getSchema(tiptapExtensions);
  const { mapping } = initProseMirrorDoc(fragment, schema);

  // Convert JSON positions to Y.js RelativePosition objects
  const anchorRelPos = Y.createRelativePositionFromJSON(yjsSelection.anchor);
  const headRelPos = Y.createRelativePositionFromJSON(yjsSelection.head);

  const anchor = relativePositionToAbsolutePosition(
    doc,
    fragment,
    anchorRelPos,
    mapping,
  );
  const head = relativePositionToAbsolutePosition(
    doc,
    fragment,
    headRelPos,
    mapping,
  );

  if (anchor === null || head === null) {
    throw new Error(
      'Could not resolve Y.js relative positions to absolute positions',
    );
  }

  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);

  // Apply mark directly to Y.js XmlText nodes
  // This bypasses updateYFragment which has compatibility issues
  applyMarkToYFragment(fragment, from, to, markName, markAttributes);
}

function applyMarkToYFragment(
  fragment: Y.XmlFragment,
  from: number,
  to: number,
  markName: string,
  markAttributes: Record<string, any>,
) {
  let pos = 0;

  const processItem = (item: any, parentNodeName?: string): boolean => {
    if (pos >= to) return false;

    if (item instanceof Y.XmlText) {
      const textLength = item.length;
      const itemEnd = pos + textLength;

      if (itemEnd > from && pos < to && parentNodeName !== 'codeBlock') {
        const formatFrom = Math.max(0, from - pos);
        const formatTo = Math.min(textLength, to - pos);
        const formatLength = formatTo - formatFrom;

        if (formatLength > 0) {
          item.format(formatFrom, formatLength, { [markName]: markAttributes });
        }
      }
      pos = itemEnd;
    } else if (item instanceof Y.XmlElement) {
      pos++; // Opening tag
      for (let i = 0; i < item.length; i++) {
        if (!processItem(item.get(i), item.nodeName)) return false;
      }
      pos++; // Closing tag
    }
    return true;
  };

  for (let i = 0; i < fragment.length; i++) {
    if (!processItem(fragment.get(i))) break;
  }
}

/**
 * Removes a mark from all text in the fragment that has the specified attribute value.
 * Useful for deleting comments by commentId.
 */
export function removeYjsMarkByAttribute(
  fragment: Y.XmlFragment,
  markName: string,
  attributeName: string,
  attributeValue: string,
) {
  const processItem = (item: any) => {
    if (item instanceof Y.XmlText) {
      // Get all formatting deltas to find ranges with this mark
      const deltas = item.toDelta();
      let offset = 0;

      for (const delta of deltas) {
        const length = delta.insert?.length ?? 0;
        const attributes = delta.attributes ?? {};
        const markAttr = attributes[markName];

        if (markAttr && markAttr[attributeName] === attributeValue) {
          // Remove the mark by setting it to null
          item.format(offset, length, { [markName]: null });
        }
        offset += length;
      }
    } else if (item instanceof Y.XmlElement) {
      for (let i = 0; i < item.length; i++) {
        processItem(item.get(i));
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    processItem(fragment.get(i));
  }
}

/**
 * Updates a mark's attributes for all text that has the specified attribute value.
 * Useful for resolving/unresolving comments by commentId.
 */
export function updateYjsMarkAttribute(
  fragment: Y.XmlFragment,
  markName: string,
  findByAttribute: { name: string; value: string },
  newAttributes: Record<string, any>,
) {
  const processItem = (item: any) => {
    if (item instanceof Y.XmlText) {
      const deltas = item.toDelta();
      let offset = 0;

      for (const delta of deltas) {
        const length = delta.insert?.length ?? 0;
        const attributes = delta.attributes ?? {};
        const markAttr = attributes[markName];

        if (
          markAttr &&
          markAttr[findByAttribute.name] === findByAttribute.value
        ) {
          // Update the mark with new attributes (merge with existing)
          item.format(offset, length, {
            [markName]: { ...markAttr, ...newAttributes },
          });
        }
        offset += length;
      }
    } else if (item instanceof Y.XmlElement) {
      for (let i = 0; i < item.length; i++) {
        processItem(item.get(i));
      }
    }
  };

  for (let i = 0; i < fragment.length; i++) {
    processItem(fragment.get(i));
  }
}

/**
 * Replaces text in place, so the block ids, marks and comment anchors around it are kept.
 * A match has to lie within one run of text: it cannot cross a block, a mention or a line break.
 * Nothing is changed when the text is missing, or found more than once without `replaceAll`,
 * or when the new text adds a line break outside a code block: that would fake a new block.
 */
export function replaceYjsText(
  fragment: Y.XmlFragment,
  oldText: string,
  newText: string,
  replaceAll = false,
): YjsTextReplaceResult {
  if (!oldText) return { matches: 0, replacements: 0 };

  const hits: { run: Y.XmlText[]; index: number }[] = [];
  for (const run of collectTextRuns(fragment)) {
    const value = run.map(toPlainText).join('');
    let index = value.indexOf(oldText);
    while (index !== -1) {
      hits.push({ run, index });
      index = value.indexOf(oldText, index + oldText.length);
    }
  }

  if (hits.length === 0 || (hits.length > 1 && !replaceAll)) {
    return { matches: hits.length, replacements: 0 };
  }

  // Only the words that differ are rewritten, so marks on the rest of a match survive.
  const hunks = diffHunks(oldText, newText);
  if (
    hunks.some(({ insert }) => /[\r\n]/.test(insert)) &&
    hits.some(({ run }) => !isInCodeBlock(run))
  ) {
    return { matches: hits.length, replacements: 0, addsLineBreak: true };
  }
  const nonInclusiveMarks = getNonInclusiveMarks();

  // back to front, so earlier offsets in the same run stay valid
  for (const { run, index } of hits.reverse()) {
    for (const { from, to, insert } of [...hunks].reverse()) {
      spliceTextRun(run, index + from, index + to, insert, nonInclusiveMarks);
    }
  }

  return { matches: hits.length, replacements: hits.length };
}

// Adjacent Y.XmlText siblings form one run: content added through the API has one per marked span.
function collectTextRuns(
  parent: Y.XmlFragment | Y.XmlElement,
  runs: Y.XmlText[][] = [],
): Y.XmlText[][] {
  let run: Y.XmlText[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      run.push(child);
      continue;
    }
    if (run.length) runs.push(run);
    run = [];
    if (child instanceof Y.XmlElement) collectTextRuns(child, runs);
  }
  if (run.length) runs.push(run);
  return runs;
}

function isInCodeBlock(run: Y.XmlText[]): boolean {
  const parent = run[0].parent;
  return parent instanceof Y.XmlElement && parent.nodeName === 'codeBlock';
}

function toPlainText(text: Y.XmlText): string {
  return text
    .toDelta()
    .map((op: any) =>
      typeof op.insert === 'string' ? op.insert : EMBED_PLACEHOLDER,
    )
    .join('');
}

// The changes that turn `oldText` into `newText`, as offsets into `oldText`.
function diffHunks(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string }[] {
  const hunks: { from: number; to: number; insert: string }[] = [];
  let offset = 0;
  let open = false;

  for (const part of diffWordsWithSpace(oldText, newText)) {
    if (!part.added && !part.removed) {
      offset += part.value.length;
      open = false;
      continue;
    }
    if (!open) hunks.push({ from: offset, to: offset, insert: '' });
    open = true;

    const hunk = hunks[hunks.length - 1];
    if (part.added) {
      hunk.insert += part.value;
    } else {
      hunk.to += part.value.length;
      offset += part.value.length;
    }
  }

  return hunks;
}

function getNonInclusiveMarks(): Set<string> {
  const { marks } = getSchema(tiptapExtensions);
  return new Set(
    Object.keys(marks).filter((name) => marks[name].spec.inclusive === false),
  );
}

function attributesAt(run: Y.XmlText[], index: number): YjsTextAttributes {
  let offset = 0;
  for (const text of run) {
    if (index >= offset + text.length) {
      offset += text.length;
      continue;
    }
    for (const op of text.toDelta()) {
      offset += typeof op.insert === 'string' ? op.insert.length : 1;
      if (index < offset) return op.attributes ?? {};
    }
  }
  return {};
}

function runLength(run: Y.XmlText[]): number {
  return run.reduce((length, text) => length + text.length, 0);
}

/**
 * Formatting for text inserted at `from`. Replaced text passes its formatting on.
 * Added text is formatted as if it were typed there: it takes the marks before it,
 * but does not extend a mark such as a link or a comment that ends at that position.
 */
function insertAttributes(
  run: Y.XmlText[],
  from: number,
  to: number,
  nonInclusiveMarks: Set<string>,
): YjsTextAttributes {
  if (to > from) return { ...attributesAt(run, from) };

  const before = from > 0 ? attributesAt(run, from - 1) : null;
  const after = from < runLength(run) ? attributesAt(run, from) : null;
  const main = before ?? after ?? {};
  const other = before ? after : null;

  const attributes: YjsTextAttributes = {};
  for (const [name, value] of Object.entries(main)) {
    // overlapping marks are stored as `name--hash`
    const markName = name.replace(/--[a-zA-Z0-9+/=]{8}$/, '');
    const endsHere = !other || !isDeepStrictEqual(other[name], value);
    if (nonInclusiveMarks.has(markName) && endsHere) continue;
    attributes[name] = value;
  }
  return attributes;
}

function spliceTextRun(
  run: Y.XmlText[],
  from: number,
  to: number,
  insert: string,
  nonInclusiveMarks: Set<string>,
) {
  if (from === to && !insert) return;

  const attributes = insertAttributes(run, from, to, nonInclusiveMarks);
  // the character whose Y.XmlText receives the inserted text
  const anchor = to > from ? from : Math.max(from - 1, 0);

  let start = 0;
  for (const text of run) {
    const end = start + text.length;
    const removeFrom = Math.max(from, start);
    const removeTo = Math.min(to, end);

    if (removeTo > removeFrom) {
      text.delete(removeFrom - start, removeTo - removeFrom);
    }
    if (insert && anchor >= start && anchor < end) {
      text.insert(from - start, insert, attributes);
    }
    start = end;
  }
}
