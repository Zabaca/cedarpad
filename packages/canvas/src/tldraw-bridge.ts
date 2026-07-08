// Translation between the simplified CanvasShape model (what the agent and the
// bridge speak) and real tldraw v5 shapes. This is the ONLY place the two
// representations meet; everything else works in the simplified model.

import {
  type Editor,
  type TLArrowShape,
  type TLShape,
  getArrowBindings,
  renderPlaintextFromRichText,
  toRichText,
} from 'tldraw';

import { type CanvasShape } from './shapes';
import {
  type ArrowBindingsView,
  fromTldrawShape as pureFromTldrawShape,
  toTldrawPartial as pureToTldrawPartial,
} from './tldraw-conventions';

/**
 * Simplified -> tldraw shape partial, ready for createShapes/updateShapes. Null =
 * not representable. The assembly is the pure `toTldrawPartial` in
 * `tldraw-conventions`; this shell only injects the DOM-coupled `toRichText`.
 */
export const toTldrawPartial = (s: CanvasShape) => pureToTldrawPartial(s, toRichText);

type AnyProps = Record<string, unknown>;
const readProps = (shape: TLShape): AnyProps => (shape as unknown as { props: AnyProps }).props;

/**
 * tldraw shape -> simplified. Null = a shape type the agent doesn't model. The
 * per-type decoding is the pure `fromTldrawShape` in `tldraw-conventions`; this
 * shell only resolves the two Editor-coupled inputs it needs — the decoded
 * plaintext (`renderPlaintextFromRichText`) and, for arrows, the resolved
 * bindings (`getArrowBindings`) flattened to which terminal carries a `toId`.
 */
export function fromTldrawShape(editor: Editor, shape: TLShape): CanvasShape | null {
  const p = readProps(shape);
  const plaintext = p.richText ? renderPlaintextFromRichText(editor, p.richText as never) : '';
  let arrowBindings: ArrowBindingsView | undefined;
  if (shape.type === 'arrow') {
    const b = getArrowBindings(editor, shape as TLArrowShape);
    arrowBindings = {
      start: b.start ? { toId: b.start.toId } : undefined,
      end: b.end ? { toId: b.end.toId } : undefined,
    };
  }
  // An image's pixels live in a separate asset record; resolve the data URL so the
  // simplified model carries it (the agent can then look at it via read_image).
  let imageSrc: string | undefined;
  if (shape.type === 'image' && p.assetId) {
    const asset = editor.getAsset(p.assetId as never) as { props?: { src?: string | null } } | undefined;
    imageSrc = asset?.props?.src ?? undefined;
  }
  return pureFromTldrawShape(shape, { plaintext, arrowBindings, imageSrc });
}

/** Read the whole canvas as simplified shapes. */
export function readPage(editor: Editor): CanvasShape[] {
  return editor.getCurrentPageShapes().map((s) => fromTldrawShape(editor, s)).filter((s): s is CanvasShape => s !== null);
}
