// React-free runtime props validators for this app's two custom tldraw shapes.
//
// Why they live here and not next to the ShapeUtils: a Durable Object hosting the
// tldraw sync room validates records server-side (ADR-0019) and cannot import React
// or touch a DOM — and pulling `T` from the top-level tldraw package drags in
// @tldraw/editor and React with it. So the props are defined once, here, against
// @tldraw/validate + @tldraw/tlschema only, and BOTH sides consume them: the browser
// ShapeUtils (`static override props`) and `createCanvasTLSchema()` in ./tl-schema.
// Defining them twice would let the client and the server drift (CLAUDE.md §7).

import type { SchemaPropsInfo } from '@tldraw/tlschema';
import { T } from '@tldraw/validate';

import type { DataSource } from '../shared/data-source';

export const componentShapeProps = {
  w: T.number,
  h: T.number,
  module: T.string,
  data: T.jsonValue as T.Validator<Record<string, unknown>>,
  rev: T.number,
  dataSource: T.jsonValue as T.Validator<DataSource | null>,
};

export const chatShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  chatId: T.string,
};

export const componentShapeSchema: SchemaPropsInfo = { props: componentShapeProps };
export const chatShapeSchema: SchemaPropsInfo = { props: chatShapeProps };
