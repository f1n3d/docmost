import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { replaceYjsText } from './yjs.util';

const text = (value: string, ...marks: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks.length && { marks }),
});
const p = (id: string, ...content: unknown[]) => ({
  type: 'paragraph',
  attrs: { id },
  content,
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const bold = { type: 'bold' };
const comment = {
  type: 'comment',
  attrs: { commentId: 'c1', resolved: false },
};
const link = { type: 'link', attrs: { href: 'https://example.com' } };
const mention = {
  type: 'mention',
  attrs: { id: 'm1', label: 'Ada', entityType: 'user', entityId: 'u1' },
};

const toYdoc = (json: unknown) =>
  TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
const fragmentOf = (ydoc: Y.Doc) => ydoc.getXmlFragment('default');
const toJson = (ydoc: Y.Doc) => TiptapTransformer.fromYdoc(ydoc, 'default');

// Text nodes of a block, reduced to what the assertions look at.
const inline = (ydoc: Y.Doc, block = 0) =>
  (toJson(ydoc).content[block].content ?? []).map((node: any) => ({
    text: node.text ?? `<${node.type}>`,
    marks: (node.marks ?? []).map((mark: any) => mark.type),
  }));
const blockText = (ydoc: Y.Doc, block = 0) =>
  inline(ydoc, block)
    .map((node: { text: string }) => node.text)
    .join('');

describe('replaceYjsText', () => {
  it('replaces the text and keeps the block id', () => {
    const ydoc = toYdoc(doc(p('p1', text('A paragraph with a tpyo.'))));

    const result = replaceYjsText(fragmentOf(ydoc), 'tpyo', 'typo');

    expect(result).toEqual({ matches: 1, replacements: 1 });
    expect(blockText(ydoc)).toBe('A paragraph with a typo.');
    expect(toJson(ydoc).content[0].attrs.id).toBe('p1');
  });

  it('leaves other blocks untouched', () => {
    const ydoc = toYdoc(
      doc(p('p1', text('first')), p('p2', text('second', bold))),
    );
    const before = toJson(ydoc).content[1];

    replaceYjsText(fragmentOf(ydoc), 'first', 'changed');

    expect(toJson(ydoc).content[1]).toEqual(before);
  });

  it('finds text that spans several marks', () => {
    const ydoc = toYdoc(
      doc(p('p1', text('plain '), text('bold', bold), text(' plain'))),
    );

    const result = replaceYjsText(
      fragmentOf(ydoc),
      'plain bold plain',
      'plain bold text',
    );

    expect(result.replacements).toBe(1);
    expect(inline(ydoc)).toEqual([
      { text: 'plain ', marks: [] },
      { text: 'bold', marks: ['bold'] },
      { text: ' text', marks: [] },
    ]);
  });

  it('keeps a comment anchor between two changes in one match', () => {
    const ydoc = toYdoc(
      doc(
        p(
          'p1',
          text('This sentence '),
          text('has a comment', comment),
          text('.'),
        ),
      ),
    );

    replaceYjsText(
      fragmentOf(ydoc),
      'This sentence has a comment.',
      'That sentence has a comment!',
    );

    expect(inline(ydoc)).toEqual([
      { text: 'That sentence ', marks: [] },
      { text: 'has a comment', marks: ['comment'] },
      { text: '!', marks: [] },
    ]);
  });

  it('gives replaced text the formatting of the text it replaces', () => {
    const ydoc = toYdoc(
      doc(p('p1', text('a '), text('strong', bold), text(' word'))),
    );

    replaceYjsText(fragmentOf(ydoc), 'strong', 'bold');

    expect(inline(ydoc)).toEqual([
      { text: 'a ', marks: [] },
      { text: 'bold', marks: ['bold'] },
      { text: ' word', marks: [] },
    ]);
  });

  it('keeps a replaced word inside its link', () => {
    const ydoc = toYdoc(doc(p('p1', text('the docs', link), text(' page'))));

    replaceYjsText(fragmentOf(ydoc), 'docs', 'manual');

    expect(inline(ydoc)).toEqual([
      { text: 'the manual', marks: ['link'] },
      { text: ' page', marks: [] },
    ]);
  });

  it('formats added text as if it were typed there', () => {
    const ydoc = toYdoc(
      doc(
        p('p1', text('bold', bold), text(' end')),
        p('p2', text('link', link), text(' end')),
        p('p3', text('note', comment), text(' end')),
      ),
    );

    replaceYjsText(fragmentOf(ydoc), 'bold', 'bold!');
    replaceYjsText(fragmentOf(ydoc), 'link', 'link!');
    replaceYjsText(fragmentOf(ydoc), 'note', 'note!');

    // bold continues, a link or a comment ends where it ended before
    expect(inline(ydoc, 0)).toEqual([
      { text: 'bold!', marks: ['bold'] },
      { text: ' end', marks: [] },
    ]);
    expect(inline(ydoc, 1)).toEqual([
      { text: 'link', marks: ['link'] },
      { text: '! end', marks: [] },
    ]);
    expect(inline(ydoc, 2)).toEqual([
      { text: 'note', marks: ['comment'] },
      { text: '! end', marks: [] },
    ]);
  });

  it('removes text', () => {
    const ydoc = toYdoc(doc(p('p1', text('keep this, drop that'))));

    replaceYjsText(fragmentOf(ydoc), ', drop that', '');

    expect(blockText(ydoc)).toBe('keep this');
  });

  it('changes nothing when the text is not found', () => {
    const ydoc = toYdoc(doc(p('p1', text('hello'))));
    const before = toJson(ydoc);

    const result = replaceYjsText(fragmentOf(ydoc), 'missing', 'x');

    expect(result).toEqual({ matches: 0, replacements: 0 });
    expect(toJson(ydoc)).toEqual(before);
  });

  it('changes nothing when the text is found more than once', () => {
    const ydoc = toYdoc(doc(p('p1', text('same same')), p('p2', text('same'))));
    const before = toJson(ydoc);

    const result = replaceYjsText(fragmentOf(ydoc), 'same', 'other');

    expect(result).toEqual({ matches: 3, replacements: 0 });
    expect(toJson(ydoc)).toEqual(before);
  });

  it('replaces every match with replaceAll', () => {
    const ydoc = toYdoc(doc(p('p1', text('same same')), p('p2', text('same'))));

    const result = replaceYjsText(fragmentOf(ydoc), 'same', 'other', true);

    expect(result).toEqual({ matches: 3, replacements: 3 });
    expect(blockText(ydoc, 0)).toBe('other other');
    expect(blockText(ydoc, 1)).toBe('other');
  });

  it('does not match across blocks', () => {
    const ydoc = toYdoc(doc(p('p1', text('one')), p('p2', text('two'))));

    expect(replaceYjsText(fragmentOf(ydoc), 'onetwo', 'x').matches).toBe(0);
    expect(replaceYjsText(fragmentOf(ydoc), 'one\ntwo', 'x').matches).toBe(0);
  });

  it('does not match across a mention', () => {
    const ydoc = toYdoc(doc(p('p1', text('ask '), mention, text(' today'))));

    expect(replaceYjsText(fragmentOf(ydoc), 'ask  today', 'x').matches).toBe(0);
    expect(replaceYjsText(fragmentOf(ydoc), 'today', 'now').replacements).toBe(
      1,
    );
    expect(inline(ydoc).map((node: { text: string }) => node.text)).toEqual([
      'ask ',
      '<mention>',
      ' now',
    ]);
  });

  it('matches across the separate text nodes of appended content', () => {
    const ydoc = new Y.Doc();
    fragmentOf(ydoc).insert(0, [
      prosemirrorNodeToYElement(
        p('p1', text('plain '), text('bold', bold), text(' plain')),
      ),
    ]);

    const result = replaceYjsText(
      fragmentOf(ydoc),
      'plain bold plain',
      'plain strong text',
    );

    expect(result.replacements).toBe(1);
    expect(inline(ydoc)).toEqual([
      { text: 'plain ', marks: [] },
      { text: 'strong', marks: ['bold'] },
      { text: ' text', marks: [] },
    ]);
  });

  it('refuses a line break outside a code block', () => {
    const ydoc = toYdoc(doc(p('p1', text('last paragraph'))));
    const before = toJson(ydoc);

    const result = replaceYjsText(
      fragmentOf(ydoc),
      'last paragraph',
      'last paragraph\n\nnew paragraph',
    );

    expect(result).toEqual({
      matches: 1,
      replacements: 0,
      addsLineBreak: true,
    });
    expect(toJson(ydoc)).toEqual(before);
  });

  it('allows a line break inside a code block', () => {
    const ydoc = toYdoc(
      doc({ type: 'codeBlock', content: [text('first()\nlast()')] }),
    );

    const result = replaceYjsText(
      fragmentOf(ydoc),
      'first()',
      'first()\nsecond()',
    );

    expect(result).toEqual({ matches: 1, replacements: 1 });
    expect(blockText(ydoc)).toBe('first()\nsecond()\nlast()');
  });

  it('does not split a surrogate pair', () => {
    const ydoc = toYdoc(doc(p('p1', text('mood: 😀!'))));

    replaceYjsText(fragmentOf(ydoc), 'mood: 😀!', 'mood: 😁!');

    expect(blockText(ydoc)).toBe('mood: 😁!');
  });

  it('merges with an edit another client made at the same time', () => {
    const server = toYdoc(
      doc(p('p1', text('first paragraph')), p('p2', text('with a tpyo'))),
    );
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    const clientText = fragmentOf(client).get(0) as Y.XmlElement;
    (clientText.get(0) as Y.XmlText).insert(0, 'The ');
    replaceYjsText(fragmentOf(server), 'tpyo', 'typo');

    Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    for (const ydoc of [server, client]) {
      expect(blockText(ydoc, 0)).toBe('The first paragraph');
      expect(blockText(ydoc, 1)).toBe('with a typo');
    }
  });
});
