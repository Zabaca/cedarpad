import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

import { inChatBody, inChatLog, isInteractiveControl } from './predicates';

// A pure jsdom document for building DOM fixtures; no global registration needed
// since the predicates only call `Element.closest`.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const doc = dom.window.document;

/** Build the fixture tree from an HTML string and return the element matching `sel`. */
function el(html: string, sel: string): Element {
  const host = doc.createElement('div');
  host.innerHTML = html;
  const found = host.querySelector(sel);
  if (!found) throw new Error(`fixture has no ${sel}`);
  return found;
}

describe('isInteractiveControl', () => {
  test('true for a button (and a descendant of one)', () => {
    expect(isInteractiveControl(el('<button>Send</button>', 'button'))).toBe(true);
    expect(isInteractiveControl(el('<button><span>Send</span></button>', 'span'))).toBe(true);
  });

  test('true for input, textarea, select, anchor, label, contenteditable, role=button', () => {
    expect(isInteractiveControl(el('<input>', 'input'))).toBe(true);
    expect(isInteractiveControl(el('<textarea></textarea>', 'textarea'))).toBe(true);
    expect(isInteractiveControl(el('<select></select>', 'select'))).toBe(true);
    expect(isInteractiveControl(el('<a href="#">x</a>', 'a'))).toBe(true);
    expect(isInteractiveControl(el('<label>x</label>', 'label'))).toBe(true);
    expect(isInteractiveControl(el('<div contenteditable="true">x</div>', 'div'))).toBe(true);
    expect(isInteractiveControl(el('<div role="button">x</div>', 'div'))).toBe(true);
  });

  test('false for a plain div and for null', () => {
    expect(isInteractiveControl(el('<div>plain</div>', 'div'))).toBe(false);
    expect(isInteractiveControl(null)).toBe(false);
  });
});

describe('inChatBody', () => {
  test('true for a descendant of .chat-card-body', () => {
    expect(inChatBody(el('<div class="chat-card-body"><p>hi</p></div>', 'p'))).toBe(true);
    expect(inChatBody(el('<div class="chat-card-body"></div>', '.chat-card-body'))).toBe(true);
  });

  test('false for a plain div and for null', () => {
    expect(inChatBody(el('<div>plain</div>', 'div'))).toBe(false);
    expect(inChatBody(null)).toBe(false);
  });
});

describe('inChatLog', () => {
  test('true for a descendant of .chat-log', () => {
    expect(inChatLog(el('<div class="chat-log"><div class="bubble">hi</div></div>', '.bubble'))).toBe(true);
  });

  test('false for a chat-body element that is outside the log', () => {
    // .chat-log nests inside .chat-card-body; an element in the body but not the
    // log (e.g. the input row) is in the body yet not the log.
    const target = el('<div class="chat-card-body"><div class="chat-log"></div><form class="chat-input"></form></div>', '.chat-input');
    expect(inChatBody(target)).toBe(true);
    expect(inChatLog(target)).toBe(false);
  });

  test('false for a plain div and for null', () => {
    expect(inChatLog(el('<div>plain</div>', 'div'))).toBe(false);
    expect(inChatLog(null)).toBe(false);
  });
});
