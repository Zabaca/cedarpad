import { describe, expect, test } from 'bun:test';

import { commands } from './Kanban';

type Board = { title?: string; columns: Array<{ id: string; title: string; cards: Array<{ id: string; title: string; desc?: string }> }> };

const board = (): Board => ({
  title: 'Ops',
  columns: [
    { id: 'todo', title: 'To Do', cards: [{ id: 'c1', title: 'one' }] },
    { id: 'doing', title: 'In Progress', cards: [] },
  ],
});
const cardsIn = (b: Record<string, unknown>, col: string) => (b as Board).columns.find((c) => c.id === col)!.cards;

describe('Kanban commands', () => {
  test('addCard appends to the named column and keeps the rest of the data', () => {
    const next = commands.addCard.run(board(), { column: 'doing', title: 'two', desc: 'd' });
    expect(cardsIn(next, 'doing')).toMatchObject([{ title: 'two', desc: 'd' }]);
    expect(next.title).toBe('Ops');
  });

  test('addCard on a board placed with no columns starts from the default board', () => {
    const next = commands.addCard.run({}, { column: 'done', title: 'x' });
    expect((next as Board).columns.map((c) => c.id)).toEqual(['todo', 'doing', 'done']);
    expect(cardsIn(next, 'done')).toHaveLength(1);
  });

  test('moveCard moves a card to the end of the target column', () => {
    const next = commands.moveCard.run(board(), { card: 'c1', to: 'doing' });
    expect(cardsIn(next, 'todo')).toEqual([]);
    expect(cardsIn(next, 'doing')).toEqual([{ id: 'c1', title: 'one' }]);
  });

  test('editCard retitles; a blank title keeps the old one', () => {
    expect(cardsIn(commands.editCard.run(board(), { card: 'c1', title: ' new ' }), 'todo')[0]!.title).toBe('new');
    expect(cardsIn(commands.editCard.run(board(), { card: 'c1', title: '  ' }), 'todo')[0]!.title).toBe('one');
  });

  test('removeCard and renameBoard', () => {
    expect(cardsIn(commands.removeCard.run(board(), { card: 'c1' }), 'todo')).toEqual([]);
    expect(commands.renameBoard.run(board(), { title: 'Q3' }).title).toBe('Q3');
  });

  test('unknown cards and columns throw a message naming them', () => {
    expect(() => commands.moveCard.run(board(), { card: 'nope', to: 'doing' })).toThrow(/nope/);
    expect(() => commands.addCard.run(board(), { column: 'later', title: 'x' })).toThrow(/later.*todo, doing/);
  });

  test('the args schemas reject a malformed call', () => {
    expect(commands.addCard.args.safeParse({ column: 'todo' }).success).toBe(false);
    expect(commands.moveCard.args.safeParse({ card: 'c1', to: 'doing' }).success).toBe(true);
  });
});
