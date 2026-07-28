// The one tldraw schema for this app's canvas. Built from @tldraw/tlschema only —
// no React, no DOM — so the browser client and a Durable Object hosting the sync
// room (ADR-0019) build an IDENTICAL schema from the same source.

import { createTLSchema, defaultShapeSchemas } from '@tldraw/tlschema';

import { chatShapeSchema, componentShapeSchema } from './shape-props';

export function createCanvasTLSchema() {
  return createTLSchema({
    shapes: { ...defaultShapeSchemas, component: componentShapeSchema, chat: chatShapeSchema },
  });
}
