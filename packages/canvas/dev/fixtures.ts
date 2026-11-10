// Sample `data` for the playground, keyed by module then by fixture name.
//
// A fixture is exactly what a placed instance's `data` would be — the object the canvas
// spreads as props — so what renders here is what renders on a board. `none` is always
// offered and means "no data at all", which is the unconfigured case a component has to
// survive (and, for cards with a built-in default model, its own worked example).
//
// Only modules being actively worked on need an entry; everything else falls back to `none`.

export const FIXTURES: Record<string, Record<string, Record<string, unknown>>> = {
  IlographDiagram: {
    // The skills-chain model. Its three perspectives each touch a SLICE of a 16-resource
    // model, which is the case that exposes the orphan-node bug: `Chain order`'s relations
    // reach only 6 skills, so every doc, ADR and flag resource lands unconnected in layer 0.
    skills: {
      resources: [
        {
          id: 'skills',
          name: 'Skills',
          sub: 'the chain',
          color: '#4a9eff',
          children: [
            { id: 'setup', name: 'setup' },
            { id: 'grill', name: 'grill-with-docs' },
            { id: 'tospec', name: 'to-spec' },
            { id: 'totickets', name: 'to-tickets' },
            { id: 'implement', name: 'implement' },
            { id: 'codereview', name: 'code-review' },
            { id: 'tdd', name: 'tdd' },
            { id: 'diagnose', name: 'diagnosing-bugs' },
          ],
        },
        {
          id: 'docs',
          name: 'Config docs',
          sub: 'docs/agents/',
          color: '#fb923c',
          children: [
            { id: 'agents', name: 'AGENTS.md', sub: 'entry doc' },
            { id: 'context', name: 'CONTEXT.md', sub: 'glossary + pointers' },
            { id: 'standards', name: 'standards.md', sub: 'canonical rules' },
            { id: 'issuetracker', name: 'issue-tracker.md' },
            { id: 'testing', name: 'testing.md' },
            { id: 'delivery', name: 'delivery.md' },
            { id: 'observe', name: 'observe.md', sub: 'weakest edge' },
          ],
        },
        { id: 'adr', name: 'docs/adr/', sub: 'decisions', color: '#a78bfa' },
        { id: 'flags', name: 'packages/flags', sub: 'typed flag registry', color: '#4ade80' },
      ],
      perspectives: [
        {
          id: 'chain',
          name: 'Chain order',
          sequence: true,
          desc: 'The pipeline from setup to a reviewed commit.',
          relations: [
            { from: 'setup', to: 'grill' },
            { from: 'grill', to: 'tospec' },
            { from: 'tospec', to: 'totickets' },
            { from: 'totickets', to: 'implement' },
            { from: 'implement', to: 'codereview' },
          ],
        },
        {
          id: 'reads',
          name: 'Doc reads',
          desc: 'Which skill reads which config doc, and how strong that edge is.',
          relations: [
            { from: 'grill', to: 'delivery', label: 'pointer in CONTEXT.md' },
            { from: 'tospec', to: 'delivery', label: 'weak: synthesizes only' },
            { from: 'totickets', to: 'delivery', label: 'pointer, good' },
            { from: 'tdd', to: 'testing', label: 'every red-green cycle' },
            { from: 'implement', to: 'testing', label: 'full suite before review' },
            { from: 'codereview', to: 'standards', label: 'Standards axis discovery' },
            { from: 'diagnose', to: 'observe', label: 'no pointer today — gap' },
          ],
        },
        {
          id: 'structure',
          name: 'Doc structure',
          desc: 'AGENTS.md is the entry point; CONTEXT.md carries the pointer lines.',
          relations: [
            { from: 'agents', to: 'context' },
            { from: 'agents', to: 'standards' },
            { from: 'agents', to: 'issuetracker' },
            { from: 'context', to: 'delivery', label: 'pointer line' },
            { from: 'context', to: 'testing', label: 'pointer line' },
            { from: 'delivery', to: 'flags', label: 'declares flags' },
          ],
        },
      ],
      expanded: { skills: true, docs: true },
      perspective: 'chain',
    },
  },
};
