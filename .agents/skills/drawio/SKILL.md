---
name: drawio
description: Create or update native draw.io diagrams when a diagram, flowchart, architecture diagram, ER diagram, sequence diagram, class diagram, network diagram, wireframe, or .drawio file is requested.
---

# Draw.io

Generate native `.drawio` mxGraphModel XML. Do not substitute Mermaid when a native draw.io artifact is requested.

## Workflow

1. Determine the smallest diagram that communicates the requested structure.
2. Generate well-formed mxGraphModel XML.
3. Write `<descriptive-name>.drawio`.
4. If PNG/SVG/PDF export is requested and draw.io CLI exists, export with embedded diagram XML.
5. Validate the result and report only the resulting path plus blocking errors.

## Minimal XML Structure

```xml
<mxGraphModel adaptiveColors="auto">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
  </root>
</mxGraphModel>
```

All diagram elements normally use `parent="1"`.

## XML Rules

- Never emit XML comments.
- Escape attribute values: `&amp;`, `&lt;`, `&gt;`, `&quot;`.
- Every `mxCell` id must be unique.
- Every edge must contain `<mxGeometry relative="1" as="geometry" />`.
- Prefer readable spacing and avoid decorative complexity.

## Export

Typical command:

```bash
drawio -x -f png -e -b 10 -o diagram.drawio.png diagram.drawio
```

Useful executable locations:

```text
Windows: C:\Program Files\draw.io\draw.io.exe
WSL2:   /mnt/c/Program Files/draw.io/draw.io.exe
macOS:  /Applications/draw.io.app/Contents/MacOS/draw.io
Linux:  drawio
```

For PNG/SVG/PDF, use embedded XML when supported so exports remain editable in draw.io.
