// Diagram tool tests — generation, formats, URL encoding
import { describe, it, expect } from 'vitest';
import { generateDiagram } from '../src/tools/diagram.js';

describe('generateDiagram', () => {
  it('generates a plantuml flowchart from steps', () => {
    const r = generateDiagram({ type: 'flowchart', steps: ['User -> API: request', 'API -> DB: query'] });
    expect(r.error).toBeUndefined();
    const src = r.diagram || '';
    expect(src).toContain('@startuml');
    expect(src).toContain('API');
  });

  it('generates mermaid sequence diagrams', () => {
    const r = generateDiagram({ type: 'sequence', format: 'mermaid', steps: ['A -> B: hello'] });
    expect(r.error).toBeUndefined();
    const src = r.diagram || '';
    expect(src).toContain('sequenceDiagram');
  });

  it('produces a preview URL for plantuml', () => {
    const r = generateDiagram({ type: 'flowchart', steps: ['A -> B'] });
    const url = r.previewUrl || r.url || '';
    expect(url).toContain('plantuml');
  });

  it('auto-generates architecture diagram from a project', () => {
    const r = generateDiagram({ type: 'architecture', projectPath: process.cwd() });
    expect(r.error).toBeUndefined();
    const src = r.diagram || '';
    expect(src.length).toBeGreaterThan(50);
  });

  it('accepts raw content verbatim', () => {
    const r = generateDiagram({ content: '@startuml\nA -> B\n@enduml' });
    expect(r.error).toBeUndefined();
  });
});
